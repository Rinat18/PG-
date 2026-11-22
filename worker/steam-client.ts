/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
/**
 * Реальный бот Steam: steam-user (вход), steamcommunity (подтверждения), steam-tradeoffer-manager (офферы).
 * Секреты бота живут только в env воркера (STEAM_BOTS) и никуда не пишутся.
 */
import type { SteamItem } from "@/lib/bots/inventory";
import { BotError, type BotClient, type OfferState } from "@/lib/bots/trades";

const SteamUser = require("steam-user");
const SteamCommunity = require("steamcommunity");
const TradeOfferManager = require("steam-tradeoffer-manager");
const SteamTotp = require("steam-totp");

export type BotConfig = { name: string; username: string; password: string; sharedSecret: string; identitySecret: string };

const STATE_NAMES: Record<number, OfferState> = {
  1: "Invalid",
  2: "Active",
  3: "Accepted",
  4: "Countered",
  5: "Expired",
  6: "Canceled",
  7: "Declined",
  8: "InvalidItems",
  9: "CreatedNeedsConfirmation",
  10: "CanceledBySecondFactor",
  11: "InEscrow",
};

/** EResult, при которых повтор бессмыслен: доступ запрещен, ссылка недействительна, предмета нет, трейд-бан. */
const PERMANENT_ERESULTS = new Set([2, 8, 15, 16, 25, 26]);

const p = <T>(fn: (cb: (err: any, res?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res as T))));

export class SteamBotClient implements BotClient {
  private constructor(
    readonly steamId: string,
    private readonly cfg: BotConfig,
    private readonly user: any,
    private readonly community: any,
    private readonly manager: any,
  ) {}

  static async login(cfg: BotConfig, onError: (e: Error) => void): Promise<SteamBotClient> {
    const user = new SteamUser({ autoRelogin: true });
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: user, community, language: "en", pollInterval: -1, cancelTime: undefined });

    const ready = new Promise<void>((resolve, reject) => {
      user.once("webSession", async (_sid: string, cookies: string[]) => {
        try {
          await p<void>((cb) => manager.setCookies(cookies, cb));
          community.setCookies(cookies);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      user.once("error", reject);
    });
    // при повторной выдаче сессии Steam обновляем cookies
    user.on("webSession", (_sid: string, cookies: string[]) => {
      manager.setCookies(cookies, () => {});
      community.setCookies(cookies);
    });
    user.on("error", (e: Error) => onError(e));
    community.on("sessionExpired", () => user.webLogOn());

    user.logOn({ accountName: cfg.username, password: cfg.password, twoFactorCode: SteamTotp.generateAuthCode(cfg.sharedSecret) });
    await ready;
    return new SteamBotClient(user.steamID.getSteamID64(), cfg, user, community, manager);
  }

  async getInventory(appId: number): Promise<SteamItem[]> {
    const items = await p<any[]>((cb) => this.manager.getInventoryContents(appId, 2, false, cb));
    return items.map((i) => ({
      assetid: String(i.assetid ?? i.id),
      classid: i.classid,
      instanceid: i.instanceid,
      appid: i.appid,
      contextid: String(i.contextid),
      market_hash_name: i.market_hash_name,
      name: i.name,
      type: i.type,
      tradable: Boolean(i.tradable),
      marketable: Boolean(i.marketable),
      icon_url: i.icon_url,
      tags: (i.tags ?? []).map((t: any) => ({ category: t.category, internal_name: t.internal_name, localized_tag_name: t.name ?? t.localized_tag_name })),
      descriptions: i.descriptions,
      actions: i.actions,
    }));
  }

  async sendOffer(o: { tradeUrl: string; appId: number; assetId: string; message: string }) {
    const offer = this.manager.createOffer(o.tradeUrl);
    offer.addMyItem({ appid: o.appId, contextid: "2", assetid: o.assetId });
    offer.setMessage(o.message);
    try {
      const status = await p<string>((cb) => offer.send(cb));
      if (status === "pending") {
        await p<void>((cb) => this.community.acceptConfirmationForObject(this.cfg.identitySecret, offer.id, cb));
      }
      return { offerId: String(offer.id) };
    } catch (e: any) {
      throw new BotError(`${e?.message ?? e}${e?.eresult ? ` (EResult ${e.eresult})` : ""}`, PERMANENT_ERESULTS.has(Number(e?.eresult)));
    }
  }

  async getOfferState(offerId: string): Promise<OfferState> {
    const offer = await p<any>((cb) => this.manager.getOffer(offerId, cb));
    return STATE_NAMES[offer.state] ?? "Invalid";
  }

  async cancelOffer(offerId: string) {
    const offer = await p<any>((cb) => this.manager.getOffer(offerId, cb));
    if (offer.state === 2 || offer.state === 9) await p<void>((cb) => offer.cancel(cb));
  }

  logOff() {
    this.user.logOff();
  }
}
