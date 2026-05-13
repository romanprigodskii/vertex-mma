import type { Metadata } from "next";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Container } from "@/components/layout/container";
import { FighterCatalogClient } from "@/components/fighter/FighterCatalogClient";
import type { CatalogFilterState } from "@/components/fighter/FilterSidebar";
import { CHAMPION_SLUGS } from "@/lib/champions";
import { parseCatalogFilters } from "@/lib/fighter-filters";
import {
  CATALOG_DEFAULT_LIMIT,
  type FighterCatalogFilters,
  type FighterCatalogRow,
  getFighterCountries,
  getFighterTotal,
  getFightersBySlug,
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
    status: parsed.status ?? "all",
    hasPhoto: parsed.hasPhoto ?? false,
    hallOfFame: parsed.hallOfFame ?? false,
    sort: parsed.sort ?? "champions_first",
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

  const [page, countries, totalAll, championRows] = await Promise.all([
    searchFightersWithFilters(filters),
    getFighterCountries(),
    getFighterTotal(),
    getFightersBySlug(CHAMPION_SLUGS),
  ]);

  const clientFilters = toClientFilters(filters);
  const championFighters: Record<string, FighterCatalogRow> = Object.fromEntries(
    championRows.map((f) => [f.slug, f]),
  );

  // Surface missing champion slugs in the server log so the user notices when
  // the hardcoded champions.ts drifts from the live DB. Doesn't fail the build.
  const missingChampions = CHAMPION_SLUGS.filter(
    (slug) => !(slug in championFighters),
  );
  if (missingChampions.length > 0) {
    console.warn(
      "[/fighters] champion slugs not found in DB:",
      missingChampions.join(", "),
    );
  }

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
            championFighters={championFighters}
          />
        </Container>
      </main>
      <Footer />
    </>
  );
}

function CatalogHero({ totalAll }: { totalAll: number }) {
  return (
    <section className="relative border-b border-foreground/10">
      <Container size="xl" className="pb-16 pt-20 md:pt-24">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
          The roster
        </p>
        <h1
          className="mt-3 font-display tracking-[-0.01em] text-foreground leading-[0.85]"
          style={{ fontSize: "clamp(64px, 8vw, 144px)" }}
        >
          FIGHTERS
        </h1>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-[28px] leading-none text-primary">
            {totalAll.toLocaleString()}
          </span>
          <span className="font-sans text-base text-foreground-muted">
            fighters indexed
          </span>
        </div>
        <p className="mt-4 font-sans text-[11px] uppercase tracking-[0.24em] text-foreground-muted">
          8 Divisions · 12 Active Champions · UFC, 1993 → Today
        </p>
      </Container>
    </section>
  );
}
