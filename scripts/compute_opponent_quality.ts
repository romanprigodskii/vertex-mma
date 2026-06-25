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
 *
 * Wave 6C.2: rank-at-bout-time added as a parallel tier source. For each
 * win we also look up the opponent's UFC.com/rankings rank at bout date
 * (within 4 weeks before) from ranking_snapshot. That yields a rank-tier
 * — top5_rank / top10_rank / top15_rank / none — which is compared to the
 * champion-tier and the higher-multiplier one wins. Pre-2017 bouts have no
 * snapshot data, so they get rank-tier "none" and rely on the (point-in-time)
 * champion-tier alone — the old fighter.peak_rank fallback was dropped because
 * peak_rank is the opponent's career-MAX rank (future info for an early-career
 * bout), a point-in-time leak into the simulation's vertex_score feature.
 * Rank=0 (champion slot) is intentionally ignored on the rank path so the
 * champion-tier remains the authoritative apex signal.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import {
  CHAMPIONSHIP_HISTORY,
  type ChampionshipReign,
  isFormerChampion,
} from "../src/lib/championship-history";
import { isCuratedTitleFight } from "../src/lib/title-fights";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

type Tier = "apex" | "strong" | "solid" | "legacy" | "ranked" | "none";
type RankTier = "top5" | "top10" | "top15" | "none";

// Wave 6C.3: rank-tier weights bumped (top5 15→22, top10 8→14, top15 4→8)
// to reflect the project principle that wins over actively-top contenders
// at bout date weigh more than wins over ex-champions long past their reign.
// Champion-tier weights (apex 25 / strong 15 / solid 8 / legacy 4 / ranked 3)
// remain locked.
const RANK_TIER_WEIGHT: Record<RankTier, number> = {
  top5: 22,
  top10: 14,
  top15: 8,
  none: 0,
};

const CHAMP_TIER_WEIGHT: Record<Tier, number> = {
  apex: 25,
  strong: 15,
  solid: 8,
  legacy: 4,
  ranked: 3,
  none: 0,
};

const RANKING_LOOKBACK_DAYS = 28;

/** Sorted-descending-by-date ranking snapshots per fighter_id. */
const rankByFighter = new Map<string, Array<{ date: Date; rank: number }>>();

/** rank-at-bout lookup. Returns null when no snapshot in window. */
function rankAtBout(opponentId: string, boutDate: Date): number | null {
  const snaps = rankByFighter.get(opponentId);
  if (!snaps) return null;
  const earliest = new Date(boutDate);
  earliest.setDate(earliest.getDate() - RANKING_LOOKBACK_DAYS);
  // snaps is sorted DESC by date, so the first entry with date <= boutDate
  // AND >= earliest is the answer.
  for (const s of snaps) {
    if (s.date > boutDate) continue;
    if (s.date < earliest) return null;
    return s.rank;
  }
  return null;
}

function rankToTier(rank: number | null): RankTier {
  if (rank === null) return "none";
  if (rank === 0) return "none"; // champion slot — defer to champion-tier
  if (rank <= 5) return "top5";
  if (rank <= 10) return "top10";
  if (rank <= 15) return "top15";
  return "none";
}

/** Returns (rankTier, source) for a given opponent at a given bout date.
 *  Point-in-time only: a rank-tier requires a ranking_snapshot at/just before
 *  the bout. Pre-2017 bouts have no snapshots → tier "none" (the champion-tier
 *  source, which IS point-in-time, still applies). The old fighter.peak_rank
 *  fallback was removed: peak_rank is the opponent's career-MAX rank, i.e.
 *  future info for an early-career bout — a leak into the sim's vertex_score. */
function classifyByRank(
  opponentId: string,
  boutDate: Date,
): { tier: RankTier; source: "snapshot" | "none" } {
  const snapRank = rankAtBout(opponentId, boutDate);
  if (snapRank !== null) {
    return { tier: rankToTier(snapRank), source: "snapshot" };
  }
  return { tier: "none", source: "none" };
}

