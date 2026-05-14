/**
 * Wave 3.5 step 5A — computes opponent-quality tiers per fighter.
 *
 * For every UFC win in the bout table, decide how good the opponent was at
 * the time of the bout:
 *
 *   apex    opponent was the active undisputed champion at bout date
 *   strong  opponent was within ±3 of their own bouts from a reign
 *           boundary (just before winning the belt or just after losing it)
 *   solid   former undisputed champion past the ±3 window, < 3 post-reign losses
 *   legacy  former undisputed champion with >= 3 post-reign losses by bout date
 *   ranked  never undisputed champion, but >= 1 apex/strong win on their
 *           own record (the "win over a guy who beat a champ" case)
 *   none    everyone else
 *
 * Interim reigns do NOT count as championship for any tier. Champions who
 * only ever held an interim belt (Poirier, Tony Ferguson, etc.) flow into
 * the ranked-eligibility check via their own apex/strong wins.
 *
 * Two passes are required because "ranked" depends on knowing which
 * non-champions have apex/strong wins. Pass 1 classifies wins against
 * champions; pass 2 classifies wins against non-champions who have wins
 * over active/recently-active champions.
 *
 * Writes apex_wins / strong_wins / solid_wins / legacy_wins / ranked_wins
 * / quality_wins_score on the fighter row in a single batched UPDATE.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import {
  CHAMPIONSHIP_HISTORY,
  type ChampionshipReign,
} from "../src/lib/championship-history";
import { isCuratedTitleFight } from "../src/lib/title-fights";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

type Tier = "apex" | "strong" | "solid" | "legacy" | "ranked" | "none";

interface BoutRecord {
  bout_id: string;
  date: Date;
  fighter_id: string;
  opponent_id: string;
  opponent_slug: string;
  fighter_won: boolean;
}

// Step 5A.1 fix 1: interim reigns count toward all tiers (Poirier's
// UFC 236 interim title win, Gaethje's UFC 249 interim title win, etc.
// represent genuine "active champion" status for opponent-quality purposes
// even though they're tracked separately for the dominant-champion flag).
const REIGNS_BY_SLUG = (() => {
  const m = new Map<string, ChampionshipReign[]>();
  for (const r of CHAMPIONSHIP_HISTORY) {
    const cur = m.get(r.slug) ?? [];
    cur.push(r);
    m.set(r.slug, cur);
  }
  return m;
})();

const FAR_FUTURE = new Date("2100-01-01");

function isActiveAt(slug: string, date: Date): boolean {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return false;
  for (const r of reigns) {
    const start = new Date(r.startDate);
    const end = r.endDate ? new Date(r.endDate) : FAR_FUTURE;
    if (date >= start && date <= end) return true;
  }
  return false;
}

/**
 * Strong: opponent's bout is within 3 positions of one of their own reign
 * boundaries (the bout that won the belt OR the bout that lost it). We
 * locate the boundary by finding the opponent's first bout >= reign.start
 * (their reign-winning fight) and the first > reign.end (their next fight
 * after losing) and check distance in their bout-order.
 */
function isStrongWindow(
  opponentSlug: string,
  boutDate: Date,
  opponentBouts: BoutRecord[],
): boolean {
  const reigns = REIGNS_BY_SLUG.get(opponentSlug);
  if (!reigns) return false;
  const boutIdx = opponentBouts.findIndex(
    (b) => b.date.getTime() === boutDate.getTime(),
  );
  if (boutIdx < 0) return false;
  for (const r of reigns) {
    const start = new Date(r.startDate);
    const end = r.endDate ? new Date(r.endDate) : FAR_FUTURE;
    const reignWinIdx = opponentBouts.findIndex((b) => b.date >= start);
    const postReignIdx = opponentBouts.findIndex((b) => b.date > end);
    if (reignWinIdx >= 0 && Math.abs(boutIdx - reignWinIdx) <= 3) return true;
    if (postReignIdx >= 0 && Math.abs(boutIdx - postReignIdx) <= 3) return true;
  }
  return false;
}

function postReignLosses(
  opponentSlug: string,
  boutDate: Date,
  opponentBouts: BoutRecord[],
): { reignEnd: Date | null; lossesAfter: number } {
  const reigns = REIGNS_BY_SLUG.get(opponentSlug);
  if (!reigns || reigns.length === 0) return { reignEnd: null, lossesAfter: 0 };
  // Latest finished reign as the reference point.
  const ended = reigns
    .filter((r) => r.endDate !== null)
    .sort(
      (a, b) =>
        new Date(b.endDate as string).getTime() -
        new Date(a.endDate as string).getTime(),
    );
  if (ended.length === 0) return { reignEnd: null, lossesAfter: 0 };
  const reignEnd = new Date(ended[0].endDate as string);
  if (boutDate <= reignEnd) return { reignEnd, lossesAfter: 0 };
  let losses = 0;
  for (const b of opponentBouts) {
    if (b.date > reignEnd && b.date < boutDate && !b.fighter_won) losses += 1;
  }
  return { reignEnd, lossesAfter: losses };
}

