import Link from "next/link";
import { ConfirmLogin } from "./ConfirmLogin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Вход по ссылке", robots: { index: false } };

/**
 * Ссылка из письма открывает эту страницу, а вход происходит по кнопке (POST):
 * почтовые сканеры, которые открывают ссылки заранее, не «сжигают» одноразовый токен.
 */
export default async function EmailLoginPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-xl font-bold">Вход по ссылке из письма</h1>
      <div className="card space-y-3 p-6">
        {token ? (
          <ConfirmLogin token={token} />
        ) : (
          <p className="text-sm">
            Ссылка неполная. <Link href="/login" className="text-accent underline">Запросите новую</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
