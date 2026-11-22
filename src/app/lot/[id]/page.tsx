import Link from "next/link";
import { notFound } from "next/navigation";
import { getListingPublic } from "@/lib/p2p/seller";
import { getCurrentUser } from "@/lib/auth/current";
import { formatKgs, gameLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const v = await getListingPublic((await params).id);
  return { title: v?.listing.title ?? "Лот" };
}

export default async function LotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await getListingPublic(id);
  if (!v) notFound();
  const { listing: l, seller, stats } = v;
  const user = await getCurrentUser();
  const own = user?.id === seller.id;

  const specs: [string, string | undefined][] = [
    ["Игра", gameLabel[l.game]],
    ["Оружие / герой", l.skin.weaponOrHero],
    ["Качество", l.skin.exterior],
    ["Редкость", l.skin.rarity],
    ["Float", l.skin.float?.toFixed(6)],
    ["Паттерн", l.skin.pattern?.toString()],
    ["StatTrak™", l.skin.statTrak ? "Да" : l.game === "CS2" ? "Нет" : undefined],
    ["Наклейки", l.skin.stickers?.length ? l.skin.stickers.map((s) => s.name).join(", ") : undefined],
    ["Продавец", `${seller.name} (пользователь)`],
    [
      "Рейтинг продавца",
      stats.ratingPercent === null ? "Новый продавец" : `${stats.ratingPercent}% успешных · ${stats.completed} сделок`,
    ],
  ];

  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
      <div className="card grid aspect-[4/3] place-items-center overflow-hidden">
        {l.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.imageUrl} alt={l.title} className="h-full w-full object-contain p-6" />
        ) : (
          <span className="text-5xl font-black text-text/80">{gameLabel[l.game]}</span>
        )}
      </div>
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="text-xs text-muted">Лот продавца · P2P-маркет</div>
          <h1 className="text-2xl font-bold leading-tight">{l.title}</h1>
        </div>
        <dl className="card divide-y divide-line text-sm">
          {specs
            .filter(([, val]) => val)
            .map(([k, val]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right font-medium">{val}</dd>
              </div>
            ))}
        </dl>
        <div className="card space-y-4 p-4">
          <div className="text-3xl font-black">{formatKgs(l.priceMinor)}</div>
          <div className="space-y-1 text-sm">
            <div><span className="text-muted">Как выдается: </span>трейд-оффер Steam от продавца на вашу trade-ссылку, получение проверяет сайт</div>
            <div><span className="text-muted">Срок: </span>до {v.transferHours} часов после оплаты</div>
          </div>
          {!v.available ? (
            <button disabled className="btn-primary w-full">{l.status === "RESERVED" ? "Сейчас оплачивается другим покупателем" : "Лот снят с продажи"}</button>
          ) : own ? (
            <Link href="/sell" className="btn-ghost w-full">Это ваш лот</Link>
          ) : !user?.steamId ? (
            <a href={`/api/auth/steam?next=${encodeURIComponent(`/checkout/lot/${l.id}`)}`} className="btn-primary w-full">Войти через Steam, чтобы купить</a>
          ) : (
            <Link href={`/checkout/lot/${l.id}`} className="btn-primary w-full">Купить</Link>
          )}
          <p className="text-xs text-muted">
            Деньги получает продавец только после того, как скин придет к вам и закончится срок защиты Steam от отката. Не передал
            вовремя — полный возврат.
          </p>
        </div>
      </div>
    </div>
  );
}
