import Link from "next/link";
import { ProductGrid } from "@/components/ProductCard";
import { listProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [subs, popular, fresh] = await Promise.all([
    Promise.all([listProducts({ type: "CS2_PRIME" }, 4), listProducts({ type: "DOTA_PLUS" }, 4)]).then((r) => r.flat()),
    listProducts({ sort: "popular" }, 8),
    listProducts({ sort: "new" }, 4),
  ]);

  return (
    <div className="space-y-12">
      <section className="card relative overflow-hidden p-8 sm:p-12">
        <div className="absolute inset-0 bg-gradient-to-br from-accent/15 via-transparent to-red-600/10" />
        <div className="relative max-w-2xl space-y-4">
          <h1 className="text-3xl font-black leading-tight sm:text-4xl">
            Ключи, Prime, Dota Plus и скины CS2 и Dota 2
          </h1>
          <p className="text-muted">
            Вы заранее видите, что получите: конкретный ключ, подписку или скин с float и паттерном. Оплата по QR ELQR из
            приложения любого банка Кыргызстана, цены в сомах.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/catalog/cs2" className="btn-primary">Каталог CS2</Link>
            <Link href="/catalog/dota2" className="btn-ghost">Каталог Dota 2</Link>
            <Link href="/catalog/other" className="btn-ghost">Ключи игр</Link>
          </div>
        </div>
      </section>

      <Section title="Prime и Dota Plus" href="/catalog/cs2?type=CS2_PRIME">
        <ProductGrid items={subs} />
      </Section>
      <Section title="Популярное">
        <ProductGrid items={popular} />
      </Section>
      <Section title="Новинки">
        <ProductGrid items={fresh} />
      </Section>
    </div>
  );
}

function Section({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-bold">{title}</h2>
        {href && (
          <Link href={href} className="text-sm text-muted hover:text-accent">
            Все →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