function classify(
  fighterSlug: string,
  boutId: string,
  boutDate: Date,
  opponentSlug: string,
  opponentBouts: BoutRecord[],
  rankedEligibleSlugs: Set<string> | null,
): Tier {
  // Fix 2: if the winning fighter was the active UFC champion at the bout
  // date, the win is apex. This makes every successful title defense by a
  // champion count as an apex win — fixing the DJ/Anderson/Aldo problem
  // where most of their 7-11 defenses were against challengers who never
  // won belts themselves. We don't gate on isCuratedTitleFight because the
  // curated list only covers current champions' title bouts (Wave 3C.1.2
  // scope); a champion's UFC bouts during their reign are overwhelmingly
  // title fights anyway, and the rare non-title catchweight defense by an
  // active champ (Anderson vs Bonnar etc.) still represents elite-level
  // competition because of who's involved.
  if (isActiveAt(fighterSlug, boutDate)) {
    return "apex";
  }

  const hasReign = REIGNS_BY_SLUG.has(opponentSlug);

  if (hasReign) {
    if (isActiveAt(opponentSlug, boutDate)) return "apex";
    if (isStrongWindow(opponentSlug, boutDate, opponentBouts)) return "strong";
    const { reignEnd, lossesAfter } = postReignLosses(
      opponentSlug,
      boutDate,
      opponentBouts,
    );
    if (reignEnd && boutDate > reignEnd) {
      if (lossesAfter >= 3) return "legacy";
      return "solid";
    }
    // Bout was before any of opponent's reigns started.
    return "solid";
  }

  // Non-champion path — only resolvable after pass 1 has populated the
  // ranked-eligible set. Plus Fix 3: opponents who participated in any
  // title fight count as ranked even if they have no apex/strong wins.
  if (rankedEligibleSlugs && rankedEligibleSlugs.has(opponentSlug)) {
    return "ranked";
  }
  if (opponentBouts.some((b) => isCuratedTitleFight(b.bout_id))) {
    return "ranked";
  }
  return "none";
}

