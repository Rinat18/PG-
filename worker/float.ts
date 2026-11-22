import type { FloatProvider } from "@/lib/bots/inventory";

/**
 * float и паттерн CS2 по inspect-ссылке. Формат ответа — как у CSFloat Inspect API
 * ({ iteminfo: { floatvalue, paintseed } }). Адрес — FLOAT_INSPECT_API (например, свой csfloat/inspect).
 */
export function httpFloatProvider(baseUrl: string, apiKey?: string): FloatProvider {
  return {
    async inspect(link) {
      const res = await fetch(`${baseUrl}?url=${encodeURIComponent(link)}`, {
        headers: apiKey ? { Authorization: apiKey } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { iteminfo?: { floatvalue?: number; paintseed?: number } };
      const f = data.iteminfo?.floatvalue;
      return typeof f === "number" ? { float: f, pattern: data.iteminfo?.paintseed ?? 0 } : null;
    },
  };
}
