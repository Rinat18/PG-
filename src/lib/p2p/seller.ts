import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deals, listings, orders, payouts, sellerProfiles, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { decrypt, encrypt } from "@/lib/crypto";
import { writeAudit } from "@/lib/audit";
import { APP_ID, isSellable, isContainer, parseSkin, type SkinGame } from "@/lib/bots/inventory";
import { getBalance } from "@/lib/admin/balances";
import { getSettings } from "@/lib/settings";
import { actorOf, assertCan } from "@/lib/admin/rbac";
import { saveDocument } from "./files";
import { payoutDetailsHash, recordFingerprint, usersWithSamePayout } from "./fingerprints";
import { getInventoryApi } from "./inventory";
import { getMarketPrice, priceDeviationPercent } from "./market-price";

/**
 * P2P-маркет, сторона продавца (ТЗ 5.1): верификация, выставление лотов из инвентаря Steam.
 * Выставлять лоты можно без верификации, получить выплату — только после нее.
 */

export class SellerError extends Error {}

// ---------- Верификация ----------

const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase().replace(/ё/g, "е");

export const verificationSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, " "))
      .refine((s) => /^[A-Za-zА-Яа-яЁёӨөҮүҢң'-]{2,}( [A-Za-zА-Яа-яЁёӨөҮүҢң'-]{2,}){1,3}$/.test(s), "ФИО как в паспорте: фамилия, имя и отчество"),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата рождения в формате ГГГГ-ММ-ДД"),
    passport: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}\d{7}$/, "Номер паспорта КР: две буквы и 7 цифр, например ID1234567"),
    phone: z
      .string()
      .transform((s) => s.replace(/[\s()-]/g, ""))
      .refine((s) => /^\+996\d{9}$/.test(s), "Телефон в формате +996 XXX XXX XXX"),
    payoutDetails: z
      .string()
      .trim()
      .regex(/^[\w\s+-]{8,64}$/, "Номер счета, карты или кошелька — от 8 до 64 символов"),
    payoutHolder: z.string().trim(),
    adult: z.boolean().refine((v) => v, "Продавать могут только лица старше 18 лет"),
    sellerOffer: z.boolean().refine((v) => v, "Нужно согласие с офертой для продавцов"),
  })
  .refine((d) => normName(d.payoutHolder) === normName(d.fullName), {
    message: "Выплата возможна только на счет самого продавца: владелец реквизитов должен совпадать с ФИО",
    path: ["payoutHolder"],
  })
  .refine((d) => ageYears(d.birthDate) !== null && ageYears(d.birthDate)! >= 18 && ageYears(d.birthDate)! < 110, {
    message: "Продавать могут только лица старше 18 лет",
    path: ["birthDate"],
  });
export type VerificationInput = z.input<typeof verificationSchema>;

export function ageYears(isoDate: string, now = new Date()): number | null {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== isoDate) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/** Заявка продавца. Персональные данные шифруются, фото — в приватном хранилище, тоже зашифрованы. */
export async function submitVerification(
  user: SessionUser,
  input: VerificationInput,
  files: { passport: Buffer | null; selfie: Buffer | null },
) {
  if (user.isBlocked) throw new SellerError("Аккаунт заблокирован");
  const parsed = verificationSchema.safeParse(input);
  if (!parsed.success) throw new SellerError(parsed.error.issues[0]?.message ?? "Проверьте форму");
  if (!files.passport?.length || !files.selfie?.length) throw new SellerError("Загрузите фото паспорта и селфи с паспортом");
  const d = parsed.data;

  const [current] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, user.id));
  if (current && (current.verificationStatus === "PENDING" || current.verificationStatus === "APPROVED")) {
    throw new SellerError(current.verificationStatus === "PENDING" ? "Заявка уже на проверке" : "Вы уже верифицированы");
  }

  let passportKey: string, selfieKey: string;
  try {
    passportKey = await saveDocument(user.id, "passport", files.passport);
    selfieKey = await saveDocument(user.id, "selfie", files.selfie);
  } catch (e) {
    throw new SellerError((e as Error).message);
  }

  const values = {
    verificationStatus: "PENDING" as const,
    encryptedFullName: encrypt(d.fullName),
    encryptedBirthDate: encrypt(d.birthDate),
    encryptedPassport: encrypt(d.passport),
    phone: encrypt(d.phone),
    encryptedPayoutDetails: encrypt(d.payoutDetails),
    payoutDetailsHash: payoutDetailsHash(d.payoutDetails),
    passportPhotoKey: passportKey,
    selfiePhotoKey: selfieKey,
    submittedAt: new Date(),
    rejectionReason: null,
    sellerOfferAcceptedAt: current?.sellerOfferAcceptedAt ?? new Date(),
  };
  await db
    .insert(sellerProfiles)
    .values({ userId: user.id, ...values })
    .onConflictDoUpdate({ target: sellerProfiles.userId, set: values });
  await writeAudit(`user:${user.id}`, "seller.verification_submitted", "user", user.id);
}

