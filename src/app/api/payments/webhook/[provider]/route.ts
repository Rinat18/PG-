import { handlePaymentWebhook } from "@/lib/orders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Callback платежного провайдера. Тело читаем сырым: подпись считается по байтам, а не по распарсенному JSON. */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const rawBody = await req.text();
  try {
    const res = await handlePaymentWebhook(provider, rawBody, req.headers);
    return Response.json({ result: res.result }, { status: res.httpStatus });
  } catch (e) {
    console.error("webhook error", e);
    // 500 -> провайдер повторит доставку; повтор безопасен благодаря журналу событий
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
