import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { MarketCard } from "@/components/markets/market-card";
import { RankingCard } from "@/components/rankings/ranking-card";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { localizedNameSql } from "@/lib/i18n-name";
import { marketHasOdds } from "@/lib/market-odds";
import { listOpenMarkets } from "@/lib/markets";
import { listRecentRankings } from "@/lib/rankings";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

type TopFighter = {
  id: string;
  slug: string;
  name_en: string;
  photo_thumbnail_url: string | null;
  photo_url: string | null;
  division: string | null;
  score: number | null;
};

async function getTopFighters(
  isRu: boolean,
  limit: number,
): Promise<TopFighter[]> {
  // Headline score = the fighter's divisional score in their current
  // division (Wave 14B.2 — the same number the profile hero shows),
  // falling back to the global vertex_score when no divisional row
  // exists. Sort AND display by that one canonical number so the home
  // list never contradicts the profile (e.g. Pereira 80 LHW, not the
  // global 85).
  //
  // KEEP IN SYNC: the official P4P board query in
  // src/lib/official-rankings.ts uses this same coalesce + ordering
  // (per-gender). A change to the headline rule here must land there too.
  const result = await db.execute<TopFighter>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      ${localizedNameSql("f", isRu)} AS name_en,
      f.photo_thumbnail_url,
      f.photo_url,
      COALESCE(f.current_division, f.weight_class_primary::text) AS division,
      COALESCE(fds.vertex_score, f.vertex_score) AS score
    FROM fighter_with_stats f
    LEFT JOIN fighter_divisional_score fds
      ON fds.fighter_id = f.id
      AND fds.division::text = f.current_division
      AND fds.in_active_ranking = true
    WHERE f.roster_status = 'active'
      AND COALESCE(fds.vertex_score, f.vertex_score) IS NOT NULL
    ORDER BY
      COALESCE(fds.vertex_score, f.vertex_score) DESC,
      f.bout_count DESC
    LIMIT ${limit}
  `);
  return [...(result as unknown as TopFighter[])];
}

/** The page is force-dynamic (it personalizes off the session), but the top-
 *  fighters roster sort doesn't depend on the request — its inputs only move
 *  when the rating pipeline reruns. Cache it per locale for an hour so the
 *  whole-roster COALESCE sort isn't re-run on every page view. */
function getCachedTopFighters(
  isRu: boolean,
  limit: number,
): Promise<TopFighter[]> {
  return unstable_cache(
    () => getTopFighters(isRu, limit),
    ["home-top-fighters", isRu ? "ru" : "en", String(limit)],
    { revalidate: 3600 },
  )();
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const tCommon = await getTranslations("common");
  const tWeight = await getTranslations("weight");
  const weightLabel = (division: string | null): string => {
    if (!division) return "—";
    const key = division.replace(/-/g, "_");
    return tWeight.has(key) ? tWeight(key as "lightweight") : division.replace(/_/g, " ");
  };
  const [user, topFighters, openMarketsRaw, recentRankings] = await Promise.all([
    getCurrentUser(),
    getCachedTopFighters(locale === "ru", 5),
    listOpenMarkets(40),
    listRecentRankings(3),
  ]);

  // Only surface markets with a real line (synced odds or a trade) — the LMSR
  // cold-start default would otherwise fill the homepage with fake 50/50s.
  const topMarkets = openMarketsRaw
    .filter((m) => marketHasOdds(m.outcomes, m.total_volume))
    .slice(0, 6);
  const hasAnyMarkets = openMarketsRaw.length > 0;

  // The hero title is two lines in both locales — store with a literal
  // \n in the message file and split here. Avoids an i18n-specific
  // `<br/>` rule and keeps the message a single key.
  const heroLines = t("heroTitle").split("\n");

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-16 md:py-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-primary">
              {t("kicker")}
            </p>
            <h1 className="mt-4 font-display uppercase tracking-tight text-foreground text-hero">
              {heroLines.map((line, i) => (
                <span key={i} className="block">
                  {line}
                </span>
              ))}
            </h1>
            <p className="mt-6 max-w-2xl font-sans text-base text-foreground-muted md:text-lg">
              {t("heroBody")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/fighters"
                className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("browseFighters")}
              </Link>
              {/* /markets is public (force-dynamic, no auth gate), and this page
                  shows a markets section + "All markets →" link just below — so
                  surface "Open markets" to everyone. Anonymous visitors still get
                  a dedicated signup CTA in the section at the bottom. */}
              <Link
                href="/markets"
                className="rounded-sm border border-foreground/15 px-5 py-2.5 font-display text-sm uppercase tracking-widest text-foreground hover:bg-foreground/[0.05]"
              >
                {t("openMarkets")}
              </Link>
            </div>
          </Container>
        </section>

        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-12 md:py-16">
            <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                {t("topFighters")}
              </h2>
              <Link
                href="/fighters"
                className="font-sans text-sm text-primary hover:underline"
              >
                {tCommon("seeAll")} →
              </Link>
            </div>
            {topFighters.length === 0 ? (
              <p className="font-sans text-sm text-foreground-muted">
                {t("noFighters")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {topFighters.map((f, i) => (
                  <li key={f.id}>
                    <Link
                      href={`/fighters/${f.slug}`}
                      prefetch={false}
                      className="flex items-center gap-4 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
                    >
                      <span className="min-w-[2.5rem] text-center font-display text-2xl tabular text-foreground-subtle">
                        #{i + 1}
                      </span>
                      {f.photo_thumbnail_url || f.photo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={
                            f.photo_thumbnail_url ?? f.photo_url ?? undefined
                          }
                          alt={f.name_en}
                          className="h-12 w-12 shrink-0 rounded-sm object-cover"
                        />
                      ) : (
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm bg-primary/15 font-display text-sm uppercase text-primary">
                          {f.name_en.slice(0, 2)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-display text-base uppercase tracking-tight text-foreground">
                          {f.name_en}
                        </p>
                        <p className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                          {weightLabel(f.division)}
                        </p>
                      </div>
                      {/* The query filters out null scores, so this is purely
                          defensive — but if it ever fires, hide the whole block
                          rather than render a giant "—" over the VERTEX caption. */}
                      {f.score != null ? (
                        <div className="shrink-0 text-right">
                          <p className="font-display text-2xl tabular text-foreground">
                            {f.score}
                          </p>
                          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                            {tCommon("vertex")}
                          </p>
                        </div>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-12 md:py-16">
            <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                {t("marketsHeading")}
              </h2>
              <Link
                href="/markets"
                className="font-sans text-sm text-primary hover:underline"
              >
                {t("allMarkets")} →
              </Link>
            </div>
            {topMarkets.length === 0 ? (
              <>
                {/* User-facing copy for everyone — whether markets exist without a
                    line yet or there are none at all. The CLI hint is an internal
                    instruction, so only surface it in development. */}
                <p className="font-sans text-sm text-foreground-muted">
                  {t("noLiveMarketsYet")}
                </p>
                {!hasAnyMarkets && process.env.NODE_ENV !== "production" ? (
                  <p className="mt-2 font-sans text-xs text-foreground-subtle">
                    {t.rich("noMarketsHint", {
                      cmd: (chunks) => (
                        <code className="rounded-sm bg-foreground/[0.05] px-1 py-0.5 font-mono text-xs">
                          {chunks}
                        </code>
                      ),
                    })}
                  </p>
                ) : null}
              </>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {topMarkets.map((m) => (
                  <li key={m.id}>
                    <MarketCard market={m} />
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-12 md:py-16">
            <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                {t("communityRankings")}
              </h2>
              <Link
                href="/rankings"
                className="font-sans text-sm text-primary hover:underline"
              >
                {t("allRankings")} →
              </Link>
            </div>
            {recentRankings.length === 0 ? (
              <p className="font-sans text-sm text-foreground-muted">
                {t.rich("noRankingsLead", {
                  link: (chunks) => (
                    <Link
                      href="/rankings/create"
                      className="text-primary hover:underline"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recentRankings.map((r) => (
                  <li key={r.id}>
                    <RankingCard ranking={r} />
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        {!user ? (
          <section>
            <Container size="md" className="py-16 text-center md:py-20">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                {t("signupCtaTitle")}
              </h2>
              <p className="mt-3 font-sans text-base text-foreground-muted">
                {t("signupCtaBody")}
              </p>
              <Link
                href="/signup"
                className="mt-6 inline-block rounded-sm bg-primary px-6 py-3 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("createAccount")}
              </Link>
            </Container>
          </section>
        ) : null}
      </main>
      <Footer />
    </>
  );
}