/** Очередь верификации для комплаенса. */
export async function listVerifications(actor: SessionUser | null) {
  assertCan(actor, "verification.manage");
  const rows = await db
    .select({ profile: sellerProfiles, user: users })
    .from(sellerProfiles)
    .innerJoin(users, eq(users.id, sellerProfiles.userId))
    .where(sql`${sellerProfiles.submittedAt} is not null`)
    .orderBy(sql`case when ${sellerProfiles.verificationStatus} = 'PENDING' then 0 else 1 end`, desc(sellerProfiles.submittedAt))
    .limit(300);
  return rows.map(({ profile, user }) => ({
    userId: user.id,
    displayName: user.displayName,
    steamId: user.steamId,
    email: user.email,
    status: profile.verificationStatus,
    submittedAt: profile.submittedAt,
    verifiedAt: profile.verifiedAt,
    rejectionReason: profile.rejectionReason,
  }));
}

/** Карточка заявки с расшифрованными данными. Только комплаенс, каждый просмотр — в журнал. */
export async function getVerification(actor: SessionUser | null, userId: string) {
  assertCan(actor, "verification.manage");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [row] = await db
    .select({ profile: sellerProfiles, user: users })
    .from(sellerProfiles)
    .innerJoin(users, eq(users.id, sellerProfiles.userId))
    .where(eq(sellerProfiles.userId, userId));
  if (!row?.profile.submittedAt) return null;
  const d = (v: string | null) => (v ? decrypt(v) : null);
  const p = row.profile;
  await writeAudit(actorOf(actor), "pii.viewed", "user", userId, { screen: "verification" });
  const birthDate = d(p.encryptedBirthDate);
  return {
    user: row.user,
    status: p.verificationStatus,
    submittedAt: p.submittedAt,
    verifiedAt: p.verifiedAt,
    reviewedBy: p.reviewedBy,
    rejectionReason: p.rejectionReason,
    fullName: d(p.encryptedFullName),
    birthDate,
    age: birthDate ? ageYears(birthDate) : null,
    passport: d(p.encryptedPassport),
    phone: d(p.phone),
    payoutDetails: d(p.encryptedPayoutDetails),
    hasPassportPhoto: Boolean(p.passportPhotoKey),
    hasSelfie: Boolean(p.selfiePhotoKey),
    samePayoutUsers: p.payoutDetailsHash ? await usersWithSamePayout(userId, p.payoutDetailsHash) : [],
  };
}

export async function getVerificationFileKey(actor: SessionUser | null, userId: string, kind: "passport" | "selfie") {
  assertCan(actor, "verification.manage");
  const [p] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId));
  const key = kind === "passport" ? p?.passportPhotoKey : p?.selfiePhotoKey;
  if (key) await writeAudit(actorOf(actor), "pii.file_viewed", "user", userId, { kind });
  return key ?? null;
}

export async function reviewVerification(actor: SessionUser | null, userId: string, approve: boolean, reason?: string) {
  assertCan(actor, "verification.manage");
  const why = reason?.trim() ?? "";
  if (!approve && why.length < 5) throw new SellerError("Укажите причину отказа (минимум 5 символов)");
  const updated = await db
    .update(sellerProfiles)
    .set(
      approve
        ? { verificationStatus: "APPROVED", verifiedAt: new Date(), rejectionReason: null, reviewedBy: actorOf(actor) }
        : { verificationStatus: "REJECTED", rejectionReason: why, reviewedBy: actorOf(actor) },
    )
    .where(and(eq(sellerProfiles.userId, userId), eq(sellerProfiles.verificationStatus, "PENDING")))
    .returning({ id: sellerProfiles.userId });
  if (!updated.length) throw new SellerError("Заявка уже рассмотрена");
  await writeAudit(actorOf(actor), approve ? "seller.verified" : "seller.rejected", "user", userId, approve ? {} : { reason: why });
}

// ---------- Лоты ----------

export type SellableItem = {
  assetId: string;
  title: string;
  imageUrl: string | null;
  exterior?: string;
  statTrak?: boolean;
  listed: boolean;
};

