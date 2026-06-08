import { NextResponse, type NextRequest } from "next/server";

import { searchFighters } from "@/lib/fighter-search";
import { allowBurst, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Lightweight per-IP throttle for this unauthenticated typeahead. Headroom
  // (60 / 10s) sits well above the client's 220ms debounce so a real user never
  // trips it, while scripted hammering is cut off. (q is capped at 64 chars and
  // the result count is fixed at 6 below.)
  if (!allowBurst(`api-news-search:${clientIp(request.headers)}`, 60, 10_000)) {
    return NextResponse.json(
      { results: [], error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      },
    );
  }

  const q = request.nextUrl.searchParams.get("q")?.trim().slice(0, 64) ?? "";
  if (q.length < 2) {
    return NextResponse.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const rows = await searchFighters(q, 6);
    const results = rows.map((r) => ({
      slug: r.slug,
      name: r.name_en,
      nickname: r.nickname,
      photo_url: r.photo_thumbnail_url ?? r.photo_url,
      record:
        r.wins_total !== null && r.losses_total !== null
          ? `${r.wins_total}-${r.losses_total}${r.draws_total ? `-${r.draws_total}` : "-0"}`
          : null,
    }));
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/news-sidebar/search] failed", error);
    return NextResponse.json({ results: [], error: "Search failed" }, { status: 500 });
  }
}
