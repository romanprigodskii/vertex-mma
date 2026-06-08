import { NextResponse, type NextRequest } from "next/server";

import { parseCatalogFilters } from "@/lib/fighter-filters";
import { searchFightersWithFilters } from "@/lib/fighter-search";
import { allowBurst, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Lightweight per-IP throttle for this unauthenticated endpoint. Generous
  // headroom (60 / 10s) so legitimate filter toggles / infinite-scroll never
  // trip it, while a scraper hammering deep pagination gets cut off. (?limit and
  // ?offset are already clamped in parseCatalogFilters.)
  if (!allowBurst(`api-fighters:${clientIp(request.headers)}`, 60, 10_000)) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      },
    );
  }

  const filters = parseCatalogFilters(request.nextUrl.searchParams);

  try {
    const result = await searchFightersWithFilters(filters);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[/api/fighters] query failed", error);
    return NextResponse.json(
      { error: "Failed to load fighters" },
      { status: 500 },
    );
  }
}
