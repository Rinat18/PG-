import { randomUUID } from "node:crypto";
import { cs2Items, dotaItems } from "./fixtures";
import type { SteamItem } from "./inventory";
import { BotError, type BotClient, type OfferState } from "./trades";

/**
 * Бот без Steam — для разработки и проверки на моках (BOT_MODE=mock).
 * Инвентарь — примеры из fixtures (включая кейсы, которые должен отсечь фильтр).
 * Отправленный оффер «принимается» через acceptAfterMs; trade-ссылка с token=decline… — отклоняется,
 * token=hold… — уходит в trade hold, token=fail… — ошибка отправки.
 */
export class MockBotClient implements BotClient {
  private offers = new Map<string, { sentAt: number; tradeUrl: string; state?: OfferState }>();
  private given = new Set<string>();

  constructor(
    readonly steamId: string,
    private readonly acceptAfterMs = 30_000,
    private readonly inventory: SteamItem[] = [...Object.values(cs2Items), ...Object.values(dotaItems)],
  ) {}

  async getInventory(appId: number) {
    return this.inventory.filter((i) => i.appid === appId && !this.given.has(i.assetid));
  }

  async sendOffer(p: { tradeUrl: string; appId: number; assetId: string }) {
    if (/token=fail/i.test(p.tradeUrl)) throw new BotError("mock: Steam временно недоступен (EResult 20)");
    if (!this.inventory.some((i) => i.assetid === p.assetId) || this.given.has(p.assetId)) {
      throw new BotError("mock: предмета нет в инвентаре бота", true);
    }
    // состояние зашифровано в id: оффер читается и в другом экземпляре сервера (демо-стенд без воркера)
    const mode = /token=decline/i.test(p.tradeUrl) ? "d" : /token=hold/i.test(p.tradeUrl) ? "h" : "a";
    const offerId = `mock-${Date.now()}-${mode}-${randomUUID().slice(0, 8)}`;
    this.offers.set(offerId, { sentAt: Date.now(), tradeUrl: p.tradeUrl });
    if (!/token=decline/i.test(p.tradeUrl)) this.given.add(p.assetId);
    return { offerId };
  }

  async getOfferState(offerId: string): Promise<OfferState> {
    const o = this.offers.get(offerId) ?? decodeOffer(offerId);
    if (!o) return "Invalid";
    if (o.state) return o.state;
    if (Date.now() - o.sentAt < this.acceptAfterMs) return "Active";
    if (/token=decline/i.test(o.tradeUrl)) return "Declined";
    if (/token=hold/i.test(o.tradeUrl)) return "InEscrow";
    return "Accepted";
  }

  async cancelOffer(offerId: string) {
    const o = this.offers.get(offerId);
    if (o) o.state = "Canceled";
  }
}

function decodeOffer(offerId: string): { sentAt: number; tradeUrl: string; state?: OfferState } | null {
  const m = /^mock-(\d+)-([adh])-/.exec(offerId);
  if (!m) return null;
  const tradeUrl = m[2] === "d" ? "token=decline" : m[2] === "h" ? "token=hold" : "";
  return { sentAt: Number(m[1]), tradeUrl };
}
