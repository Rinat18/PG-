"use server";

import { redirect } from "next/navigation";
import { consumeEmailLogin, EmailLoginError, requestEmailLogin } from "@/lib/auth/email-login";
import { getClientIp, getCurrentUser, startSession } from "@/lib/auth/current";
import { allowFormByIp, isHoneypotTripped } from "@/lib/security/rate-limit";

export type EmailLoginState = { sent?: boolean; error?: string; email?: string };

export async function requestEmailLoginAction(_prev: EmailLoginState, form: FormData): Promise<EmailLoginState> {
  const email = String(form.get("email") ?? "");
  // Боту отвечаем как человеку, но письмо не отправляем
  if (isHoneypotTripped(form)) return { sent: true, email };
  if (!(await allowFormByIp("emailLogin", await getClientIp()))) {
    return { error: "Слишком много попыток. Попробуйте через 15 минут", email };
  }
  const current = await getCurrentUser();
  try {
    await requestEmailLogin(email, {
      ip: await getClientIp(),
      next: String(form.get("next") ?? ""),
      linkToUserId: form.get("link") === "1" && current ? current.id : undefined,
    });
  } catch (e) {
    if (e instanceof EmailLoginError) return { error: e.message, email };
    console.error(e);
    return { error: "Не получилось отправить письмо. Попробуйте позже", email };
  }
  return { sent: true, email };
}

export type ConsumeState = { error?: string };

export async function consumeEmailLoginAction(_prev: ConsumeState, form: FormData): Promise<ConsumeState> {
  let next: string;
  try {
    const res = await consumeEmailLogin(String(form.get("token") ?? ""));
    await startSession(res.userId);
    next = res.next;
  } catch (e) {
    if (e instanceof EmailLoginError) return { error: e.message };
    console.error(e);
    return { error: "Не получилось войти. Попробуйте еще раз" };
  }
  redirect(next);
}
