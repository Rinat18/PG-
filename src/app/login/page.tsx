import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current";
import { safeNextPath } from "@/lib/auth/email-login";
import { env } from "@/lib/env";
import { EmailLoginForm } from "./EmailLoginForm";
import { DEMO_PERSONAS } from "@/lib/demo/personas";
import { demoLoginAction } from "./actions";

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
      {env.DEMO_MODE && (
        <div className="card space-y-3 border-accent/40 p-6">
          <div className="text-sm font-semibold">Демо: войти тестовой ролью</div>
          <p className="text-xs text-muted">Только на демо-стенде. Steam-аккаунты ненастоящие, инвентари тестовые.</p>
          {Object.entries(DEMO_PERSONAS).map(([key, p]) => (
            <form key={key} action={demoLoginAction}>
              <input type="hidden" name="persona" value={key} />
              <button className="w-full rounded-lg border border-line px-3 py-2 text-left hover:border-accent">
                <div className="text-sm font-semibold">{p.label}</div>
                <div className="text-xs text-muted">{p.hint}</div>
              </button>
            </form>
          ))}
        </div>
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