async function main() {
  console.log("Loading bouts...");
  const rows = await sql<BoutRecord[]>`
    SELECT
      b.id::text AS bout_id,
      e.date AS date,
      b.fighter_a_id::text AS fighter_id,
      b.fighter_b_id::text AS opponent_id,
      f_b.slug AS opponent_slug,
      (b.winner_id = b.fighter_a_id) AS fighter_won
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter f_b ON f_b.id = b.fighter_b_id
    WHERE b.status = 'completed'

    UNION ALL

    SELECT
      b.id::text AS bout_id,
      e.date AS date,
      b.fighter_b_id::text AS fighter_id,
      b.fighter_a_id::text AS opponent_id,
      f_a.slug AS opponent_slug,
      (b.winner_id = b.fighter_b_id) AS fighter_won
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter f_a ON f_a.id = b.fighter_a_id
    WHERE b.status = 'completed'

    ORDER BY fighter_id, date
  `;
  console.log(`  ${rows.length} fighter-perspective bout rows`);

  const byFighter = new Map<string, BoutRecord[]>();
  for (const r of rows) {
    const arr = byFighter.get(r.fighter_id) ?? [];
    arr.push(r);
    byFighter.set(r.fighter_id, arr);
  }
  for (const arr of byFighter.values()) {
    arr.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // -------- Pass 1: classify wins against champions; collect apex/strong slugs
  console.log("Pass 1: classifying wins against champions...");
  type PerFighter = {
    apex: number;
    strong: number;
    solid: number;
    legacy: number;
    ranked: number;
    /** Wins still pending tier (against non-champions). */
    pending: BoutRecord[];
  };
  const counts = new Map<string, PerFighter>();
  const rankedEligibleSlugs = new Set<string>();
  /** Per-slug ledger of "has apex or strong wins on record" — used to seed
   *  the ranked-eligible set after we know who's classified high in pass 1. */
  const apexOrStrongBySlug = new Map<string, number>();

  // Build uuid → slug map up-front so we can pass each fighter's own slug
  // into classify() (needed for the title-defense-by-active-champion check).
  // Every fighter appears as an opponent in at least one UNION ALL row, so
  // the opponent_id/opponent_slug pair covers all 2700 fighters.
  const idToSlug = new Map<string, string>();
  for (const arr of byFighter.values()) {
    for (const b of arr) idToSlug.set(b.opponent_id, b.opponent_slug);
  }

  for (const [fighterId, bouts] of byFighter) {
    const fighterSlug = idToSlug.get(fighterId) ?? "";
    const c: PerFighter = {
      apex: 0,
      strong: 0,
      solid: 0,
      legacy: 0,
      ranked: 0,
      pending: [],
    };
    for (const b of bouts) {
      if (!b.fighter_won) continue;
      const opponentBouts = byFighter.get(b.opponent_id) ?? [];
      const tier = classify(
        fighterSlug,
        b.bout_id,
        b.date,
        b.opponent_slug,
        opponentBouts,
        null,
      );
      switch (tier) {
        case "apex":
          c.apex += 1;
          break;
        case "strong":
          c.strong += 1;
          break;
        case "solid":
          c.solid += 1;
          break;
        case "legacy":
          c.legacy += 1;
          break;
        case "ranked": // never returned in pass 1 (set is null)
          c.ranked += 1;
          break;
        case "none":
          c.pending.push(b);
          break;
      }
    }
    counts.set(fighterId, c);
  }

  for (const [fighterId, c] of counts) {
    if (c.apex > 0 || c.strong > 0) {
      const slug = idToSlug.get(fighterId);
      if (slug) rankedEligibleSlugs.add(slug);
    }
    apexOrStrongBySlug.set(idToSlug.get(fighterId) ?? "", c.apex + c.strong);
  }
  console.log(`  ${rankedEligibleSlugs.size} fighters have >= 1 apex/strong win`);

  // -------- Pass 2: resolve "ranked" wins. Re-runs classify() so Fix 3
  // (title-fight-participation fallback) sees the full ranked-eligible set
  // before deciding.
  console.log("Pass 2: resolving ranked wins...");
  for (const [fighterId, c] of counts) {
    const fighterSlug = idToSlug.get(fighterId) ?? "";
    for (const b of c.pending) {
      const opponentBouts = byFighter.get(b.opponent_id) ?? [];
      const tier = classify(
        fighterSlug,
        b.bout_id,
        b.date,
        b.opponent_slug,
        opponentBouts,
        rankedEligibleSlugs,
      );
      if (tier === "ranked") c.ranked += 1;
    }
  }

  // -------- Write back
  console.log("Writing fighter rows...");
  const updates: Array<{
    id: string;
    apex: number;
    strong: number;
    solid: number;
    legacy: number;
    ranked: number;
    score: number;
  }> = [];
  for (const [fighterId, c] of counts) {
    const score = Math.min(
      100,
      c.apex * 25 + c.strong * 15 + c.solid * 8 + c.legacy * 4 + c.ranked * 3,
    );
    updates.push({
      id: fighterId,
      apex: c.apex,
      strong: c.strong,
      solid: c.solid,
      legacy: c.legacy,
      ranked: c.ranked,
      score,
    });
  }

  // Single batched UPDATE via VALUES table — 2700 row roundtrip in one shot.
  // First zero everyone so fighters that disappeared from the bout table
  // (none expected) get reset.
  await sql`
    UPDATE fighter SET
      apex_wins = 0,
      strong_wins = 0,
      solid_wins = 0,
      legacy_wins = 0,
      ranked_wins = 0,
      quality_wins_score = 0
  `;

  // Chunked UPDATEs via unnest-of-arrays so postgres-js sends typed arrays
  // instead of stringly-typed VALUES rows (which fail the int column check).
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const ids = slice.map((u) => u.id);
    const apex = slice.map((u) => u.apex);
    const strong = slice.map((u) => u.strong);
    const solid = slice.map((u) => u.solid);
    const legacy = slice.map((u) => u.legacy);
    const ranked = slice.map((u) => u.ranked);
    const score = slice.map((u) => u.score);
    await sql`
      UPDATE fighter f SET
        apex_wins = v.apex,
        strong_wins = v.strong,
        solid_wins = v.solid,
        legacy_wins = v.legacy,
        ranked_wins = v.ranked,
        quality_wins_score = v.score
      FROM (
        SELECT
          UNNEST(${ids}::uuid[])   AS id,
          UNNEST(${apex}::int[])   AS apex,
          UNNEST(${strong}::int[]) AS strong,
          UNNEST(${solid}::int[])  AS solid,
          UNNEST(${legacy}::int[]) AS legacy,
          UNNEST(${ranked}::int[]) AS ranked,
          UNNEST(${score}::int[])  AS score
      ) AS v
      WHERE f.id = v.id
    `;
  }

  console.log(`Updated ${updates.length} fighters.`);

  // Quick sanity print
  const sanity = await sql<Array<{
    name_en: string;
    apex_wins: number;
    strong_wins: number;
    solid_wins: number;
    legacy_wins: number;
    ranked_wins: number;
    quality_wins_score: number;
  }>>`
    SELECT name_en, apex_wins, strong_wins, solid_wins, legacy_wins, ranked_wins, quality_wins_score
    FROM fighter
    WHERE slug IN (
      'islam-makhachev-275aca',
      'jon-jones-07f72a',
      'georges-st-pierre-6506c1',
      'khabib-nurmagomedov-032cc3',
      'anderson-silva-1f4543',
      'neil-magny-2dca84',
      'donald-cerrone-1d0075',
      'jim-miller-d19415',
      'demian-maia-427b59'
    )
    ORDER BY quality_wins_score DESC
  `;
  console.log("\nSanity check:");
  console.log("  name                       apex strong solid legacy ranked | score");
  console.log("  " + "-".repeat(67));
  for (const r of sanity) {
    console.log(
      `  ${r.name_en.padEnd(26)} ${String(r.apex_wins).padStart(4)} ${String(r.strong_wins).padStart(6)} ${String(r.solid_wins).padStart(5)} ${String(r.legacy_wins).padStart(6)} ${String(r.ranked_wins).padStart(6)} | ${String(r.quality_wins_score).padStart(5)}`,
    );
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
