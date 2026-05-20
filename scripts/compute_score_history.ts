/**
 * Wave 31.7 — per-bout vertex_score replay.
 *
 * For each fighter with ≥3 completed UFC bouts, iterate chronologically.
 * At each bout B (anchor), compute the vertex_score the fighter would
 * have had AS OF B.event_date — using only data from bouts up to and
 * including B. Insert one row per (fighter, anchor bout) into
 * fighter_score_history.
 *
 * Mirrors the Wave 31 formula from migration 0068:
 *   raw_current = (
 *       qw_decayed × 0.16 + cp × 0.10 + era × 0.06 + perf × 0.16
 *     + finishing_decayed × 0.10 + activity × 0.12 + form × 0.18
 *     - rlp × 0.20 - dv × 0.10 - layoff
 *   ) × (1 + age_factor)
 *   multiplied = re-anchored curve (88→100 cap)
 *   vertex_score = multiplied - skid - fresh_loss
 *
 * Components replicate the SQL view as faithfully as possible:
 *   - opp_tier_value: read from bout_opponent_tier (already date-anchored)
 *   - is_title_fight: from bout.is_title_fight
 *   - method: from bout.method
 *   - finish detection: ko%/tko%/sub% match or NULL method + KD/sub_attempts
 *   - decay_factor: piecewise linear over years (1.0/0.3/0.1)
 *   - All cumulative stats (slpm, sapm, td_def, str_def, kd_received)
 *     recomputed from bout_round_stats summed up to anchor date.
 *
 * Resets the table before populating, so a re-run is the single source
 * of truth. Print top-30 peak rankings at end as sanity check.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { install as installDnsFallback } from "../src/lib/dns-fallback";
installDnsFallback();
import postgres from "postgres";

import {
  CHAMPIONSHIP_HISTORY,
  type ChampionshipReign,
} from "../src/lib/championship-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 5 });

// =====================================================================
// Types
// =====================================================================

interface BoutRow {
  fighter_id: string;
  fighter_slug: string;
  fighter_dob: string | null;
  bout_id: string;
  event_date: string; // ISO yyyy-mm-dd
  weight_class: string;
  is_title_fight: boolean;
  method: string | null;
  round_finished: number | null;
  time_finished_seconds: number | null;
  scheduled_rounds: number;
  opp_id: string | null;
  is_win: boolean | null; // null when no winner (draw / NC)
  is_no_contest: boolean;
  opp_tier_value: number;
  // Fighter side per-bout aggregated stats (from bout_round_stats)
  f_sig_landed: number;
  f_sig_attempted: number;
  f_td_landed: number;
  f_td_attempted: number;
  f_control_seconds: number;
  f_knockdowns: number;
  f_sub_attempts: number;
  // Opponent side per-bout aggregated stats
  o_sig_landed: number; // sig strikes opp landed = sapm input
  o_sig_attempted: number;
  o_td_landed: number;
  o_td_attempted: number;
  o_control_seconds: number;
  o_knockdowns: number; // KDs absorbed by us
  o_sub_attempts: number;
}

interface AnchorRow {
  fighter_id: string;
  as_of_bout_id: string;
  as_of_date: string;
  vertex_score: number;
  raw_current: number;
}

// =====================================================================
// Helpers — dates
// =====================================================================

function parseDate(s: string): Date {
  // Postgres `date::text` returns either "YYYY-MM-DD" or
  // "YYYY-MM-DD 00:00:00+00" depending on driver options. Strip anything
  // after the first 10 chars (the date portion) and use UTC midnight so
  // the result is timezone-stable.
  return new Date(s.slice(0, 10) + "T00:00:00Z");
}

function yearsBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / (365.25 * 86400 * 1000);
}

function monthsBetween(later: Date, earlier: Date): number {
  return yearsBetween(later, earlier) * 12;
}

// =====================================================================
// Helpers — finish detection (mirrors view)
// =====================================================================

function isFinishMethod(b: BoutRow): boolean {
  const m = (b.method ?? "").toLowerCase();
  if (m.startsWith("ko") || m.startsWith("tko") || m.startsWith("sub")) return true;
  if (b.method == null && b.f_knockdowns > 0) return true;
  if (b.method == null && b.f_sub_attempts > 0) return true;
  return false;
}

function isNoContest(b: BoutRow): boolean {
  return (
    b.is_no_contest ||
    (b.method != null && b.method.toLowerCase().includes("no_contest"))
  );
}

function boutFightSeconds(b: BoutRow): number {
  if (b.round_finished == null) return (b.scheduled_rounds ?? 3) * 300;
  return (b.round_finished - 1) * 300 + (b.time_finished_seconds ?? 300);
}

// =====================================================================
// Helpers — decay (mirrors view)
// =====================================================================

function decayFactor(yearsAgo: number): number {
  let v: number;
  if (yearsAgo <= 1.0) v = 1.0;
  else if (yearsAgo <= 3.0) v = 1.0 - 0.7 * ((yearsAgo - 1.0) / 2.0);
  else if (yearsAgo <= 5.0) v = 0.3 - 0.2 * ((yearsAgo - 3.0) / 2.0);
  else v = 0.1;
  return Math.max(0.1, Math.min(1.0, v));
}

// =====================================================================
// Component: quality_wins_decayed (cap 100)
// =====================================================================

function computeQualityWinsDecayed(
  bouts: BoutRow[],
  asOfDate: Date,
): number {
  let sum = 0;
  for (const b of bouts) {
    if (b.is_win !== true) continue;
    const y = yearsBetween(asOfDate, parseDate(b.event_date));
    sum += b.opp_tier_value * decayFactor(y);
  }
  return Math.min(100, sum);
}

// =====================================================================
// Component: finishing_dominance_decayed (Wave 21 opp-tier weighted)
// =====================================================================

function computeFinishingDomDecayed(
  bouts: BoutRow[],
  asOfDate: Date,
): number {
  let denom = 0;
  let numer = 0;
  for (const b of bouts) {
    if (b.is_win !== true) continue;
    const y = yearsBetween(asOfDate, parseDate(b.event_date));
    const df = decayFactor(y);
    const w = df * Math.max(b.opp_tier_value, 1);
    denom += w;
    if (isFinishMethod(b)) numer += w;
  }
  if (denom === 0) return 0;
  return 100.0 * (numer / denom);
}

// =====================================================================
// Component: recent_form (Wave 31 recency-weighted)
// =====================================================================

const FORM_WEIGHTS = [2.0, 1.5, 1.0, 0.75, 0.5];

function computeRecentForm(
  recentBouts: BoutRow[],
): number {
  if (recentBouts.length === 0) return 50;
  let wcSum = 0;
  let wSum = 0;
  recentBouts.slice(0, 5).forEach((b, idx) => {
    const w = FORM_WEIGHTS[idx];
    let contrib = 0;
    if (isNoContest(b)) contrib = 0;
    else if (b.is_win === null) contrib = 0;
    else if (b.is_win) contrib = b.opp_tier_value;
    else {
      let sev: number;
      const t = b.opp_tier_value;
      if (t >= 25) sev = 0.30;
      else if (t >= 22) sev = 0.45;
      else if (t >= 14) sev = 0.60;
      else if (t >= 8) sev = 0.75;
      else if (t >= 3) sev = 0.90;
      else sev = 1.00;
      contrib = -t * sev;
    }
    wcSum += contrib * w;
    wSum += w;
  });
  if (wSum === 0) return 50;
  const mean = wcSum / wSum;
  return Math.max(0, Math.min(100, Math.round(50 + mean * 1.5)));
}

// =====================================================================
// Component: activity (layered max over 12/24/36mo windows)
// =====================================================================

function computeActivity(
  bouts: BoutRow[],
  asOfDate: Date,
): number {
  const counts = { 12: 0, 24: 0, 36: 0 };
  const tierSums = { 12: 0, 24: 0, 36: 0 };
  for (const b of bouts) {
    const m = monthsBetween(asOfDate, parseDate(b.event_date));
    if (m <= 12) {
      counts[12]++;
      tierSums[12] += b.opp_tier_value;
    }
    if (m <= 24) {
      counts[24]++;
      tierSums[24] += b.opp_tier_value;
    }
    if (m <= 36) {
      counts[36]++;
      tierSums[36] += b.opp_tier_value;
    }
  }
  const avg12 = counts[12] > 0 ? tierSums[12] / counts[12] : 0;
  const avg24 = counts[24] > 0 ? tierSums[24] / counts[24] : 0;
  const avg36 = counts[36] > 0 ? tierSums[36] / counts[36] : 0;
  const layer12 = Math.min(100, (counts[12] * avg12) / 60 * 100);
  const layer24 = Math.min(100, (counts[24] * avg24) / 120 * 100);
  const layer36 = Math.min(100, (counts[36] * avg36) / 180 * 100);
  return Math.max(layer12, layer24, layer36);
}

// =====================================================================
// Component: recent_loss_penalty (Wave 6E.4.4 severity-weighted)
// =====================================================================

function computeRecentLossPenalty(
  bouts: BoutRow[],
  asOfDate: Date,
): number {
  // bouts must be sorted by event_date DESC, then bout_id DESC
  let sev3 = 0;
  let sev5 = 0;
  let sev24 = 0;
  bouts.forEach((b, idx) => {
    const isLoss = b.is_win === false && !isNoContest(b);
    if (!isLoss) return;
    const severity = Math.max(0.3, Math.min(1.0, 1.0 - b.opp_tier_value / 30));
    if (idx < 3) sev3 += severity;
    if (idx < 5) sev5 += severity;
    const m = monthsBetween(asOfDate, parseDate(b.event_date));
    if (m <= 24) sev24 += severity;
  });
  return Math.min(100, Math.round(sev3 * 25 + sev5 * 12 + sev24 * 6));
}

// =====================================================================
// Component: era_dominance_current (title fights in 24mo / 36mo)
// =====================================================================

function computeEraDom(
  bouts: BoutRow[],
  asOfDate: Date,
): number {
  let tf24 = 0;
  let tf36 = 0;
  for (const b of bouts) {
    if (!b.is_title_fight) continue;
    const m = monthsBetween(asOfDate, parseDate(b.event_date));
    if (m <= 24) tf24++;
    if (m <= 36) tf36++;
  }
  const v = (tf24 >= 1 ? 5 : 0) + (tf36 >= 2 ? 5 : 0);
  return Math.min(10, v);
}

// =====================================================================
// Component: performance_diff_current (Wave 22 max + balance bonus)
// =====================================================================

function strikingDominance(b: BoutRow): number {
  const fs = boutFightSeconds(b);
  if (fs === 0) return 50;
  const v = 50 + ((b.f_sig_landed - b.o_sig_landed) * 60.0 / fs) * 20.0;
  return Math.max(0, Math.min(100, v));
}

function controlDominance(b: BoutRow): number {
  const fs = boutFightSeconds(b);
  if (fs === 0) return 50;
  const ctlPerMin = (b.f_control_seconds / fs) * 60;
  const v = 50 + (ctlPerMin - 15) * 2.6;
  return Math.max(0, Math.min(100, v));
}

function tdDominance(b: BoutRow): number {
  const fs = boutFightSeconds(b);
  if (fs === 0) return 50;
  const v = 50 + ((b.f_td_landed - b.o_td_landed) * 900.0 / fs) * 5.0;
  return Math.max(0, Math.min(100, v));
}

function adjustedDelta(b: BoutRow): number {
  const fs = boutFightSeconds(b);
  if (fs === 0) return 0;
  const strikingD = 50 + ((b.f_sig_landed - b.o_sig_landed) * 60.0 / fs) * 20.0;
  const clamped = Math.max(0, Math.min(100, strikingD));
  const tierBonus = Math.min(90.0, 50.0 + (50.0 - Math.min(50.0, b.opp_tier_value * 2.0)));
  return clamped - tierBonus;
}

function computePerfDiffCurrent(recentBouts: BoutRow[]): number {
  if (recentBouts.length === 0) return 50;
  const slice = recentBouts.slice(0, 5);
  const strDom = slice.map(strikingDominance);
  const ctlDom = slice.map(controlDominance);
  const tdDom = slice.map(tdDominance);
  const adjDelta = slice.map(adjustedDelta);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgStr = avg(strDom);
  const avgCtl = avg(ctlDom);
  const avgTd = avg(tdDom);
  const avgAdj = avg(adjDelta);
  const strikingDim = Math.max(0, Math.min(100, avgStr + avgAdj * 0.5));
  const controlDim = Math.max(0, Math.min(100, avgCtl + avgAdj * 0.3));
  const tdDim = Math.max(0, Math.min(100, avgTd));
  const maxD = Math.max(strikingDim, controlDim, tdDim);
  const minD = Math.min(strikingDim, controlDim, tdDim);
  const balance = maxD > 0 ? minD / maxD : 0;
  return Math.min(100, maxD * (1 + 0.25 * balance));
}

// =====================================================================
// Component: current_cp (championship pedigree at as_of_date)
// =====================================================================

function computeCurrentCp(
  slug: string,
  asOfDate: Date,
  recentBouts: BoutRow[],
): number {
  // Reigns for this fighter that started on/before asOfDate
  const reigns: ChampionshipReign[] = CHAMPIONSHIP_HISTORY.filter(
    (r) => r.slug === slug && parseDate(r.startDate) <= asOfDate,
  );
  if (reigns.length === 0) {
    // Lost-title-challenger bucket (40) requires title-challenger-history
    // import. Skipping for backfill — fighter.championship_pedigree column
    // already returns 40 in this case via compute_championship_pedigree;
    // for date-anchored replay we'd need TITLE_CHALLENGES filtered by
    // date. For simplicity, return 0 here (loses ~5 points of cp for
    // lost-challenger fighters; acceptable approximation).
    return 0;
  }
  // Active reign on as_of_date?
  const active = reigns.find(
    (r) => r.endDate == null || parseDate(r.endDate) > asOfDate,
  );
  if (active) return active.isInterim ? 90 : 100;
  // Former champ — find most-recent reign ended on or before asOfDate
  const closed = reigns
    .filter((r) => r.endDate != null && parseDate(r.endDate) <= asOfDate)
    .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""));
  if (closed.length === 0) return 0;
  const recent = closed[0];
  const allInterim = reigns.every((r) => r.isInterim === true);
  const baseCp: 80 | 70 = allInterim ? 70 : 80;
  const yearsSince = yearsBetween(asOfDate, parseDate(recent.endDate!));
  const decayed = timeDecayedCp(baseCp, yearsSince);
  // opp bonus from last 5 bouts up to asOfDate
  const last5 = recentBouts.slice(0, 5);
  const avgTier =
    last5.length > 0
      ? last5.reduce((a, b) => a + b.opp_tier_value, 0) / last5.length
      : null;
  const bonus = oppBonus(avgTier);
  return Math.min(baseCp, Math.round(decayed + bonus));
}

function timeDecayedCp(baseCp: 80 | 70, yearsSince: number): number {
  if (baseCp === 80) {
    if (yearsSince < 3) return 80 - (30 * yearsSince) / 3;
    if (yearsSince < 8) return 50 - (25 * (yearsSince - 3)) / 5;
    return 25;
  }
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

// =====================================================================
// Component: defensive_vulnerability (cumulative career stats)
// =====================================================================

interface CumulativeStats {
  sig_landed: number;
  opp_sig_landed: number; // sapm input
  opp_sig_attempted: number; // str_def input
  td_landed: number;
  opp_td_landed: number; // td_def input
  opp_td_attempted: number;
  opp_kd: number; // kd_received input
  fight_seconds: number;
  bout_count: number;
}

function defensiveVulnerability(c: CumulativeStats): number {
  if (c.fight_seconds === 0) return 0;
  const slpm = (c.sig_landed / c.fight_seconds) * 60;
  const sapm = (c.opp_sig_landed / c.fight_seconds) * 60;
  const tdAvg = (c.td_landed / c.fight_seconds) * 900;
  const tdDef =
    c.opp_td_attempted > 0 ? 1.0 - c.opp_td_landed / c.opp_td_attempted : 0.55;
  const strDef =
    c.opp_sig_attempted > 0
      ? 1.0 - c.opp_sig_landed / c.opp_sig_attempted
      : 0.55;
  const kdRecvPerFight = c.bout_count > 0 ? c.opp_kd / c.bout_count : 0;

  const strikerIntent = Math.min(1.0, slpm / 5.0);
  const wrestlerIntent = Math.min(1.0, tdAvg / 2.0);
  const tdDefWeakness = Math.max(0, 0.55 - tdDef) / 0.55;
  const strDefWeakness = Math.max(0, 0.55 - strDef) / 0.55;
  const sapmWeakness = Math.min(1.0, Math.max(0, sapm - 4) / 4);
  const kdRecvWeakness = Math.min(1.0, Math.max(0, kdRecvPerFight - 0.15) / 0.25);

  const v =
    100 *
    (strikerIntent * tdDefWeakness +
      wrestlerIntent *
        (strDefWeakness * 0.45 +
          sapmWeakness * 0.25 +
          kdRecvWeakness * 0.30));
  return Math.max(0, Math.min(100, v));
}

// =====================================================================
// Age + layoff
// =====================================================================

function ageFactor(dob: string | null, asOfDate: Date): number {
  if (!dob) return 0.0;
  const age = Math.floor(yearsBetween(asOfDate, parseDate(dob)));
  if (age < 26) return 0.0;
  if (age <= 30) return 0.05;
  if (age <= 32) return 0.02;
  if (age <= 34) return 0.0;
  if (age <= 36) return -0.04;
  if (age <= 38) return -0.08;
  return -0.12;
}

function layoffPenalty(prevBoutDate: Date | null, asOfDate: Date): number {
  if (!prevBoutDate) return 0;
  const m = monthsBetween(asOfDate, prevBoutDate);
  if (m <= 12) return 0;
  return Math.min(15, (m - 12) * 0.5);
}

// =====================================================================
// Curve + skid + fresh loss (Wave 31)
// =====================================================================

function applyCurve(raw: number): number {
  if (raw >= 88) return 100;
  if (raw >= 75) return Math.min(100, Math.round(93 + (raw - 75) * (7 / 13)));
  if (raw >= 60) return Math.min(100, Math.round(80 + (raw - 60) * (13 / 15)));
  if (raw >= 45) return Math.min(100, Math.round(60 + (raw - 45) * (20 / 15)));
  if (raw >= 25) return Math.min(100, Math.round(25 + (raw - 25) * (35 / 20)));
  return Math.max(0, Math.round(raw));
}

function skidAndFreshLoss(
  multiplied: number,
  recentBouts: BoutRow[],
): number {
  let losses3 = 0;
  let losses5 = 0;
  recentBouts.slice(0, 5).forEach((b, idx) => {
    const isLoss = b.is_win === false && !isNoContest(b);
    if (!isLoss) return;
    if (idx < 3) losses3++;
    losses5++;
  });
  let skid = 0;
  if (losses3 >= 3) skid = 25;
  else if (losses5 >= 3) skid = 15;
  else if (losses3 >= 2) skid = 10;
  let fresh = 0;
  if (skid === 0 && recentBouts.length > 0) {
    const b0 = recentBouts[0];
    if (b0.is_win === false && !isNoContest(b0)) fresh = 5;
  }
  return Math.max(0, Math.min(100, multiplied - skid - fresh));
}

// =====================================================================
// Main loop
// =====================================================================

async function main() {
  // Split the data load into 3 light queries that the pooler can chew
  // without hitting statement_timeout. Join in TS.
  console.log("Loading bout meta...");
  const meta = await sql<
    Array<{
      bout_id: string;
      event_date: string;
      weight_class: string;
      is_title_fight: boolean;
      method: string | null;
      round_finished: number | null;
      time_finished_seconds: number | null;
      scheduled_rounds: number;
      fighter_a_id: string;
      fighter_b_id: string;
      winner_id: string | null;
    }>
  >`
    SELECT
      b.id::text AS bout_id,
      e.date::text AS event_date,
      b.weight_class::text AS weight_class,
      COALESCE(b.is_title_fight, false) AS is_title_fight,
      b.method::text AS method,
      b.round_finished,
      b.time_finished_seconds,
      COALESCE(b.scheduled_rounds, 3) AS scheduled_rounds,
      b.fighter_a_id::text AS fighter_a_id,
      b.fighter_b_id::text AS fighter_b_id,
      b.winner_id::text AS winner_id
    FROM bout b
    JOIN event e ON e.id = b.event_id
    WHERE b.status = 'completed'
  `;
  console.log(`  ${meta.length} bouts`);

  console.log("Loading per-bout per-fighter aggregates...");
  const stats = await sql<
    Array<{
      bout_id: string;
      fighter_id: string;
      sig_landed: number;
      sig_attempted: number;
      td_landed: number;
      td_attempted: number;
      control_seconds: number;
      knockdowns: number;
      sub_attempts: number;
    }>
  >`
    SELECT
      brs.bout_id::text AS bout_id,
      brs.fighter_id::text AS fighter_id,
      SUM(brs.sig_str_landed)::int AS sig_landed,
      SUM(brs.sig_str_attempted)::int AS sig_attempted,
      SUM(brs.takedowns_landed)::int AS td_landed,
      SUM(brs.takedowns_attempted)::int AS td_attempted,
      SUM(brs.control_time_seconds)::int AS control_seconds,
      SUM(brs.knockdowns)::int AS knockdowns,
      SUM(brs.sub_attempts)::int AS sub_attempts
    FROM bout_round_stats brs
    GROUP BY brs.bout_id, brs.fighter_id
  `;
  console.log(`  ${stats.length} (bout, fighter) stat rows`);

  console.log("Loading opp tiers...");
  const tiers = await sql<
    Array<{
      bout_id: string;
      fighter_id: string;
      opp_tier_value: number;
    }>
  >`
    SELECT
      bout_id::text AS bout_id,
      fighter_id::text AS fighter_id,
      opp_tier_value
    FROM bout_opponent_tier
  `;
  console.log(`  ${tiers.length} (bout, fighter) tier rows`);

  console.log("Loading fighter dob+slug...");
  const fighters = await sql<
    Array<{ id: string; slug: string; dob: string | null }>
  >`
    SELECT id::text AS id, slug, dob::text AS dob
    FROM fighter
  `;
  console.log(`  ${fighters.length} fighters`);

  // Index lookups.
  const statKey = (b: string, f: string) => `${b}|${f}`;
  const statMap = new Map<string, (typeof stats)[number]>();
  for (const s of stats) statMap.set(statKey(s.bout_id, s.fighter_id), s);
  const tierMap = new Map<string, number>();
  for (const t of tiers) tierMap.set(statKey(t.bout_id, t.fighter_id), t.opp_tier_value);
  const fighterMap = new Map<string, { slug: string; dob: string | null }>();
  for (const f of fighters) fighterMap.set(f.id, { slug: f.slug, dob: f.dob });

  // Build BoutRow per (fighter, bout).
  console.log("Building BoutRow array...");
  const rows: BoutRow[] = [];
  const zeroStat = {
    sig_landed: 0,
    sig_attempted: 0,
    td_landed: 0,
    td_attempted: 0,
    control_seconds: 0,
    knockdowns: 0,
    sub_attempts: 0,
  };
  for (const m of meta) {
    for (const side of ["a", "b"] as const) {
      const fighterId = side === "a" ? m.fighter_a_id : m.fighter_b_id;
      const oppId = side === "a" ? m.fighter_b_id : m.fighter_a_id;
      if (!fighterId || !oppId) continue;
      const fInfo = fighterMap.get(fighterId);
      if (!fInfo) continue;
      const fs = statMap.get(statKey(m.bout_id, fighterId)) ?? zeroStat;
      const os = statMap.get(statKey(m.bout_id, oppId)) ?? zeroStat;
      const opp_tier_value = tierMap.get(statKey(m.bout_id, fighterId)) ?? 0;
      const methodLower = (m.method ?? "").toLowerCase();
      rows.push({
        fighter_id: fighterId,
        fighter_slug: fInfo.slug,
        fighter_dob: fInfo.dob,
        bout_id: m.bout_id,
        event_date: m.event_date,
        weight_class: m.weight_class,
        is_title_fight: m.is_title_fight,
        method: m.method,
        round_finished: m.round_finished,
        time_finished_seconds: m.time_finished_seconds,
        scheduled_rounds: m.scheduled_rounds,
        opp_id: oppId,
        is_win:
          m.winner_id == null
            ? null
            : m.winner_id === fighterId,
        is_no_contest: methodLower.includes("no_contest"),
        opp_tier_value,
        f_sig_landed: fs.sig_landed,
        f_sig_attempted: fs.sig_attempted,
        f_td_landed: fs.td_landed,
        f_td_attempted: fs.td_attempted,
        f_control_seconds: fs.control_seconds,
        f_knockdowns: fs.knockdowns,
        f_sub_attempts: fs.sub_attempts,
        o_sig_landed: os.sig_landed,
        o_sig_attempted: os.sig_attempted,
        o_td_landed: os.td_landed,
        o_td_attempted: os.td_attempted,
        o_control_seconds: os.control_seconds,
        o_knockdowns: os.knockdowns,
        o_sub_attempts: os.sub_attempts,
      });
    }
  }
  // Sort: fighter_id ASC, event_date ASC, bout_id ASC
  rows.sort((a, b) => {
    if (a.fighter_id !== b.fighter_id)
      return a.fighter_id.localeCompare(b.fighter_id);
    if (a.event_date !== b.event_date)
      return a.event_date.localeCompare(b.event_date);
    return a.bout_id.localeCompare(b.bout_id);
  });
  console.log(`  ${rows.length} (fighter, bout) BoutRow entries`);

  // Group by fighter
  const byFighter = new Map<string, BoutRow[]>();
  for (const r of rows) {
    if (!byFighter.has(r.fighter_id)) byFighter.set(r.fighter_id, []);
    byFighter.get(r.fighter_id)!.push(r);
  }
  console.log(`  ${byFighter.size} distinct fighters`);

  // For each fighter, walk chronologically and compute per-anchor score.
  const anchors: AnchorRow[] = [];
  let fighterIdx = 0;
  for (const [fighterId, allBoutsAsc] of byFighter) {
    fighterIdx++;
    if (allBoutsAsc.length < 3) continue; // mirror ufc_bouts >= 3 gate

    const cum: CumulativeStats = {
      sig_landed: 0,
      opp_sig_landed: 0,
      opp_sig_attempted: 0,
      td_landed: 0,
      opp_td_landed: 0,
      opp_td_attempted: 0,
      opp_kd: 0,
      fight_seconds: 0,
      bout_count: 0,
    };

    for (let i = 0; i < allBoutsAsc.length; i++) {
      const anchor = allBoutsAsc[i];
      const anchorDate = parseDate(anchor.event_date);
      const fs = boutFightSeconds(anchor);

      // Accumulate THIS bout into cum (so cum reflects bouts up to and
      // including anchor — matching the view's behavior when anchor is
      // "today").
      cum.sig_landed += anchor.f_sig_landed;
      cum.opp_sig_landed += anchor.o_sig_landed;
      cum.opp_sig_attempted += anchor.o_sig_attempted;
      cum.td_landed += anchor.f_td_landed;
      cum.opp_td_landed += anchor.o_td_landed;
      cum.opp_td_attempted += anchor.o_td_attempted;
      cum.opp_kd += anchor.o_knockdowns;
      cum.fight_seconds += fs;
      cum.bout_count += 1;

      // Skip computing score for bouts 0..1 — need ≥3 bouts (we're at
      // index i, so bouts count = i+1, gate is i+1 >= 3 → i >= 2).
      if (i < 2) continue;

      const allUpTo = allBoutsAsc.slice(0, i + 1);
      const recentDesc = [...allUpTo].sort((a, b) => {
        if (b.event_date !== a.event_date) return b.event_date.localeCompare(a.event_date);
        return b.bout_id.localeCompare(a.bout_id);
      });

      const qw = computeQualityWinsDecayed(allUpTo, anchorDate);
      const fd = computeFinishingDomDecayed(allUpTo, anchorDate);
      const form = computeRecentForm(recentDesc);
      const activity = computeActivity(allUpTo, anchorDate);
      const rlp = computeRecentLossPenalty(recentDesc, anchorDate);
      const era = computeEraDom(allUpTo, anchorDate);
      const perf = computePerfDiffCurrent(recentDesc);
      const cp = computeCurrentCp(anchor.fighter_slug, anchorDate, recentDesc);
      const dv = defensiveVulnerability(cum);
      const af = ageFactor(anchor.fighter_dob, anchorDate);

      // Layoff: months between THIS bout's date and the previous bout's date.
      const prevDate = i > 0 ? parseDate(allBoutsAsc[i - 1].event_date) : null;
      const lay = layoffPenalty(prevDate, anchorDate);

      const positives =
        qw * 0.16 +
        cp * 0.10 +
        era * 0.06 +
        perf * 0.16 +
        fd * 0.10 +
        activity * 0.12 +
        form * 0.18;
      const penalties = rlp * 0.20 + dv * 0.10 + lay;
      const rawCurrent = Math.max(0, (positives - penalties) * (1 + af));

      const multiplied = applyCurve(rawCurrent);
      const vertexScore = skidAndFreshLoss(multiplied, recentDesc);

      if (!Number.isFinite(rawCurrent) || !Number.isFinite(vertexScore)) {
        continue;
      }

      anchors.push({
        fighter_id: fighterId,
        as_of_bout_id: anchor.bout_id,
        as_of_date: anchor.event_date,
        vertex_score: Math.max(0, Math.min(100, Math.round(vertexScore))),
        raw_current: rawCurrent,
      });
    }

    if (fighterIdx % 500 === 0) {
      console.log(`  processed ${fighterIdx} fighters, ${anchors.length} anchor rows so far`);
    }
  }

  console.log(`Total anchor rows: ${anchors.length}`);

  console.log("Truncating fighter_score_history...");
  await sql`TRUNCATE TABLE fighter_score_history`;

  // Batch insert
  console.log("Inserting...");
  const CHUNK = 1000;
  for (let i = 0; i < anchors.length; i += CHUNK) {
    const slice = anchors.slice(i, i + CHUNK);
    await sql`
      INSERT INTO fighter_score_history ${sql(
        slice,
        "fighter_id",
        "as_of_bout_id",
        "as_of_date",
        "vertex_score",
        "raw_current",
      )}
    `;
    if ((i / CHUNK) % 5 === 0) {
      console.log(`  inserted ${Math.min(i + CHUNK, anchors.length)} / ${anchors.length}`);
    }
  }
  console.log("Inserted.");

  // Sanity: top-20 peaks of active fighters
  const top = await sql<
    Array<{
      name_en: string;
      peak: number;
      peak_date: string;
      current_score: number | null;
    }>
  >`
    WITH peaks AS (
      SELECT
        fighter_id,
        MAX(vertex_score) AS peak,
        (ARRAY_AGG(as_of_date ORDER BY vertex_score DESC, as_of_date DESC))[1] AS peak_date
      FROM fighter_score_history
      GROUP BY fighter_id
    )
    SELECT
      f.name_en,
      p.peak,
      p.peak_date::text AS peak_date,
      f.vertex_score AS current_score
    FROM peaks p
    JOIN fighter f ON f.id = p.fighter_id
    WHERE f.roster_status = 'active'
    ORDER BY p.peak DESC, p.peak_date DESC
    LIMIT 20
  `;
  console.log("\n=== TOP 20 active fighters by peak vertex (history-based) ===");
  console.log(" #  name                              peak  on            cur");
  console.log("-".repeat(75));
  top.forEach((r, i) => {
    const name = r.name_en.padEnd(32);
    const cur = (r.current_score ?? "—").toString().padStart(4);
    console.log(
      `${(i + 1).toString().padStart(2)}  ${name}  ${r.peak.toString().padStart(4)}  ${r.peak_date}  ${cur}`,
    );
  });

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
