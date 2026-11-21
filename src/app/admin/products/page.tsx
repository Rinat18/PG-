import Link from "next/link";
import { listProductsAdmin } from "@/lib/admin/catalog";
import { requireAdminPage } from "@/lib/admin/page";
import { formatKgs, gameLabel, productTypeLabel } from "@/lib/format";
import { Flash, PageHead, Table, td } from "@/components/admin/ui";
import { toggleProductAction } from "../actions";

export default async function AdminProducts({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("products.manage", "/admin/products");
  const rows = await listProductsAdmin(user);
  return (
    <>
      <PageHead title="Товары и ключи"><Link href="/admin/products/new" className="btn-primary">Добавить товар</Link></PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <Table head={["Товар", "Тип", "Цена", "Остаток ключей", "Выдача", "Каталог"]} empty={!rows.length}>
        {rows.map(({ product: p, available, issued, reserved }) => (
          <tr key={p.id} className={p.isActive ? "" : "opacity-60"}>
            <td className={td}><Link href={`/admin/products/${p.id}`} className="text-accent underline">{p.title}</Link><div className="text-xs text-muted">{gameLabel[p.game]} · {p.slug}</div></td>
            <td className={td}>{productTypeLabel[p.type]}</td>
            <td className={`${td} whitespace-nowrap`}>{formatKgs(p.priceMinor)}</td>
            <td className={td}>
              {p.deliveryMethod === "KEY" ? (
                <span className={available === 0 ? "font-semibold text-bad" : ""}>{available} своб. · {reserved} в резерве · {issued} выдано</span>
              ) : p.type === "SHOP_SKIN" ? (p.soldAt ? "продан" : p.reservedByOrderId ? "в резерве" : "в наличии") : "—"}
            </td>
            <td className={`${td} text-xs`}>{p.deliveryEta}</td>
            <td className={td}>
              <form action={toggleProductAction}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="show" value={p.isActive ? "0" : "1"} />
                <button className="btn-ghost py-1">{p.isActive ? "Скрыть" : "Показать"}</button>
              </form>
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
