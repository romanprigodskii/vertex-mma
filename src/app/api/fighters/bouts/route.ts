import { NextResponse, type NextRequest } from "next/server";

import { listFighterBoutsForPicker } from "@/lib/custom-simulation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Completed UFC bouts of one fighter, newest first — feeds the custom-sim
 *  "take form from this bout" dropdown. */
export async function GET(request: NextRequest) {
  const fighterId = request.nextUrl.searchParams.get("fighter") ?? "";
  // /api/* is excluded from the next-intl middleware, so the client passes
  // ?locale= explicitly — same contract as /api/fighters.
  const locale = request.nextUrl.searchParams.get("locale");
  const bouts = await listFighterBoutsForPicker(
    fighterId,
    locale ? { isRu: locale === "ru" } : {},
  );
  return NextResponse.json(
    { bouts },
    { headers: { "Cache-Control": "no-store" } },
  );
}
