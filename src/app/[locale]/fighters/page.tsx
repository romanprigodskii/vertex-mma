import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("fightersTitle"),
    description: t("fightersDescription"),
    openGraph: {
      title: t("fightersOgTitle"),
      description: t("fightersOgDescription"),
      type: "website",
    },
  };
}

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

async function CatalogHero({ totalAll }: { totalAll: number }) {
  const t = await getTranslations("catalog");
  return (
    <section className="relative border-b border-foreground/10">
      <Container size="xl" className="pb-16 pt-20 md:pt-24">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
          {t("rosterKicker")}
        </p>
        <h1 className="mt-3 font-display uppercase tracking-[-0.01em] text-foreground text-hero">
          {t("rosterTitle")}
        </h1>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-[28px] leading-none text-primary">
            {formatNumber(totalAll)}
          </span>
          <span className="font-sans text-base text-foreground-muted">
            {t("fightersIndexed")}
          </span>
        </div>
        <p className="mt-4 font-sans text-[11px] uppercase tracking-[0.24em] text-foreground-muted">
          {t("rosterStats")}
        </p>
      </Container>
    </section>
  );
}