/** Предметы инвентаря продавца, которые можно выставить (контейнеры и непередаваемые отсечены). */
export async function listSellableInventory(user: SessionUser, game: SkinGame) {
  if (!user.steamId) throw new SellerError("Продавать можно только со входом через Steam");
  const items = await getInventoryApi().getInventory(user.steamId, APP_ID[game]);
  if (!items) throw new SellerError("Steam не отдал инвентарь: проверьте, что он открыт, и повторите через минуту");
  const live = await db
    .select({ assetId: listings.assetId })
    .from(listings)
    .where(and(eq(listings.sellerId, user.id), eq(listings.game, game), inArray(listings.status, ["ACTIVE", "RESERVED"])));
  const liveIds = new Set(live.map((l) => l.assetId));
  const hidden = { containers: 0, untradable: 0 };
  const result: SellableItem[] = [];
  for (const item of items) {
    if (isContainer(item)) {
      hidden.containers++;
      continue;
    }
    if (!isSellable(item)) {
      hidden.untradable++;
      continue;
    }
    const p = parseSkin(item);
    result.push({ assetId: item.assetid, title: p.title, imageUrl: p.imageUrl, exterior: p.skin.exterior, statTrak: p.skin.statTrak, listed: liveIds.has(item.assetid) });
  }
  return { items: result, hidden };
}

export const listingSchema = z.object({
  game: z.enum(["CS2", "DOTA2"]),
  assetId: z.string().regex(/^\d{1,20}$/, "Неизвестный предмет"),
  priceSom: z.coerce.number().int("Цена в целых сомах").min(10, "Минимальная цена 10 сом").max(10_000_000, "Слишком большая цена"),
  sellerOffer: z.boolean().refine((v) => v, "Нужно согласие с офертой для продавцов"),
});

export async function createListing(user: SessionUser, input: z.input<typeof listingSchema>, fp: { ip?: string; deviceId?: string } = {}) {
  if (!user.steamId) throw new SellerError("Продавать можно только со входом через Steam");
  if (user.isBlocked) throw new SellerError("Аккаунт заблокирован");
  const parsed = listingSchema.safeParse(input);
  if (!parsed.success) throw new SellerError(parsed.error.issues[0]?.message ?? "Проверьте форму");
  const { game, assetId, priceSom } = parsed.data;

  // Предмет берем из инвентаря заново, а не из формы: название и атрибуты подменить нельзя
  const items = await getInventoryApi().getInventory(user.steamId, APP_ID[game]);
  if (!items) throw new SellerError("Steam не отдал инвентарь: проверьте, что он открыт, и повторите через минуту");
  const item = items.find((i) => i.assetid === assetId);
  if (!item) throw new SellerError("Предмета нет в вашем инвентаре");
  if (isContainer(item)) throw new SellerError("Кейсы, ключи от кейсов, капсулы и другие контейнеры выставлять нельзя");
  if (!isSellable(item)) throw new SellerError("Предмет сейчас нельзя передать в Steam");

  const parsedSkin = parseSkin(item);
  const priceMinor = priceSom * 100;
  const marketPriceMinor = await getMarketPrice(game, parsedSkin.skin.marketHashName);

  await db.insert(sellerProfiles).values({ userId: user.id, sellerOfferAcceptedAt: new Date() }).onConflictDoNothing();
  await db
    .update(sellerProfiles)
    .set({ sellerOfferAcceptedAt: sql`coalesce(${sellerProfiles.sellerOfferAcceptedAt}, now())` })
    .where(eq(sellerProfiles.userId, user.id));

  let listing: typeof listings.$inferSelect;
  try {
    [listing] = await db
      .insert(listings)
      .values({
        sellerId: user.id,
        game,
        title: parsedSkin.title,
        assetId,
        skin: { ...parsedSkin.skin, instanceId: item.instanceid },
        imageUrl: parsedSkin.imageUrl,
        priceMinor,
        marketPriceMinor,
      })
      .returning();
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "23505") throw new SellerError("Этот предмет уже выставлен");
    throw e;
  }
  await recordFingerprint(user.id, fp);
  await writeAudit(`user:${user.id}`, "listing.created", "listing", listing.id, { priceMinor, marketPriceMinor });

  const cfg = await getSettings();
  const deviation = priceDeviationPercent(priceMinor, marketPriceMinor);
  return {
    listing,
    deviation,
    warning:
      deviation === null
        ? "Не нашли рыночную цену предмета: покупка пройдет ручную проверку, это может задержать сделку"
        : deviation > cfg.p2pMaxPriceDeviationPercent
          ? `Цена отличается от рыночной на ${deviation}%: покупка пройдет ручную проверку, это может задержать сделку`
          : null,
  };
}

export async function withdrawListing(user: SessionUser, listingId: string) {
  const res = await db
    .update(listings)
    .set({ status: "WITHDRAWN" })
    .where(and(eq(listings.id, listingId), eq(listings.sellerId, user.id), eq(listings.status, "ACTIVE")))
    .returning({ id: listings.id });
  if (!res.length) throw new SellerError("Лот уже продан, оплачивается или снят");
  await writeAudit(`user:${user.id}`, "listing.withdrawn", "listing", listingId);
}

// ---------- Витрина ----------

export type SellerStats = { completed: number; failed: number; ratingPercent: number | null };

