import { NextResponse, type NextRequest } from "next/server";

import { parseCatalogFilters } from "@/lib/fighter-filters";
import { searchFightersWithFilters } from "@/lib/fighter-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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
