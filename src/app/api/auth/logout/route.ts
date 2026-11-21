import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth/current";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Выход только POST-запросом (форма), чтобы чужая страница не могла разлогинить ссылкой. */
export async function POST() {
  await endSession();
  return NextResponse.redirect(`${env.APP_URL}/`, 303);
}
