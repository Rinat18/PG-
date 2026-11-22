import { after } from "next/server";
import { env } from "@/lib/env";
import { runDemoTick } from "./tick";

/** Демо-стенд: после ответа страницы продвинуть боты, сделки и почту (вместо воркера). */
export function kickDemoTick() {
  if (!env.DEMO_MODE) return;
  after(async () => {
    try {
      await runDemoTick();
    } catch (e) {
      console.error("[demo] тик не удался:", (e as Error).message);
    }
  });
}
