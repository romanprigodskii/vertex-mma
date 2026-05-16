/**
 * Wave 12: derives fighter.current_cp from championship_pedigree by applying
 * time-decay + recent-opp-quality bonus to the former-champion buckets only.
 *
 * Pipeline order: run AFTER compute_championship_pedigree.ts (which sets the
 * base bucket: 100 / 90 / 80 / 70 / 40 / 0). Then materialize_vertex_score.ts
 * picks up current_cp via the fighter_vertex_score view (migration 0043).
 *
 * Decay curves (years_since_last_closed_reign_end):
 *
 *   Former undisputed (base = 80) — slow decay:
 *     0   → 80
 *     1   → 70
 *     2   → 60
 *     3   → 50
 *     5   → 40
 *     8+  → 25 (floor)
 *
 *   Former interim-only (base = 70) — fast decay (V4c):
 *     0-1 → 70 (full grace year)
 *     2   → 47.5
 *     3+  → 25 (floor)
 *
 *   Logic: undisputed reigns accumulate legacy across sustained periods;
 *   interim is typically a single-night win followed by a unification
 *   loss, so its CP weight should decay faster.
 *
 * Recent-opp bonus (avg opp_tier_value across last 5 completed UFC bouts):
 *
 *   avg ≥ 18 (apex/top-5 heavy)  → +20
 *   avg ≥ 10 (top-10 mix)        → +12
 *   avg ≥  5 (top-15 mix)        → +5
 *   else                          →  0
 *
 * Final: current_cp = min(base_cp_ceiling, time_decayed + opp_bonus)
 *
 * Untouched buckets (current_cp = base):
 *   100 (current undisputed champion + sticky vacated/stripped)
 *    90 (current interim champion — Wave 10B.1)
 *    40 (lost title challenger)
 *     0 (never held UFC title)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import {
  mostRecentClosedReign,
} from "../src/lib/championship-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

const TODAY = process.env.TODAY ? new Date(process.env.TODAY) : new Date();

function timeDecayedCp(baseCp: 80 | 70, yearsSince: number): number {
  if (baseCp === 80) {
    if (yearsSince < 3) return 80 - (30 * yearsSince) / 3;
    if (yearsSince < 8) return 50 - (25 * (yearsSince - 3)) / 5;
    return 25;
  }
  // baseCp === 70 — former interim-only (V4c fast decay)
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

interface FighterRow {
  id: string;
  slug: string;
  championship_pedigree: number;
  avg_opp_tier_last_5: number | null;
}

async function main() {
  // Single query pulling base CP + last-5-bouts opp tier average per fighter.
  // The recency_rank lets us cap at 5 most-recent bouts; LEFT JOIN keeps
  // fighters with no bouts (their avg ends up NULL → bonus = 0).
  const fighters = await sql<FighterRow[]>`
    WITH ranked_bouts AS (
      SELECT
        bot.fighter_id,
        bot.opp_tier_value,
        ROW_NUMBER() OVER (
          PARTITION BY bot.fighter_id
          ORDER BY e.date DESC, b.id DESC
        ) AS rn
      FROM bout_opponent_tier bot
      JOIN bout b ON b.id = bot.bout_id
      JOIN event e ON e.id = b.event_id
      WHERE b.status = 'completed'
    ),
    avg_opp AS (
      SELECT
        fighter_id,
        AVG(opp_tier_value::float)::float AS avg_opp_tier_last_5
      FROM ranked_bouts
      WHERE rn <= 5
      GROUP BY fighter_id
    )
    SELECT
      f.id::text AS id,
      f.slug,
      f.championship_pedigree,
      ao.avg_opp_tier_last_5
    FROM fighter f
    LEFT JOIN avg_opp ao ON ao.fighter_id = f.id
  `;

  let updated = 0;
  const buckets: Record<string, number> = {};
  const updates: Array<{ id: string; current_cp: number }> = [];

  for (const f of fighters) {
    const base = f.championship_pedigree;
    let currentCp: number;

    if (base === 100 || base === 90 || base === 40 || base === 0) {
      currentCp = base;
    } else if (base === 80 || base === 70) {
      const reign = mostRecentClosedReign(f.slug);
      if (!reign || !reign.endDate) {
        // Defensive — shouldn't happen because base=80/70 implies a closed
        // reign exists. Fall through to base.
        currentCp = base;
      } else {
        const yearsSince =
          (TODAY.getTime() - new Date(reign.endDate).getTime()) /
          (365.25 * 86_400_000);
        const decayed = timeDecayedCp(base as 80 | 70, yearsSince);
        const bonus = oppBonus(f.avg_opp_tier_last_5);
        currentCp = Math.min(base, Math.round(decayed + bonus));
      }
    } else {
      // Unexpected bucket (e.g., legacy data with non-canonical value) —
      // pass through so we don't lose info.
      currentCp = base;
    }

    updates.push({ id: f.id, current_cp: currentCp });
    buckets[String(currentCp)] = (buckets[String(currentCp)] ?? 0) + 1;
  }

  // Batched UPDATE via UNNEST.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const ids = slice.map((u) => u.id);
    const cps = slice.map((u) => u.current_cp);
    await sql`
      UPDATE fighter f
      SET current_cp = v.cp
      FROM (
        SELECT
          UNNEST(${ids}::uuid[])  AS id,
          UNNEST(${cps}::int[])    AS cp
      ) AS v
      WHERE f.id = v.id
    `;
    updated += slice.length;
  }

  console.log(`Updated current_cp on ${updated} fighters.`);
  console.log("current_cp distribution:");
  for (const k of Object.keys(buckets).sort((a, b) => Number(b) - Number(a))) {
    console.log(`  ${String(k).padStart(4)}: ${buckets[k]}`);
  }

  // Spot-check a handful of anchor fighters.
  const anchors = await sql<
    Array<{ name_en: string; cp: number; current_cp: number }>
  >`
    SELECT name_en, championship_pedigree AS cp, current_cp
    FROM fighter
    WHERE slug IN (
      'tom-aspinall-399afb',
      'ilia-topuria-54f64b',
      'islam-makhachev-275aca',
      'alex-pereira-e5549c',
      'justin-gaethje-9e8f6c',
      'max-holloway-150ff4',
      'robert-whittaker-e1147d',
      'aljamain-sterling-cb696e',
      'alexandre-pantoja-a0f000',
      'belal-muhammad-b1b072',
      'jack-della-maddalena-6b453b',
      'ciryl-gane-787bb1',
      'yair-rodriguez-cbf5e6',
      'colby-covington-dc9572',
      'dustin-poirier-029eaf',
      'tony-ferguson-22a92d',
      'georges-st-pierre-6506c1',
      'conor-mcgregor-f4c499'
    )
    ORDER BY name_en
  `;
  console.log("\nAnchor fighters (base CP → current_cp):");
  for (const a of anchors) {
    const delta = a.current_cp - a.cp;
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${a.name_en.padEnd(28)} ${String(a.cp).padStart(3)} → ${String(a.current_cp).padStart(3)} (${sign})`,
    );
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
