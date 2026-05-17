/**
 * Wave 14A: materialize per-(fighter, division) current_score into
 * fighter_divisional_score.
 *
 * Pipeline:
 *   1. Read fighter_divisional_vertex_score view (one row per (fighter,
 *      division) where bouts_in_division ≥ 3, with everything except CP).
 *   2. Compute avg_opp_tier_last_5 IN THIS DIVISION via a separate SQL
 *      query (used for the divisional_current_cp opp bonus).
 *   3. Per row, compute:
 *        - divisional_cp: championship-history.ts scoped to the division
 *          (sticky-100 rule applies the same way as the global pedigree).
 *        - divisional_current_cp: Wave 12 V4c time-decay + Wave 12 opp
 *          bonus applied to the divisional base CP.
 *        - raw_current: view.raw_current_excl_cp + divisional_current_cp
 *          × 0.10, floored at 0.
 *        - multiplied_current: Wave 15.1 curve (≥60 ×1.50 / ≥45 ×1.45 /
 *          ≥25 ×1.30 / <25 ×1.0), clamped at 100.
 *        - vertex_score: multiplied_current minus 25 if losses_last_3 ≥
 *          3 (skid penalty), clamped at 0..100.
 *        - divisional_status: 'current' / 'provisional' / 'former' (see
 *          below).
 *   4. TRUNCATE + chunked INSERT into fighter_divisional_score.
 *
 * divisional_status precedence:
 *   - 'current'     iff roster_status='active' AND
 *                   fighter.current_division = division AND
 *                   last bout in division ≤24mo AND ≥5 bouts in division
 *   - 'provisional' iff same active criteria but 3-4 bouts in division
 *                   (active in this division but sample size too small)
 *   - 'former'      iff none of the above (retired, released, moved
 *                   divisions, or lapsed > 24mo in this division)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import {
  getChampionshipReigns,
  type ChampionshipReign,
  type WeightClass,
} from "../src/lib/championship-history";
import { TITLE_CHALLENGES } from "../src/lib/title-challenger-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

const TODAY = process.env.TODAY ? new Date(process.env.TODAY) : new Date();
const STICKY_BOUND_MONTHS = 36;

const CHAMPIONSHIP_DIVISIONS = new Set<string>([
  "strawweight",
  "flyweight",
  "bantamweight",
  "featherweight",
  "lightweight",
  "welterweight",
  "middleweight",
  "light_heavyweight",
  "heavyweight",
]);

/** Per-(slug, division) lost-title-challenger count. */
function lostTitleChallengesInDivision(slug: string, division: string): number {
  return TITLE_CHALLENGES.filter(
    (c) => c.slug === slug && c.weightClass === division && c.result === "lost",
  ).length;
}

/** Reigns for a fighter restricted to one weight class. */
function reignsInDivision(slug: string, division: string): ChampionshipReign[] {
  return getChampionshipReigns(slug).filter((r) => r.weightClass === division);
}

/**
 * Divisional base CP — mirrors compute_championship_pedigree.ts'
 * pedigreeFor() but restricted to one division.
 *
 *   100 → current undisputed champ in this division
 *   100 sticky → vacated/stripped reign in this division within 36mo +
 *                fighter hasn't fought (in this division) since
 *    90 → current interim-only in this division
 *    80 → former undisputed in this division (lost belt or sticky expired)
 *    70 → former interim-only in this division
 *    40 → lost a title fight in this division, never won one here
 *     0 → never held a title or challenged in this division
 */
