import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current";
import { safeNextPath } from "@/lib/auth/email-login";
import { env } from "@/lib/env";
import { EmailLoginForm } from "./EmailLoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Вход", robots: { index: false } };

const errors: Record<string, string> = {
  steam: "Steam не подтвердил вход. Попробуйте еще раз",
  rate: "Слишком много попыток входа. Подождите несколько минут",
  blocked: "Аккаунт заблокирован. Напишите в поддержку",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-xl font-bold">Вход</h1>
      {sp.error && errors[sp.error] && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{errors[sp.error]}</div>
      )}
      <div className="card space-y-3 p-6">
        <a href={`/api/auth/steam?next=${encodeURIComponent(next)}`} className="btn-primary w-full">
          Войти через Steam
        </a>
        <p className="text-xs text-muted">Нужен для покупки скинов: на ваш Steam-аккаунт придет трейд-оффер.</p>
      </div>
      <div className="card space-y-3 p-6">
        <div className="text-sm font-semibold">Войти по email</div>
        <p className="text-xs text-muted">Пришлем одноразовую ссылку. Заказы, оформленные на этот email без входа, появятся в кабинете.</p>
        <EmailLoginForm next={next} devMailbox={env.EMAIL_TRANSPORT === "dev"} />
      </div>
    </div>
  );
}
