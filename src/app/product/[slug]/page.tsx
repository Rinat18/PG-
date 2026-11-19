import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductArt } from "@/components/ProductCard";
import { getProduct } from "@/lib/catalog";
import { formatKgs, gameLabel, productTypeLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const deliveryText: Record<string, string> = {
  KEY: "Ключ на экране сразу после оплаты, копия в письме",
  STEAM_GIFT: "Подарок Steam на ваш аккаунт",
  TRADE_OFFER: "Трейд-оффер Steam от бота магазина на вашу trade-ссылку",
  MANUAL: "Активирует оператор, статус виден на странице заказа",
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = await getProduct((await params).slug);
  return { title: p?.title ?? "Товар" };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = await getProduct((await params).slug);
  if (!p) notFound();
  const unavailable = p.stock === 0 || p.isReserved || Boolean(p.soldAt);
  const isSkin = p.type === "SHOP_SKIN";

  const specs: [string, string | undefined][] = isSkin
    ? [
        ["Игра", gameLabel[p.game]],
        ["Оружие / герой", p.skin?.weaponOrHero],
        ["Качество", p.skin?.exterior],
        ["Редкость", p.skin?.rarity],
        ["Float", p.skin?.float?.toFixed(6)],
        ["Паттерн", p.skin?.pattern?.toString()],
        ["StatTrak™", p.skin?.statTrak ? "Да" : p.game === "CS2" ? "Нет" : undefined],
        ["Наклейки", p.skin?.stickers?.length ? p.skin.stickers.map((s) => s.name).join(", ") : undefined],
        ["Продавец", "Магазин"],
      ]
    : [
        ["Игра", gameLabel[p.game]],
        ["Тип", productTypeLabel[p.type]],
        ["Платформа", p.platform],
        ["Регион активации", p.region ?? undefined],
        ["Срок подписки", p.durationMonths ? `${p.durationMonths} мес.` : undefined],
      ];

  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
      <ProductArt game={p.game} type={p.type} big />
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="text-xs text-muted">{productTypeLabel[p.type]}</div>
          <h1 className="text-2xl font-bold leading-tight">{p.title}</h1>
          <p className="text-sm text-muted">{p.description}</p>
        </div>

        <dl className="card divide-y divide-line text-sm">
          {specs
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
        </dl>

        <div className="card space-y-4 p-4">
          <div className="flex items-end justify-between">
            <div className="text-3xl font-black">{formatKgs(p.priceMinor)}</div>
            {p.stock !== null && p.stock > 0 && !isSkin && <div className="text-xs text-ok">В наличии</div>}
          </div>
          <div className="space-y-1 text-sm">
            <div><span className="text-muted">Как выдается: </span>{deliveryText[p.deliveryMethod]}</div>
            <div><span className="text-muted">Срок: </span>{p.deliveryEta}</div>
          </div>
          {unavailable ? (
            <button disabled className="btn-primary w-full">{p.isReserved ? "Сейчас оплачивается другим покупателем" : "Нет в наличии"}</button>
          ) : isSkin ? (
            <div className="space-y-2">
              <button disabled className="btn-primary w-full">Войти через Steam, чтобы купить</button>
              <p className="text-xs text-muted">Вход через Steam подключаем следующим шагом.</p>
            </div>
          ) : (
            <Link href={`/checkout/${p.slug}`} className="btn-primary w-full">Купить</Link>
          )}
          <p className="text-xs text-muted">Оплата по QR ELQR. Товар выдается только после подтверждения оплаты банком.</p>
        </div>

        {p.activationInstructions && (
          <div className="space-y-1 text-sm">
            <div className="font-semibold">Инструкция по активации</div>
            <p className="text-muted">{p.activationInstructions}</p>
          </div>
        )}
      </div>
    </div>
  );
}
