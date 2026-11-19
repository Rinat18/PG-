import { getOrderForBuyer } from "@/lib/orders/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getOrderForBuyer(token);
  if (!view) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ status: view.order.status });
}