function divisionalBaseCp(
  slug: string,
  division: string,
  lastBoutDateInDivision: string | null,
): number {
  // Catchweight / openweight / strawweight (men) — no championship reigns
  // possible. Return 0 short-circuit so we don't accidentally credit
  // someone's reign from a different division.
  if (!CHAMPIONSHIP_DIVISIONS.has(division)) return 0;

  const reigns = reignsInDivision(slug, division);
  const interimOnly =
    reigns.length > 0 && reigns.every((r) => r.isInterim === true);
  const hasCurrentReign = reigns.some((r) => r.endDate === null);

  if (hasCurrentReign) return interimOnly ? 90 : 100;

  if (reigns.length > 0) {
    if (interimOnly) return 70;
    // Sticky-100 check (Wave 6E.2 + 13.1 36mo bound) — most recent closed
    // reign in this division. Vacated/stripped + within 36mo + fighter
    // hasn't fought in this division since → still 100.
    const closed = reigns
      .filter((r) => r.endDate != null)
      .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""));
    if (closed.length > 0) {
      const recent = closed[0];
      if (
        recent.endReason === "vacated" ||
        recent.endReason === "stripped"
      ) {
        const monthsSince =
          (TODAY.getTime() - new Date(recent.endDate!).getTime()) /
          (30.44 * 86_400_000);
        if (
          monthsSince <= STICKY_BOUND_MONTHS &&
          (lastBoutDateInDivision == null ||
            lastBoutDateInDivision <= recent.endDate!)
        ) {
          return 100;
        }
      }
    }
    return 80;
  }

  // No reigns in this division — check for lost title challenges here.
  if (lostTitleChallengesInDivision(slug, division) > 0) return 40;

  return 0;
}

/** Wave 12 V4c time-decay applied to former-champion base CP (80 or 70). */
function timeDecayedCp(baseCp: 80 | 70, yearsSince: number): number {
  if (baseCp === 80) {
    if (yearsSince < 3) return 80 - (30 * yearsSince) / 3;
    if (yearsSince < 8) return 50 - (25 * (yearsSince - 3)) / 5;
    return 25;
  }
  // baseCp === 70 — former interim-only (V4c fast decay).
  if (yearsSince < 1) return 70;
  if (yearsSince < 3) return 70 - (45 * (yearsSince - 1)) / 2;
  return 25;
}

function oppBonus(avgTier: number | null): number {
  if (avgTier == null) return 0;
  if (avgTier >= 18) return 20;
  if (avgTier >= 10) return 12;
  if (avgTier >= 5) return 5;
  return 0;
}

/**
 * Divisional current_cp — applies time-decay + opp-bonus to former-champ
 * buckets in this division. Pass-through for 100/90/40/0.
 *
 * Note: compute_current_cp.ts in the global pipeline returns NULL for
 * non-active fighters. For divisional we always return a numeric value
 * (0 when no reigns in this division) — the divisional row may exist
 * for a former champ no longer rostered, and we want auditable CP
 * contribution.
 */
function divisionalCurrentCp(
  slug: string,
  division: string,
  baseCp: number,
  avgOppTierLast5: number | null,
): number {
  if (baseCp === 100 || baseCp === 90 || baseCp === 40 || baseCp === 0) {
    return baseCp;
  }
  if (baseCp !== 80 && baseCp !== 70) return baseCp;

  // Find the most recent CLOSED reign in this division for the time-
  // decay anchor.
  const reigns = reignsInDivision(slug, division);
  const closed = reigns
    .filter((r) => r.endDate != null)
    .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""));
  if (closed.length === 0 || !closed[0].endDate) return baseCp;

  const yearsSince =
    (TODAY.getTime() - new Date(closed[0].endDate).getTime()) /
    (365.25 * 86_400_000);
  const decayed = timeDecayedCp(baseCp as 80 | 70, yearsSince);
  const bonus = oppBonus(avgOppTierLast5);
  return Math.min(baseCp, Math.round(decayed + bonus));
}

/** Wave 15.1 soft-multiplier curve. */
function applyCurve(raw: number): number {
  if (raw < 25) return Math.min(100, Math.round(raw * 1.0));
  if (raw < 45) return Math.min(100, Math.round(raw * 1.3));
  if (raw < 60) return Math.min(100, Math.round(raw * 1.45));
  return Math.min(100, Math.round(raw * 1.5));
}

interface ViewRow {
  fighter_id: string;
  slug: string;
  gender: string;
  division: string;
  roster_status: string;
  fighter_current_division: string | null;
  has_upcoming_bout: boolean;
  bouts_in_division: number;
  ufc_wins: number;
  ufc_losses: number;
  last_fight_date_in_division: string | null;
  is_active_in_division: boolean;
  losses_last_3: number;
  losses_last_5: number;
  losses_24mo: number;
  quality_wins_decayed: number;
  era_dominance_current: number;
  had_title_fight_recently: boolean;
  recent_form_score: number;
  activity: number;
  recent_loss_penalty: number;
  performance_diff_current: number;
  finishing_dominance_decayed: number;
  raw_current_excl_cp: number;
}

