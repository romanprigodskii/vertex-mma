import type { Metadata } from "next";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Container } from "@/components/layout/container";
import { FighterCatalogClient } from "@/components/fighter/FighterCatalogClient";
import type { CatalogFilterState } from "@/components/fighter/FilterSidebar";
import { parseCatalogFilters } from "@/lib/fighter-filters";
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
    description: "AI-powered MMA fight simulator with detailed fighter analytics.",
    type: "website",
  },
};

function toClientFilters(parsed: FighterCatalogFilters): CatalogFilterState {
  return {
    q: parsed.q ?? "",
    weight: parsed.weight ?? [],
    country: parsed.country ?? [],
    stance: parsed.stance ?? [],
    status: parsed.status ?? "all",
    hasPhoto: parsed.hasPhoto ?? false,
    hallOfFame: parsed.hallOfFame ?? false,
    sort: parsed.sort ?? "fights",
  };
}

interface PageProps {
  // Next.js 15+ App Router exposes searchParams as a Promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function FightersPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const filters = parseCatalogFilters(raw);
  filters.limit = CATALOG_DEFAULT_LIMIT;
  filters.offset = 0;

  // Run the three SSR queries in parallel — they're independent.
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
        <section className="border-b border-border">
          <Container size="xl" className="py-10 md:py-14">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              Catalog
            </p>
            <h1 className="mt-2 font-display text-6xl md:text-7xl lg:text-8xl tracking-wider leading-none text-foreground">
              FIGHTERS
            </h1>
            <p className="mt-4 max-w-2xl text-base md:text-lg text-foreground-muted">
              <span className="font-mono tabular text-foreground">
                {totalAll.toLocaleString()}
              </span>{" "}
              fighters indexed · UFC roster since 1993
            </p>
          </Container>
        </section>

        <Container size="xl" className="py-6 md:py-8">
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