export async function sellerStats(sellerIds: string[]): Promise<Map<string, SellerStats>> {
  const map = new Map<string, SellerStats>();
  if (!sellerIds.length) return map;
  const rows = await db
    .select({
      sellerId: deals.sellerId,
      completed: sql<number>`count(*) filter (where ${deals.transferredAt} is not null)::int`,
      failed: sql<number>`count(*) filter (where ${deals.cancelReason} in ('not_transferred', 'seller_declined'))::int`,
    })
    .from(deals)
    .where(inArray(deals.sellerId, sellerIds))
    .groupBy(deals.sellerId);
  for (const id of sellerIds) map.set(id, { completed: 0, failed: 0, ratingPercent: null });
  for (const r of rows) {
    const total = Number(r.completed) + Number(r.failed);
    map.set(r.sellerId, { completed: Number(r.completed), failed: Number(r.failed), ratingPercent: total ? Math.round((Number(r.completed) / total) * 100) : null });
  }
  return map;
}

export type ListingFilters = { game?: SkinGame; q?: string; priceFrom?: number; priceTo?: number; exterior?: string; statTrak?: boolean; sort?: string };

/** Активные лоты для каталога. Лоты заблокированных продавцов не показываются. */
export async function listActiveListings(f: ListingFilters = {}, limit = 48) {
  const where = [eq(listings.status, "ACTIVE"), eq(users.isBlocked, false)];
  if (f.game) where.push(eq(listings.game, f.game));
  if (f.q) where.push(sql`${listings.title} ilike ${`%${f.q.replace(/[%_]/g, "")}%`}`);
  if (f.priceFrom !== undefined) where.push(sql`${listings.priceMinor} >= ${f.priceFrom * 100}`);
  if (f.priceTo !== undefined) where.push(sql`${listings.priceMinor} <= ${f.priceTo * 100}`);
  if (f.exterior) where.push(sql`${listings.skin}->>'exterior' = ${f.exterior}`);
  if (f.statTrak) where.push(sql`(${listings.skin}->>'statTrak')::boolean = true`);
  const order =
    f.sort === "price_asc" ? sql`${listings.priceMinor} asc` : f.sort === "price_desc" ? sql`${listings.priceMinor} desc` : sql`${listings.createdAt} desc`;
  const rows = await db
    .select({ listing: listings, sellerName: users.displayName })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .where(and(...where))
    .orderBy(order)
    .limit(limit);
  return rows.map((r) => ({ ...r.listing, sellerName: r.sellerName }));
}

export async function getListingPublic(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ listing: listings, seller: users })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .where(eq(listings.id, id));
  if (!row) return null;
  const stats = (await sellerStats([row.seller.id])).get(row.seller.id)!;
  const cfg = await getSettings();
  return {
    listing: row.listing,
    seller: { id: row.seller.id, name: row.seller.displayName ?? "Продавец", blocked: row.seller.isBlocked, since: row.seller.createdAt },
    stats,
    transferHours: cfg.p2pTransferHours,
    available: row.listing.status === "ACTIVE" && !row.seller.isBlocked,
  };
}

// ---------- Кабинет продавца ----------

export async function getSellerCabinet(user: SessionUser) {
  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, user.id));
  const myListings = await db.select().from(listings).where(eq(listings.sellerId, user.id)).orderBy(desc(listings.createdAt)).limit(200);
  const myDeals = await db
    .select({ deal: deals, listing: listings, orderNumber: orders.number })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .innerJoin(orders, eq(orders.id, deals.orderId))
    .where(eq(deals.sellerId, user.id))
    .orderBy(desc(deals.createdAt))
    .limit(200);
  const myPayouts = await db.select().from(payouts).where(eq(payouts.sellerId, user.id)).orderBy(desc(payouts.createdAt)).limit(100);
  const pendingEarnings = myDeals
    .filter((d) => ["AWAITING_TRANSFER", "PROTECTION", "REVIEW", "DISPUTE"].includes(d.deal.status) && !d.deal.earningCreditedAt)
    .reduce((s, d) => s + d.deal.priceMinor - d.deal.commissionMinor, 0);
  const cfg = await getSettings();
  return {
    profile: profile
      ? {
          status: profile.verificationStatus,
          rejectionReason: profile.rejectionReason,
          submittedAt: profile.submittedAt,
          payoutMasked: profile.encryptedPayoutDetails ? mask(decrypt(profile.encryptedPayoutDetails)) : null,
        }
      : null,
    listings: myListings,
    deals: myDeals,
    payouts: myPayouts,
    balance: await getBalance(user.id),
    pendingEarnings,
    settings: { commission: cfg.p2pCommissionPercent, transferHours: cfg.p2pTransferHours, protectionDays: cfg.p2pProtectionDays },
  };
}

const mask = (s: string) => `•••• ${s.replace(/\s/g, "").slice(-4)}`;
