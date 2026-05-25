import type { Metadata } from "next";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Container } from "@/components/layout/container";
import { FighterCatalogClient } from "@/components/fighter/FighterCatalogClient";
import type { CatalogFilterState } from "@/components/fighter/FilterSidebar";
import { parseCatalogFilters } from "@/lib/fighter-filters";
import { formatNumber } from "@/lib/format";
import {
  CATALOG_DEFAULT_LIMIT,
  type FighterCatalogFilters,
  getFighterCountries,
  getFighterTotal,
  searchFightersWithFilters,
} from "@/lib/fighter-search";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fighters",
  description:
    "Explore UFC fighters with detailed career stats, fight history, and AI-powered analysis.",
  openGraph: {
    title: "Vertex MMA — Fighter Database",
    description:
      "AI-powered MMA fight simulator with detailed fighter analytics.",
    type: "website",
  },
};

function toClientFilters(parsed: FighterCatalogFilters): CatalogFilterState {
  return {
    q: parsed.q ?? "",
    weight: parsed.weight ?? [],
    country: parsed.country ?? [],
    stance: parsed.stance ?? [],
    status: parsed.status ?? "active",
    hasPhoto: parsed.hasPhoto ?? false,
    hallOfFame: parsed.hallOfFame ?? false,
    sort: parsed.sort ?? "vertex_current",
    tier: parsed.tier ?? "all",
    champion: parsed.champion ?? "all",
    gender: parsed.gender ?? "all",
  };
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function FightersPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const filters = parseCatalogFilters(raw);
  filters.limit = CATALOG_DEFAULT_LIMIT;
  filters.offset = 0;

  const [page, countries, totalAll] = await Promise.all([
    searchFightersWithFilters(filters),
    getFighterCountries(),
    getFighterTotal(),
  ]);

  const clientFilters = toClientFilters(filters);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <CatalogHero totalAll={totalAll} />
        <Container size="xl" className="pb-16 pt-2">
          <FighterCatalogClient
            initialFighters={page.fighters}
            initialTotal={page.total}
            initialHasMore={page.hasMore}
            initialFilters={clientFilters}
            countries={countries}
            totalAll={totalAll}
          />
        </Container>
      </main>
      <Footer />
    </>
  );
}

function CatalogHero({ totalAll }: { totalAll: number }) {
  return (
    <section className="relative border-b border-edge">
      <Container size="xl" className="pb-16 pt-20 md:pt-24">
        <p className="type-meta text-[11px] text-fg-subtle">
          The roster
        </p>
        <h1 className="type-display mt-3 text-hero text-fg">
          FIGHTERS
        </h1>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-broadcast-display text-[28px] font-bold leading-none tabular text-fg">
            {formatNumber(totalAll)}
          </span>
          <span className="type-body text-base text-fg-muted">
            fighters indexed
          </span>
        </div>
        <p className="type-meta mt-4 text-[11px] text-fg-muted">
          8 Divisions · 12 Active Champions · UFC, 1993 → Today
        </p>
      </Container>
    </section>
  );
}
