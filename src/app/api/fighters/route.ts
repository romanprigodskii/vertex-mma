import { NextResponse, type NextRequest } from "next/server";

import { parseCatalogFilters } from "@/lib/fighter-filters";
import { searchFightersWithFilters } from "@/lib/fighter-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseCatalogFilters(request.nextUrl.searchParams);
  // /api/* is excluded from the next-intl middleware (src/middleware.ts), so
  // the request-scope locale never reaches this handler and isRuLocale()
  // would always resolve to English. Clients pass ?locale= explicitly; when
  // absent, keep the legacy request-scope fallback.
  const locale = request.nextUrl.searchParams.get("locale");

  try {
    const result = await searchFightersWithFilters(
      filters,
      locale ? { isRu: locale === "ru" } : {},
    );
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
