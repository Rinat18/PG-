import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  balanceEntries,
  emailOutbox,
  mockProviderPayments,
  orders,
  payments,
  productKeys,
  products,
  refunds,
  sellerProfiles,
  users,
} from "@/db/schema";
import { decrypt, encrypt, sha256 } from "@/lib/crypto";
import { createOrder, handlePaymentWebhook } from "@/lib/orders/service";
import { signMockWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/payments/mock-elqr";
import { AdminAccessError, can, type Permission } from "@/lib/admin/rbac";
import { getOrderAdmin, markOrderDelivered, refundOrder, retryRefund, searchOrders } from "@/lib/admin/orders";
import { importKeysCsv, parseKeysCsv, saveProduct, disableKey } from "@/lib/admin/catalog";
import { adjustBalance, createPayout, getBalance, listSellerBalances } from "@/lib/admin/balances";
import { getClient, listClients, setUserRole } from "@/lib/admin/clients";
import { getSettingsAdmin, saveSettings } from "@/lib/admin/settings";
import { dashboardStats, exportOrdersCsv, parsePeriod, salesReport } from "@/lib/admin/reports";
import { getSettings } from "@/lib/settings";
import { setPayoutProviderForTests } from "@/lib/payouts";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

beforeEach(async () => {
  await db.execute(sql`truncate table settings, balance_entries, payouts, deals, listings, seller_profiles, sessions, login_tokens,
    rate_limits, users, webhook_events, email_outbox, refunds, trade_offers, payments, product_keys, order_items, orders, products,
    mock_provider_payments, audit_log cascade`);
});
afterEach(() => setPayoutProviderForTests(null));

type Role = "ADMIN" | "SUPPORT" | "COMPLIANCE" | "BUYER";
async function staff(role: Role) {
  const [u] = await db.insert(users).values({ email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@test.kg`, role }).returning();
  return u;
}

async function keyProduct(keys = 2, deliveryMethod: "KEY" | "MANUAL" = "KEY") {
  const [p] = await db
    .insert(products)
    .values({
      slug: `p-${randomUUID().slice(0, 8)}`,
      type: deliveryMethod === "KEY" ? "GAME_KEY" : "DOTA_PLUS",
      game: deliveryMethod === "KEY" ? "OTHER" : "DOTA2",
      title: deliveryMethod === "KEY" ? "Игра" : "Dota Plus 1 мес.",
      deliveryMethod,
      deliveryEta: "x",
      priceMinor: 500_00,
    })
    .returning();
  for (let i = 0; i < (deliveryMethod === "KEY" ? keys : 0); i++) {
    const code = `CODE-${randomUUID()}`;
    await db.insert(productKeys).values({ productId: p.id, encryptedCode: encrypt(code), codeHash: sha256(code) });
  }
  return p;
}

async function paidOrder(slug: string, email = `buyer-${randomUUID().slice(0, 6)}@test.kg`) {
  const order = await createOrder({ productSlug: slug, email, adultConfirmed: true, offerAccepted: true });
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
  await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
  const body = JSON.stringify({
    eventId: `evt_${randomUUID()}`,
    paymentId: payment.providerPaymentId,
    status: "SUCCEEDED",
    amount: payment.amountMinor,
    currency: "KGS",
    occurredAt: new Date().toISOString(),
  });
  const ts = Math.floor(Date.now() / 1000);
  await handlePaymentWebhook(
    "mock",
    body,
    new Headers({ [SIGNATURE_HEADER]: signMockWebhook(process.env.MOCK_ELQR_WEBHOOK_SECRET!, body, ts), [TIMESTAMP_HEADER]: String(ts) }),
  );
  const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
  return o;
}

async function verifiedSeller(details = "KG12 3456 7890 Ivanov Ivan") {
  const [u] = await db.insert(users).values({ steamId: `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}` }).returning();
  await db.insert(sellerProfiles).values({
    userId: u.id,
    verificationStatus: "APPROVED",
    encryptedFullName: encrypt("Иванов Иван Иванович"),
    encryptedBirthDate: encrypt("1990-01-01"),
    encryptedPassport: encrypt("ID1234567"),
    encryptedPayoutDetails: encrypt(details),
    phone: encrypt("+996700000000"), // телефон тоже шифруется
  });
  return u;
}

// ---------- Роли ----------

describe("доступ по ролям", () => {
  it("BUYER не открывает /admin: ни одного права и отказ в каждом действии", async () => {
    const buyer = await staff("BUYER");
    expect(can(buyer, "admin.access")).toBe(false);
    const p = await keyProduct(1);
    const o = await paidOrder(p.slug);
    const calls: Promise<unknown>[] = [
      searchOrders(buyer),
      getOrderAdmin(buyer, o.id),
      refundOrder(buyer, o.id, "test"),
      markOrderDelivered(buyer, o.id, ""),
      importKeysCsv(buyer, p.id, "AAAAA-BBBBB"),
      listClients(buyer),
      getClient(buyer, buyer.id),
      adjustBalance(buyer, buyer.id, 100, "причина"),
      createPayout(buyer, buyer.id, 100),
      getSettingsAdmin(buyer),
      salesReport(buyer, parsePeriod()),
      dashboardStats(buyer),
    ];
    for (const c of calls) await expect(c).rejects.toBeInstanceOf(AdminAccessError);
    // и аноним
    await expect(searchOrders(null)).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("заблокированный админ теряет доступ", async () => {
    const admin = await staff("ADMIN");
    expect(can({ ...admin, isBlocked: true }, "admin.access")).toBe(false);
  });

  it("/admin без входа редиректит на /login", () => {
    const res = middleware(new NextRequest("http://localhost:3000/admin/orders"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("SUPPORT не видит паспортные данные и настройки; COMPLIANCE видит паспорт", async () => {
    const support = await staff("SUPPORT");
    const compliance = await staff("COMPLIANCE");
    const seller = await verifiedSeller();

    const bySupport = await getClient(support, seller.id);
    expect(bySupport?.pii).toBeNull();
    expect(bySupport?.seller?.phone).toBeNull();
    expect(bySupport?.balance).toBeNull();
    await expect(getSettingsAdmin(support)).rejects.toBeInstanceOf(AdminAccessError);
    await expect(saveSettings(support, {})).rejects.toBeInstanceOf(AdminAccessError);
    await expect(adjustBalance(support, seller.id, 100, "причина")).rejects.toBeInstanceOf(AdminAccessError);

    const byCompliance = await getClient(compliance, seller.id);
    expect(byCompliance?.pii?.passport).toBe("ID1234567");
    const viewed = await db.select().from(auditLog).where(eq(auditLog.action, "pii.viewed"));
    expect(viewed).toHaveLength(1);
    // комплаенс видит балансы, но не меняет их и не платит
    await expect(createPayout(compliance, seller.id, 100)).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("матрица прав: деньги продавцов меняет только ADMIN", () => {
    const money: Permission[] = ["balances.manage", "payouts.manage", "settings.manage", "users.roles"];
    for (const role of ["SUPPORT", "COMPLIANCE", "BUYER"] as const) {
      for (const perm of money) expect(can({ role, isBlocked: false }, perm)).toBe(false);
    }
    for (const perm of money) expect(can({ role: "ADMIN", isBlocked: false }, perm)).toBe(true);
    expect(can({ role: "ADMIN", isBlocked: false }, "pii.view")).toBe(false);
  });

  it("админ меняет роль, но не себе", async () => {
    const admin = await staff("ADMIN");
    const u = await staff("BUYER");
    await setUserRole(admin, u.id, "SUPPORT");
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].role).toBe("SUPPORT");
    await expect(setUserRole(admin, admin.id, "BUYER")).rejects.toThrow(/собственную/);
  });
});

// ---------- Возвраты ----------

describe("возвраты", () => {
  it("меняет статус заказа и платежа; повторный клик не делает второй возврат", async () => {
    const admin = await staff("ADMIN");
    const p = await keyProduct(1);
    const o = await paidOrder(p.slug);
    expect(o.status).toBe("DELIVERED");

    const first = await refundOrder(admin, o.id, "ключ не работает");
    expect(first).toMatchObject({ created: true, status: "DONE" });
    const second = await refundOrder(admin, o.id, "ключ не работает");
    expect(second.created).toBe(false);

    const [order] = await db.select().from(orders).where(eq(orders.id, o.id));
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, o.id));
    expect(order.status).toBe("REFUNDED");
    expect(payment.status).toBe("REFUNDED");
    expect(await db.select().from(refunds)).toHaveLength(1);
  });

  it("одновременные клики тоже дают один возврат", async () => {
    const admin = await staff("SUPPORT");
    const p = await keyProduct(1);
    const o = await paidOrder(p.slug);
    const res = await Promise.all([1, 2, 3].map(() => refundOrder(admin, o.id, "двойной клик")));
    expect(res.filter((r) => r.created)).toHaveLength(1);
    expect(await db.select().from(refunds)).toHaveLength(1);
  });

  it("неудавшийся возврат можно повторить", async () => {
    const admin = await staff("ADMIN");
    const p = await keyProduct(1);
    const o = await paidOrder(p.slug);
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, o.id));
    // банк временно не может вернуть
    await db.update(mockProviderPayments).set({ status: "FAILED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
    const r = await refundOrder(admin, o.id, "сбой");
    expect(r.status).toBe("FAILED");
    await expect(refundOrder(admin, o.id, "сбой")).rejects.toThrow(/Повторить/);

    await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
    const again = await retryRefund(admin, r.refundId);
    expect(again.status).toBe("DONE");
    expect(again.attempts).toBe(2);
    await expect(retryRefund(admin, r.refundId)).rejects.toThrow();
    expect((await db.select().from(orders).where(eq(orders.id, o.id)))[0].status).toBe("REFUNDED");
  });

  it("неоплаченный заказ вернуть нельзя", async () => {
    const admin = await staff("ADMIN");
    const p = await keyProduct(1);
    const order = await createOrder({ productSlug: p.slug, email: "x@test.kg", adultConfirmed: true, offerAccepted: true });
    await expect(refundOrder(admin, order.id, "причина")).rejects.toThrow();
  });
});

// ---------- Ручная выдача ----------

describe("ручная выдача", () => {
  it("Dota Plus: оператор отмечает выдачу, покупателю письмо", async () => {
    const support = await staff("SUPPORT");
    const p = await keyProduct(0, "MANUAL");
    const o = await paidOrder(p.slug, "dota@test.kg");
    expect(o.status).toBe("PAID");
    expect((await searchOrders(support, { manual: true })).map((x) => x.id)).toEqual([o.id]);

    await markOrderDelivered(support, o.id, "Активировано на аккаунт");
    const [after] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(after.status).toBe("DELIVERED");
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.to, "dota@test.kg"));
    expect(mails.some((m) => decrypt(m.encryptedBody).includes("Активировано на аккаунт"))).toBe(true);
    await expect(markOrderDelivered(support, o.id, "")).rejects.toThrow();
  });

  it("ключевой заказ вручную не отмечается", async () => {
    const admin = await staff("ADMIN");
    const p = await keyProduct(1);
    const o = await paidOrder(p.slug);
    await expect(markOrderDelivered(admin, o.id, "")).rejects.toThrow();
  });
});

// ---------- Товары и ключи ----------

describe("товары и ключи", () => {
  it("CSV: шифрование, защита от дублей, отключение ключа", async () => {
    const admin = await staff("ADMIN");
    const id = await saveProduct(admin, null, {
      slug: "new-game",
      type: "GAME_KEY",
      game: "OTHER",
      title: "New Game",
      deliveryMethod: "KEY",
      deliveryEta: "Сразу",
      priceSom: "1 290,50".replace(/\s/g, "").replace(",", "."),
      isActive: true,
    });
    const [p] = await db.select().from(products).where(eq(products.id, id));
    expect(p.priceMinor).toBe(129050);

    expect(parseKeysCsv('key\n"AAAAA-11111";comment\nBBBBB-22222\n\n')).toEqual(["AAAAA-11111", "BBBBB-22222"]);
    const r1 = await importKeysCsv(admin, id, "key\nAAAAA-11111\nBBBBB-22222\nAAAAA-11111\nbad\n");
    expect(r1).toEqual({ total: 4, added: 2, duplicates: 1, invalid: 1 });
    const r2 = await importKeysCsv(admin, id, "BBBBB-22222\nCCCCC-33333");
    expect(r2).toMatchObject({ added: 1, duplicates: 1 });

    const keys = await db.select().from(productKeys).where(eq(productKeys.productId, id));
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => !k.encryptedCode.includes("AAAAA"))).toBe(true);
    expect(keys.map((k) => decrypt(k.encryptedCode)).sort()).toEqual(["AAAAA-11111", "BBBBB-22222", "CCCCC-33333"]);

    await disableKey(admin, keys[0].id);
    await expect(disableKey(admin, keys[0].id)).rejects.toThrow();
  });

  it("занятый slug и неверная цена отклоняются", async () => {
    const admin = await staff("ADMIN");
    const base = { slug: "dup", type: "GAME_KEY", game: "OTHER", title: "Dup", deliveryMethod: "KEY", deliveryEta: "x", isActive: true } as const;
    await saveProduct(admin, null, { ...base, priceSom: "100" });
    await expect(saveProduct(admin, null, { ...base, priceSom: "100" })).rejects.toThrow(/занят/);
    await expect(saveProduct(admin, null, { ...base, slug: "dup2", priceSom: "-5" })).rejects.toThrow();
  });
});

// ---------- Балансы продавцов и выплаты ----------

describe("баланс продавца", () => {
  it("корректировки +/-, баланс не уходит в минус, причина обязательна", async () => {
    const admin = await staff("ADMIN");
    const seller = await verifiedSeller();
    expect(await adjustBalance(admin, seller.id, 1_000_00, "Начисление за сделку вне системы")).toBe(1_000_00);
    expect(await adjustBalance(admin, seller.id, -300_00, "Исправление ошибки")).toBe(700_00);
    await expect(adjustBalance(admin, seller.id, -800_00, "Слишком много")).rejects.toThrow(/отрицательным/);
    await expect(adjustBalance(admin, seller.id, 100, "")).rejects.toThrow(/причину/);
    await expect(adjustBalance(admin, seller.id, 0, "нулевая сумма")).rejects.toThrow();
    expect(await getBalance(seller.id)).toBe(700_00);
    const list = await listSellerBalances(admin);
    expect(list.find((r) => r.id === seller.id)?.balance).toBe(700_00);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "balance.adjusted"));
    expect(audits).toHaveLength(2);
  });

  it("выплата списывает баланс; больше баланса — нельзя", async () => {
    const admin = await staff("ADMIN");
    const seller = await verifiedSeller();
    await adjustBalance(admin, seller.id, 500_00, "Заработок по сделке #1");
    await expect(createPayout(admin, seller.id, 600_00)).rejects.toThrow(/больше баланса/);
    const r = await createPayout(admin, seller.id, 200_00);
    expect(r.status).toBe("SENT");
    expect(await getBalance(seller.id)).toBe(300_00);
  });

  it("без верификации выплатить нельзя", async () => {
    const admin = await staff("ADMIN");
    const [u] = await db.insert(users).values({ email: "notverified@test.kg" }).returning();
    await adjustBalance(admin, u.id, 100_00, "Тестовое начисление");
    await expect(createPayout(admin, u.id, 50_00)).rejects.toThrow(/не верифицирован/);
    await db.update(sellerProfiles).set({ verificationStatus: "PENDING" }).where(eq(sellerProfiles.userId, u.id));
    await expect(createPayout(admin, u.id, 50_00)).rejects.toThrow(/не верифицирован/);
    expect(await getBalance(u.id)).toBe(100_00);
  });

  it("сбой выплаты возвращает деньги на баланс", async () => {
    const admin = await staff("ADMIN");
    const seller = await verifiedSeller("FAIL-ACCOUNT");
    await adjustBalance(admin, seller.id, 300_00, "Заработок по сделке #2");
    const r = await createPayout(admin, seller.id, 300_00);
    expect(r.status).toBe("FAILED");
    expect(await getBalance(seller.id)).toBe(300_00);
    const kinds = (await db.select().from(balanceEntries).where(eq(balanceEntries.sellerId, seller.id))).map((e) => e.kind).sort();
    expect(kinds).toEqual(["ADJUSTMENT", "PAYOUT", "PAYOUT_REVERSAL"]);
  });

  it("параллельные выплаты не уводят баланс в минус", async () => {
    const admin = await staff("ADMIN");
    const seller = await verifiedSeller();
    await adjustBalance(admin, seller.id, 1_000_00, "Заработок по сделкам");
    setPayoutProviderForTests({
      name: "slow",
      send: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { providerPayoutId: randomUUID() };
      },
    });
    const res = await Promise.allSettled([1, 2, 3].map(() => createPayout(admin, seller.id, 400_00)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await getBalance(seller.id)).toBe(200_00);
  });

  it("суточный лимит выплат из настроек", async () => {
    const admin = await staff("ADMIN");
    const seller = await verifiedSeller();
    await adjustBalance(admin, seller.id, 1_000_00, "Заработок по сделкам");
    await saveSettings(admin, { ...(await getSettings()), sellerDailyPayoutLimitSom: 500 });
    await createPayout(admin, seller.id, 400_00);
    await expect(createPayout(admin, seller.id, 200_00)).rejects.toThrow(/суточный лимит/);
  });
});

// ---------- Настройки, клиенты, отчеты ----------

describe("настройки, клиенты, отчеты", () => {
  it("настройки меняются без деплоя и влияют на заказы", async () => {
    const admin = await staff("ADMIN");
    const changed = await saveSettings(admin, { ...(await getSettings()), maxOrdersPerHour: 1, orderTtlMinutes: 20 });
    expect(changed.sort()).toEqual(["maxOrdersPerHour", "orderTtlMinutes"]);
    await expect(saveSettings(admin, { ...(await getSettings()), orderTtlMinutes: 0 })).rejects.toThrow();

    const p = await keyProduct(3);
    const o = await createOrder({ productSlug: p.slug, email: "limit@test.kg", adultConfirmed: true, offerAccepted: true });
    expect(o.expiresAt.getTime() - o.createdAt.getTime()).toBeGreaterThan(19 * 60_000);
    await expect(
      createOrder({ productSlug: p.slug, email: "limit@test.kg", adultConfirmed: true, offerAccepted: true }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("сводка, список клиентов и отчет с CSV", async () => {
    const admin = await staff("ADMIN");
    const p = await keyProduct(3);
    await paidOrder(p.slug);
    const o2 = await paidOrder(p.slug);
    await refundOrder(admin, o2.id, "возврат для отчета");

    const s = await dashboardStats(admin);
    expect(s.clients).toBe(1);
    expect(s.orders_day).toBe(2);

    const clients = await listClients(admin);
    expect(clients).toHaveLength(1);

    const r = await salesReport(admin, parsePeriod());
    expect(r.totals).toMatchObject({ orders: 2, revenue: 1_000_00, refunds: 1, refundedMinor: 500_00, net: 500_00 });
    const csv = await exportOrdersCsv(admin, parsePeriod());
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(csv).toContain("500.00");
  });
});
