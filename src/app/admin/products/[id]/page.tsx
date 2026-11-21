import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductAdmin, listKeys } from "@/lib/admin/catalog";
import { requireAdminPage } from "@/lib/admin/page";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import { disableKeyAction, importKeysAction } from "../../actions";
import { ProductForm } from "../ProductForm";

export default async function EditProduct({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireAdminPage("products.manage", `/admin/products/${id}`);
  const row = await getProductAdmin(user, id);
  if (!row) notFound();
  const p = row.product;
  const keys = p.deliveryMethod === "KEY" ? await listKeys(user, p.id) : [];
  return (
    <>
      <Link href="/admin/products" className="text-sm text-muted hover:text-text">← Товары</Link>
      <PageHead title={p.title}><Link href={`/product/${p.slug}`} className="btn-ghost" target="_blank">На сайте</Link></PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <ProductForm p={p} />

      {p.deliveryMethod === "KEY" && (
        <section className="space-y-3">
          <h2 className="font-bold">Ключи: {row.available} свободно · {row.reserved} в резерве · {row.issued} выдано · {row.disabled} отключено</h2>
          <form action={importKeysAction} className="card space-y-2 p-4 text-sm">
            <input type="hidden" name="productId" value={p.id} />
            <div className="text-muted">CSV: один ключ в строке (первая колонка). Ключи шифруются, дубли — в том числе из прошлых загрузок — пропускаются.</div>
            <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" className="text-sm" />
            <textarea name="csv" rows={4} className="input font-mono" placeholder="или вставьте ключи сюда, по одному в строке" />
            <button className="btn-primary">Загрузить ключи</button>
          </form>
          <Table head={["Добавлен", "Хэш", "Статус", "Выдан", ""]} empty={!keys.length}>
            {keys.map((k) => (
              <tr key={k.id}>
                <td className={`${td} text-xs`}>{fmtDate(k.createdAt)}</td>
                <td className={`${td} font-mono text-xs text-muted`}>{k.hashPrefix}…</td>
                <td className={td}>{k.status}</td>
                <td className={`${td} text-xs`}>{fmtDate(k.issuedAt)}</td>
                <td className={td}>
                  {k.status === "AVAILABLE" && (
                    <form action={disableKeyAction}>
                      <input type="hidden" name="productId" value={p.id} />
                      <input type="hidden" name="keyId" value={k.id} />
                      <button className="btn-ghost py-1">Отключить</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </>
  );
}
