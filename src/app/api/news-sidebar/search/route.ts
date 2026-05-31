import { NextResponse, type NextRequest } from "next/server";

import { searchFighters } from "@/lib/fighter-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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
