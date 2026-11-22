import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sellerProfiles } from "@/db/schema";
import { requireUser } from "@/lib/auth/current";
import { VerifyForm } from "./VerifyForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Верификация продавца", robots: { index: false } };

export default async function VerifyPage() {
  const user = await requireUser("/sell/verify");
  if (!user.steamId) redirect("/sell");
  const [p] = await db.select({ status: sellerProfiles.verificationStatus }).from(sellerProfiles).where(eq(sellerProfiles.userId, user.id));
  if (p?.status === "PENDING" || p?.status === "APPROVED") redirect("/sell");
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link href="/sell" className="text-sm text-muted hover:text-text">← Кабинет продавца</Link>
      <div className="card space-y-4 p-6">
        <h1 className="text-xl font-bold">Верификация продавца</h1>
        <p className="text-sm text-muted">
          Нужна до первой выплаты: так требует платежный провайдер. Данные хранятся в зашифрованном виде, видит их только
          сотрудник комплаенса. Проверка обычно занимает до одного рабочего дня.
        </p>
        <VerifyForm />
      </div>
    </div>
  );
}