interface OppTierRow {
  fighter_id: string;
  division: string;
  avg_opp_tier_last_5: number | null;
}

async function main() {
  console.log("Loading divisional view rows...");
  const rows = await sql<ViewRow[]>`
    SELECT
      fighter_id::text,
      slug,
      gender,
      division::text,
      roster_status,
      fighter_current_division,
      has_upcoming_bout,
      bouts_in_division,
      ufc_wins,
      ufc_losses,
      last_fight_date_in_division::text,
      is_active_in_division,
      losses_last_3,
      losses_last_5,
      losses_24mo,
      quality_wins_decayed,
      era_dominance_current,
      had_title_fight_recently,
      recent_form_score,
      activity,
      recent_loss_penalty,
      performance_diff_current,
      finishing_dominance_decayed,
      raw_current_excl_cp
    FROM fighter_divisional_vertex_score
  `;
  console.log(`  ${rows.length} (fighter, division) rows`);

  console.log("Loading per-(fighter, division) avg_opp_tier_last_5...");
  const oppRows = await sql<OppTierRow[]>`
    WITH ranked AS (
      SELECT
        bot.fighter_id,
        b.weight_class::text AS division,
        bot.opp_tier_value,
        ROW_NUMBER() OVER (
          PARTITION BY bot.fighter_id, b.weight_class
          ORDER BY e.date DESC, b.id DESC
        ) AS rn
      FROM bout_opponent_tier bot
      JOIN bout b ON b.id = bot.bout_id
      JOIN event e ON e.id = b.event_id
      WHERE b.status = 'completed'
    )
    SELECT
      fighter_id::text,
      division,
      AVG(opp_tier_value::float)::float AS avg_opp_tier_last_5
    FROM ranked
    WHERE rn <= 5
    GROUP BY fighter_id, division
  `;
  const oppMap = new Map<string, number | null>();
  for (const r of oppRows) {
    oppMap.set(`${r.fighter_id}|${r.division}`, r.avg_opp_tier_last_5);
  }
  console.log(`  ${oppRows.length} (fighter, division) opp-tier rows`);

  // Wave 14B.1: scheduled bouts per fighter, used by inActiveRanking.
  // A fighter with a scheduled bout in division X is treated as
  // "ranking-eligible" in X even if their stored current_division
  // is something else (handles cases where current_division was set
  // from the previous bout and the upcoming bout is in a new division).
  console.log("Loading scheduled bouts...");
  const scheduledBouts = await sql<
    Array<{ fighter_id: string; weight_class: string }>
  >`
    SELECT fighter_a_id::text AS fighter_id, weight_class::text
    FROM bout WHERE status = 'scheduled' AND fighter_a_id IS NOT NULL
    UNION ALL
    SELECT fighter_b_id::text AS fighter_id, weight_class::text
    FROM bout WHERE status = 'scheduled' AND fighter_b_id IS NOT NULL
  `;
  const scheduledSet = new Set(
    scheduledBouts.map((b) => `${b.fighter_id}:${b.weight_class}`),
  );
  console.log(`  ${scheduledBouts.length} (fighter, division) scheduled-bout entries`);

  // Wave 14B.1: primary current division per fighter. Falls back to
  // weight_class_primary when current_division is NULL (Wave 7A
  // compute_current_division.ts populates current_division from the
  // last bout's weight_class).
  console.log("Loading primary divisions...");
  const primaryDivisions = await sql<
    Array<{ id: string; primary_division: string | null }>
  >`
    SELECT
      id::text AS id,
      COALESCE(current_division::text, weight_class_primary::text) AS primary_division
    FROM fighter
  `;
  const primaryDivByFighterId = new Map<string, string | null>();
  for (const f of primaryDivisions) {
    primaryDivByFighterId.set(f.id, f.primary_division);
  }
  console.log(`  ${primaryDivisions.length} fighter primary-division entries`);

  type UpsertRow = {
    fighter_id: string;
    division: string;
    raw_current: number;
    multiplied_current: number;
    vertex_score: number;
    bouts_in_division: number;
    last_bout_date_in_division: string | null;
    divisional_status: string;
    quality_wins_decayed: number;
    divisional_cp: number;
    divisional_current_cp: number;
    era_dominance_current: number;
    performance_diff_current: number;
    finishing_dominance_decayed: number;
    activity: number;
    recent_form_score: number;
    recent_loss_penalty: number;
    in_active_ranking: boolean;
  };
  const upserts: UpsertRow[] = [];

  for (const r of rows) {
    const baseCp = divisionalBaseCp(
      r.slug,
      r.division,
      r.last_fight_date_in_division,
    );
    const avgOpp = oppMap.get(`${r.fighter_id}|${r.division}`) ?? null;
    const currentCp = divisionalCurrentCp(
      r.slug,
      r.division,
      baseCp,
      avgOpp,
    );

    const rawCurrent = Math.max(
      0,
      Number(r.raw_current_excl_cp) + currentCp * 0.1,
    );
    const multiplied = applyCurve(rawCurrent);
    const skidPenalty = r.losses_last_3 >= 3 ? 25 : 0;
    const vertexScore = Math.max(0, Math.min(100, multiplied - skidPenalty));

    // Status precedence: 'current' / 'provisional' beat 'former' only
    // when the fighter is active in this exact division with a recent
    // bout. The view's is_active_in_division flag captures
    // (roster_status='active' AND last_bout ≤24mo); we additionally
    // require fighter.current_division = division so that a fighter who
    // moved up but has recent bouts in their old division is 'former' in
    // the old one and 'current'/'provisional' in the new one.
    const isInThisDivisionNow =
      r.is_active_in_division && r.fighter_current_division === r.division;
    let status: "current" | "provisional" | "former";
    if (isInThisDivisionNow) {
      status = r.bouts_in_division >= 5 ? "current" : "provisional";
    } else {
      status = "former";
    }

    // Wave 14B.1: ranking-display eligibility.
    //
    //   (roster_status='active' AND primaryDiv === division)
    //                                  → fighter is currently competing
    //                                    in this division per stored
    //                                    current_division / weight_class
    //                                    fallback AND is on the UFC
    //                                    active roster. The roster gate
    //                                    is required because
    //                                    compute_current_division.ts
    //                                    populates current_division from
    //                                    each fighter's most recent bout
    //                                    regardless of roster_status, so
    //                                    retired/released fighters would
    //                                    otherwise carry a stale "primary
    //                                    division" forward into active
    //                                    rankings.
    //   scheduledSet has (fighter, div) → upcoming bout overrides
    //                                    stored primary_division
    //                                    (cross-division move signal).
    //                                    Implies the bout is on the
    //                                    schedule, so no separate
    //                                    roster gate needed.
    const primaryDiv = primaryDivByFighterId.get(r.fighter_id) ?? null;
    const inActiveRanking =
      (r.roster_status === "active" && primaryDiv === r.division) ||
      scheduledSet.has(`${r.fighter_id}:${r.division}`);

    upserts.push({
      fighter_id: r.fighter_id,
      division: r.division,
      raw_current: rawCurrent,
      multiplied_current: multiplied,
      vertex_score: vertexScore,
      bouts_in_division: r.bouts_in_division,
      last_bout_date_in_division: r.last_fight_date_in_division,
      divisional_status: status,
      quality_wins_decayed: Number(r.quality_wins_decayed),
      divisional_cp: baseCp,
      divisional_current_cp: currentCp,
      era_dominance_current: Number(r.era_dominance_current),
      performance_diff_current: Number(r.performance_diff_current),
      finishing_dominance_decayed: Number(r.finishing_dominance_decayed),
      activity: Number(r.activity),
      recent_form_score: r.recent_form_score,
      recent_loss_penalty: Number(r.recent_loss_penalty),
      in_active_ranking: inActiveRanking,
    });
  }

  console.log(`Computed ${upserts.length} rows. Writing...`);
  await sql`TRUNCATE TABLE fighter_divisional_score RESTART IDENTITY`;

  // Chunked UNNEST insert.
  const CHUNK = 500;
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const slice = upserts.slice(i, i + CHUNK);
    await sql`
      INSERT INTO fighter_divisional_score (
        fighter_id, division, raw_current, multiplied_current, vertex_score,
        bouts_in_division, last_bout_date_in_division, divisional_status,
        quality_wins_decayed, divisional_cp, divisional_current_cp,
        era_dominance_current, performance_diff_current,
        finishing_dominance_decayed, activity, recent_form_score,
        recent_loss_penalty, in_active_ranking
      )
      SELECT
        UNNEST(${slice.map((u) => u.fighter_id)}::uuid[]),
        UNNEST(${slice.map((u) => u.division)}::weight_class[]),
        UNNEST(${slice.map((u) => u.raw_current)}::float8[]),
        UNNEST(${slice.map((u) => u.multiplied_current)}::int[]),
        UNNEST(${slice.map((u) => u.vertex_score)}::int[]),
        UNNEST(${slice.map((u) => u.bouts_in_division)}::int[]),
        UNNEST(${slice.map((u) => u.last_bout_date_in_division)}::date[]),
        UNNEST(${slice.map((u) => u.divisional_status)}::text[]),
        UNNEST(${slice.map((u) => u.quality_wins_decayed)}::float8[]),
        UNNEST(${slice.map((u) => u.divisional_cp)}::int[]),
        UNNEST(${slice.map((u) => u.divisional_current_cp)}::int[]),
        UNNEST(${slice.map((u) => u.era_dominance_current)}::float8[]),
        UNNEST(${slice.map((u) => u.performance_diff_current)}::float8[]),
        UNNEST(${slice.map((u) => u.finishing_dominance_decayed)}::float8[]),
        UNNEST(${slice.map((u) => u.activity)}::float8[]),
        UNNEST(${slice.map((u) => u.recent_form_score)}::int[]),
        UNNEST(${slice.map((u) => u.recent_loss_penalty)}::float8[]),
        UNNEST(${slice.map((u) => (u.in_active_ranking ? "t" : "f"))}::text[])::boolean
    `;
  }

  // Status distribution.
  const statusDist = await sql<Array<{ s: string; c: number }>>`
    SELECT divisional_status AS s, COUNT(*)::int AS c
    FROM fighter_divisional_score
    GROUP BY divisional_status
    ORDER BY c DESC
  `;
  console.log("\nStatus distribution:");
  for (const r of statusDist) {
    console.log(`  ${r.s.padEnd(12)} ${String(r.c).padStart(5)}`);
  }

  // Wave 14B.1: ranking-eligibility distribution by status.
  const rankingDist = await sql<
    Array<{ s: string; iar: boolean; c: number }>
  >`
    SELECT divisional_status AS s, in_active_ranking AS iar, COUNT(*)::int AS c
    FROM fighter_divisional_score
    GROUP BY divisional_status, in_active_ranking
    ORDER BY in_active_ranking DESC, divisional_status
  `;
  console.log("\nin_active_ranking by status:");
  for (const r of rankingDist) {
    console.log(
      `  ${r.iar ? "TRUE " : "FALSE"}  ${r.s.padEnd(12)} ${String(r.c).padStart(5)}`,
    );
  }

  // Spot-check Pereira, Holloway, Sterling.
  const spot = await sql<Array<{
    name_en: string;
    division: string;
    vertex_score: number;
    bouts_in_division: number;
    divisional_status: string;
    divisional_cp: number;
    divisional_current_cp: number;
  }>>`
    SELECT
      f.name_en,
      fds.division::text,
      fds.vertex_score,
      fds.bouts_in_division,
      fds.divisional_status,
      fds.divisional_cp,
      fds.divisional_current_cp
    FROM fighter_divisional_score fds
    JOIN fighter f ON f.id = fds.fighter_id
    WHERE f.slug IN (
      'alex-pereira-e5549c',
      'max-holloway-150ff4',
      'aljamain-sterling-cb696e',
      'islam-makhachev-275aca',
      'ilia-topuria-54f64b',
      'conor-mcgregor-f4c499',
      'jon-jones-07f72a'
    )
    ORDER BY f.name_en, fds.division
  `;
  console.log("\nSpot check (Pereira/Holloway/Sterling/Islam/Topuria/Conor/Jones):");
  console.log("  name                       div                cur  bouts  status        cp   cur_cp");
  console.log("  " + "-".repeat(86));
  for (const r of spot) {
    console.log(
      `  ${r.name_en.padEnd(26)} ${r.division.padEnd(18)} ${String(r.vertex_score).padStart(3)}  ${String(r.bouts_in_division).padStart(5)}  ${r.divisional_status.padEnd(12)} ${String(r.divisional_cp).padStart(3)}  ${String(r.divisional_current_cp).padStart(5)}`,
    );
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
