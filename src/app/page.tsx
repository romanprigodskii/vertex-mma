import { sql } from "drizzle-orm";
import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { MarketCard } from "@/components/markets/market-card";
import { RankingCard } from "@/components/rankings/ranking-card";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listOpenMarkets } from "@/lib/markets";
import { listRecentRankings } from "@/lib/rankings";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vertex MMA — UFC scores, rankings, betting",
  description:
    "Vertex score for every active UFC fighter, community rankings, and virtual coin betting markets.",
};

type TopFighter = {
  id: string;
  slug: string;
  name_en: string;
  photo_thumbnail_url: string | null;
  photo_url: string | null;
  division: string | null;
  score: number | null;
};

async function getTopFighters(limit: number): Promise<TopFighter[]> {
  // Headline score = the fighter's divisional score in their current
  // division (Wave 14B.2 — the same number the profile hero shows),
  // falling back to the global vertex_score when no divisional row
  // exists. Sort AND display by that one canonical number so the home
  // list never contradicts the profile (e.g. Pereira 80 LHW, not the
  // global 85).
  const result = await db.execute<TopFighter>(sql`
    SELECT
      f.id::text AS id,
      f.slug,
      f.name_en,
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

export default async function HomePage() {
  const [user, topFighters, topMarkets, recentRankings] = await Promise.all([
    getCurrentUser(),
    getTopFighters(5),
    listOpenMarkets(6),
    listRecentRankings(3),
  ]);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-16 md:py-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-primary">
              Vertex MMA · Beta
            </p>
            <h1 className="mt-4 font-display uppercase tracking-tight text-foreground text-hero">
              Every UFC fighter,
              <br />
              ranked and wagered.
            </h1>
            <p className="mt-6 max-w-2xl font-sans text-base text-foreground-muted md:text-lg">
              Vertex Score combines quality wins, championship pedigree,
              recent form, finishing rate, and defensive vulnerability into
              a 0–100 number for every active UFC fighter. Build your own
              rankings, bet virtual coins on every bout.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/fighters"
                className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Browse fighters
              </Link>
              {user ? (
                <Link
                  href="/markets"
                  className="rounded-sm border border-foreground/15 px-5 py-2.5 font-display text-sm uppercase tracking-widest text-foreground hover:bg-foreground/[0.05]"
                >
                  Open markets
                </Link>
              ) : (
                <Link
                  href="/signup"
                  className="rounded-sm border border-foreground/15 px-5 py-2.5 font-display text-sm uppercase tracking-widest text-foreground hover:bg-foreground/[0.05]"
                >
                  Create account
                </Link>
              )}
            </div>
          </Container>
        </section>

        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-12 md:py-16">
            <div className="mb-6 flex items-baseline justify-between">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                Top fighters
              </h2>
              <Link
                href="/fighters"
                className="font-sans text-sm text-primary hover:underline"
              >
                See all →
              </Link>
            </div>
            {topFighters.length === 0 ? (
              <p className="font-sans text-sm text-foreground-muted">
                No fighters yet.
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
                          className="h-12 w-12 shrink-0 rounded-sm border border-foreground/15 object-cover"
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
                          {f.division?.replace(/_/g, " ") ?? "—"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-display text-2xl tabular text-foreground">
                          {f.score ?? "—"}
                        </p>
                        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                          Vertex
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        <section className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-12 md:py-16">
            <div className="mb-6 flex items-baseline justify-between">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                Open markets
              </h2>
              <Link
                href="/markets"
                className="font-sans text-sm text-primary hover:underline"
              >
                All markets →
              </Link>
            </div>
            {topMarkets.length === 0 ? (
              <p className="font-sans text-sm text-foreground-muted">
                No open markets yet — run{" "}
                <code className="rounded-sm bg-foreground/[0.05] px-1 py-0.5 font-mono text-xs">
                  pnpm markets:generate
                </code>
                .
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
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
            <div className="mb-6 flex items-baseline justify-between">
              <h2 className="font-display uppercase tracking-tight text-foreground text-h2">
                Community rankings
              </h2>
              <Link
                href="/rankings"
                className="font-sans text-sm text-primary hover:underline"
              >
                All rankings →
              </Link>
            </div>
            {recentRankings.length === 0 ? (
              <p className="font-sans text-sm text-foreground-muted">
                Be the first to publish —{" "}
                <Link
                  href="/rankings/create"
                  className="text-primary hover:underline"
                >
                  create a ranking
                </Link>
                .
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
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
                Get 10,000 free coins on signup.
              </h2>
              <p className="mt-3 font-sans text-base text-foreground-muted">
                Build rankings, place bets, climb the leaderboard.
              </p>
              <Link
                href="/signup"
                className="mt-6 inline-block rounded-sm bg-primary px-6 py-3 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Create account
              </Link>
            </Container>
          </section>
        ) : null}
      </main>
      <Footer />
    </>
  );
}
