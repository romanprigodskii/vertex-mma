import { NextResponse, type NextRequest } from "next/server";

import { listFighterBoutsForPicker } from "@/lib/custom-simulation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Completed UFC bouts of one fighter, newest first — feeds the custom-sim
 *  "take form from this bout" dropdown. */
export async function GET(request: NextRequest) {
  const fighterId = request.nextUrl.searchParams.get("fighter") ?? "";
  const bouts = await listFighterBoutsForPicker(fighterId);
  return NextResponse.json(
    { bouts },
    { headers: { "Cache-Control": "no-store" } },
  );
}
