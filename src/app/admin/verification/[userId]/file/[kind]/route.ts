import { cookies } from "next/headers";
import { getUserBySessionCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { getVerificationFileKey } from "@/lib/p2p/seller";
import { readDocument } from "@/lib/p2p/files";
import { can } from "@/lib/admin/rbac";

export const dynamic = "force-dynamic";

/** Фото паспорта и селфи: расшифровываются на лету, только для комплаенса, без кеширования. */
export async function GET(_req: Request, { params }: { params: Promise<{ userId: string; kind: string }> }) {
  const { userId, kind } = await params;
  const user = await getUserBySessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  if (!can(user, "verification.manage") || (kind !== "passport" && kind !== "selfie") || !/^[0-9a-f-]{36}$/i.test(userId)) {
    return new Response("Not found", { status: 404 });
  }
  const key = await getVerificationFileKey(user, userId, kind);
  if (!key) return new Response("Not found", { status: 404 });
  const { data, mime } = await readDocument(key);
  return new Response(new Uint8Array(data), {
    headers: { "content-type": mime, "cache-control": "no-store, private", "x-content-type-options": "nosniff" },
  });
}