interface BoutRecord {
  bout_id: string;
  date: Date;
  fighter_id: string;
  opponent_id: string;
  opponent_slug: string;
  fighter_won: boolean;
  /** True when winner_id is the opponent (real loss, distinct from draw/NC). */
  is_loss: boolean;
  /** Lowercase method, NULL when scraper didn't record. */
  method: string | null;
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

function classifyChampion(
  fighterSlug: string,
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

/** Combined classifier: returns the winning tier plus the rank-tier
 *  separately (so we can count top5/top10/top15 wins as a distinct
 *  signal even when champion-tier wins the multiplier comparison). */
function classify(
  fighterSlug: string,
  boutDate: Date,
  opponentId: string,
  opponentSlug: string,
  opponentBouts: BoutRecord[],
  rankedEligibleSlugs: Set<string> | null,
): { champ: Tier; rank: RankTier; effective: Tier | RankTier } {
  const champ = classifyChampion(
    fighterSlug,
    boutDate,
    opponentSlug,
    opponentBouts,
    rankedEligibleSlugs,
  );
  const { tier: rank } = classifyByRank(opponentId, boutDate);
  // Higher multiplier wins; ties favour champion-tier (higher-confidence).
  const effective =
    RANK_TIER_WEIGHT[rank] > CHAMP_TIER_WEIGHT[champ] ? rank : champ;
  return { champ, rank, effective };
}

async function main() {
  console.log("Loading ranking snapshots...");
  // ranking_snapshot grouped by fighter_id, sorted DESC by date for the
  // window-walk in rankAtBout. ranking_snapshot is already gender-separated by
  // its is_women column + the importer's filter, so each fighter_id maps to one
  // gender — no extra gender join is needed here.
  const snapRows = await sql<
    { fighter_id: string; date: Date; rank: number; is_women: boolean }[]
  >`
    SELECT fighter_id::text AS fighter_id,
           snapshot_date AS date,
           rank,
           is_women
    FROM ranking_snapshot
    WHERE fighter_id IS NOT NULL
    ORDER BY fighter_id, snapshot_date DESC
  `;
  console.log(`  ${snapRows.length} ranking_snapshot rows with fighter_id`);
  for (const r of snapRows) {
    const arr = rankByFighter.get(r.fighter_id) ?? [];
    arr.push({ date: r.date, rank: r.rank });
    rankByFighter.set(r.fighter_id, arr);
  }
  console.log(`  ${rankByFighter.size} fighters have ranking history`);

  console.log("Loading bouts...");
  const rows = await sql<BoutRecord[]>`
    SELECT
      b.id::text AS bout_id,
      e.date AS date,
      b.fighter_a_id::text AS fighter_id,
      b.fighter_b_id::text AS opponent_id,
      f_b.slug AS opponent_slug,
      (b.winner_id = b.fighter_a_id) AS fighter_won,
      (b.winner_id IS NOT NULL AND b.winner_id <> b.fighter_a_id) AS is_loss,
      LOWER(b.method::text) AS method
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
      (b.winner_id = b.fighter_b_id) AS fighter_won,
      (b.winner_id IS NOT NULL AND b.winner_id <> b.fighter_b_id) AS is_loss,
      LOWER(b.method::text) AS method
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
  console.log("Pass 1: classifying wins against champions + rank-tier...");
  type PerFighter = {
    apex: number;
    strong: number;
    solid: number;
    legacy: number;
    ranked: number;
    /** Wave 6C.2 rank-tier counters, tracked independently of the
     *  champion-tier counter even when the effective tier is champion. */
    top5: number;
    top10: number;
    top15: number;
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
      apex: 0, strong: 0, solid: 0, legacy: 0, ranked: 0,
      top5: 0, top10: 0, top15: 0,
      pending: [],
    };
    for (const b of bouts) {
      if (!b.fighter_won) continue;
      const opponentBouts = byFighter.get(b.opponent_id) ?? [];
      const { champ, rank, effective } = classify(
        fighterSlug,
        b.date,
        b.opponent_id,
        b.opponent_slug,
        opponentBouts,
        null,
      );
      // Champion-tier counter — uses the *effective* tier so a rank-tier
      // win doesn't double-count when it beats the champion-tier.
      switch (effective) {
        case "apex":   c.apex   += 1; break;
        case "strong": c.strong += 1; break;
        case "solid":  c.solid  += 1; break;
        case "legacy": c.legacy += 1; break;
        case "ranked": c.ranked += 1; break; // never in pass 1 (set null)
        case "top5":   c.top5   += 1; break;
        case "top10":  c.top10  += 1; break;
        case "top15":  c.top15  += 1; break;
        case "none":
          // Defer to pass 2 only when the champion-tier path was "none"
          // (rank-tier already had its shot above). If rank was also
          // none, the opponent is a non-champion non-ranked fighter who
          // may still resolve to "ranked" via the apex/strong-eligible
          // ledger in pass 2.
          if (champ === "none" && rank === "none") c.pending.push(b);
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
  // before deciding. Rank-tier was already counted in pass 1 — we only
  // upgrade pending "none" → "ranked" here.
  console.log("Pass 2: resolving ranked wins...");
  for (const [fighterId, c] of counts) {
    const fighterSlug = idToSlug.get(fighterId) ?? "";
    for (const b of c.pending) {
      const opponentBouts = byFighter.get(b.opponent_id) ?? [];
      const { effective } = classify(
        fighterSlug,
        b.date,
        b.opponent_id,
        b.opponent_slug,
        opponentBouts,
        rankedEligibleSlugs,
      );
      if (effective === "ranked") c.ranked += 1;
    }
  }

  // -------- Pass 3 (Wave 6E.4 Part A): persist per-bout opp_tier into the
  // bout_opponent_tier table for ALL completed bouts (wins AND losses). The
  // recent_bouts_window CTE in fighter_vertex_score (Part B) consumes this
  // to opp-adjust the last-5-bouts performance signals.
  //
  // We pass an empty fighter slug into classifyChampion so the "fighter is
  // active champion ⇒ apex" path (which credits champion title-defense
  // wins as apex regardless of challenger pedigree) does NOT fire here.
  // bout_opponent_tier is an opp-quality measure, not a bout-prestige one
  // — a champion's title defense vs an unranked challenger should record
  // the challenger's actual tier, not apex.
  console.log("Pass 3: computing per-bout opp_tier_value for bout_opponent_tier...");
  type BoutTierRow = {
    bout_id: string;
    fighter_id: string;
    value: number;
    label: string;
  };
  const boutTierRows: BoutTierRow[] = [];

  for (const [fighterId, bouts] of byFighter) {
    for (const b of bouts) {
      const opponentBouts = byFighter.get(b.opponent_id) ?? [];
      const champ = classifyChampion(
        "",
        b.date,
        b.opponent_slug,
        opponentBouts,
        rankedEligibleSlugs,
      );
      const { tier: rank } = classifyByRank(b.opponent_id, b.date);
      const champW = CHAMP_TIER_WEIGHT[champ];
      const rankW = RANK_TIER_WEIGHT[rank];
      const value = rankW > champW ? rankW : champW;
      const label = rankW > champW ? rank : champ;
      boutTierRows.push({
        bout_id: b.bout_id,
        fighter_id: fighterId,
        value,
        label,
      });
    }
  }
  console.log(`  ${boutTierRows.length} (bout, fighter) tier rows prepared`);

  // -------- Write back
  console.log("Writing fighter rows...");
  const updates: Array<{
    id: string;
    apex: number;
    strong: number;
    solid: number;
    legacy: number;
    ranked: number;
    top5: number;
    top10: number;
    top15: number;
    score: number;
    undefeated: number;
  }> = [];
  let bonusCount = 0;
  for (const [fighterId, c] of counts) {
    const baseScore = Math.min(
      100,
      c.apex * 25 + c.strong * 15 + c.solid * 8 + c.legacy * 4 + c.ranked * 3
        + c.top5 * 22 + c.top10 * 14 + c.top15 * 8,
    );

    // Wave 3.5 step 5F: undefeated champion bonus. +30 to QW (above the
    // normal 100 cap) when a champion has 8+ UFC wins and zero real UFC
    // losses. "Real" loss excludes DQ losses (Jon Jones's only career
    // UFC L was a DQ vs Hamill). isFormerChampion returns true for any
    // reign (active or ended) so the bonus targets fighters whose
    // unbeaten record actually means something.
    const allBouts = byFighter.get(fighterId) ?? [];
    const wins = allBouts.filter((b) => b.fighter_won).length;
    const realLosses = allBouts.filter((b) => {
      if (!b.is_loss) return false;
      const m = b.method ?? "";
      return !m.includes("dq") && !m.includes("disqualif");
    }).length;
    const slug = idToSlug.get(fighterId) ?? "";
    const eligible =
      realLosses === 0 && wins >= 8 && isFormerChampion(slug);
    const undefeated = eligible ? 30 : 0;
    if (eligible) bonusCount += 1;

    updates.push({
      id: fighterId,
      apex: c.apex,
      strong: c.strong,
      solid: c.solid,
      legacy: c.legacy,
      ranked: c.ranked,
      top5: c.top5,
      top10: c.top10,
      top15: c.top15,
      score: baseScore + undefeated,
      undefeated,
    });
  }
  console.log(`Undefeated bonus awarded to ${bonusCount} fighters.`);

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
      top5_wins = 0,
      top10_wins = 0,
      top15_wins = 0,
      quality_wins_score = 0,
      undefeated_bonus = 0
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
    const top5 = slice.map((u) => u.top5);
    const top10 = slice.map((u) => u.top10);
    const top15 = slice.map((u) => u.top15);
    const score = slice.map((u) => u.score);
    const undefeated = slice.map((u) => u.undefeated);
    await sql`
      UPDATE fighter f SET
        apex_wins = v.apex,
        strong_wins = v.strong,
        solid_wins = v.solid,
        legacy_wins = v.legacy,
        ranked_wins = v.ranked,
        top5_wins = v.top5,
        top10_wins = v.top10,
        top15_wins = v.top15,
        quality_wins_score = v.score,
        undefeated_bonus = v.undefeated
      FROM (
        SELECT
          UNNEST(${ids}::uuid[])        AS id,
          UNNEST(${apex}::int[])        AS apex,
          UNNEST(${strong}::int[])      AS strong,
          UNNEST(${solid}::int[])       AS solid,
          UNNEST(${legacy}::int[])      AS legacy,
          UNNEST(${ranked}::int[])      AS ranked,
          UNNEST(${top5}::int[])        AS top5,
          UNNEST(${top10}::int[])       AS top10,
          UNNEST(${top15}::int[])       AS top15,
          UNNEST(${score}::int[])       AS score,
          UNNEST(${undefeated}::int[])  AS undefeated
      ) AS v
      WHERE f.id = v.id
    `;
  }

  console.log(`Updated ${updates.length} fighters.`);

  // Wave 6E.4 Part A: batched UPSERT into bout_opponent_tier. Truncate first
  // so a re-run with adjusted classification rules can't leave orphan rows
  // from bouts removed upstream. Same idempotency contract as the fighter
  // counter update above.
  await sql`TRUNCATE TABLE bout_opponent_tier`;
  const TIER_CHUNK = 1000;
  for (let i = 0; i < boutTierRows.length; i += TIER_CHUNK) {
    const slice = boutTierRows.slice(i, i + TIER_CHUNK);
    const boutIds = slice.map((r) => r.bout_id);
    const fighterIds = slice.map((r) => r.fighter_id);
    const values = slice.map((r) => r.value);
    const labels = slice.map((r) => r.label);
    await sql`
      INSERT INTO bout_opponent_tier (bout_id, fighter_id, opp_tier_value, opp_tier_label)
      SELECT
        UNNEST(${boutIds}::uuid[])    AS bout_id,
        UNNEST(${fighterIds}::uuid[]) AS fighter_id,
        UNNEST(${values}::int[])      AS opp_tier_value,
        UNNEST(${labels}::text[])     AS opp_tier_label
      ON CONFLICT (bout_id, fighter_id) DO UPDATE
        SET opp_tier_value = EXCLUDED.opp_tier_value,
            opp_tier_label = EXCLUDED.opp_tier_label
    `;
  }
  const [{ count: tierRowCount }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bout_opponent_tier
  `;
  console.log(`bout_opponent_tier now has ${tierRowCount} rows.`);

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
