/**
 * Wave 3.5 step 5B — computes title_fight_count and era_dominance per fighter.
 *
 *   title_fight_count = count of curated UFC title fights this fighter
 *                       appears in (any role / outcome)
 *   era_dominance     = LEAST(100,
 *                         title_fight_count * 8
 *                         + (isActiveChampion ? 10 : 0)
 *                         + (isDoubleChampion ? 5 : 0)
 *                       )
 *
 * Era Dominance is what gives Jon Jones (12+ title fights), Anderson Silva
 * (11), DJ (12), and other long-reigning champions a clear edge over short-
 * tenure current champions whose Quality Wins already caps at 100 after
 * just 4 apex victories. Step 5A.1 collapsed all 4+ apex fighters at
 * QW=100; this is the lever that separates "fought 4 title fights" from
 * "fought 15 title fights."
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import {
  CHAMPIONSHIP_HISTORY,
  type ChampionshipReign,
  isActiveChampion,
  isDoubleChampion,
} from "../src/lib/championship-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

interface BoutRow {
  fighter_id: string;
  fighter_slug: string;
  opponent_slug: string;
  bout_date: string;
}

// Title-fight detection from CHAMPIONSHIP_HISTORY: a bout is a title fight
// if EITHER participant was the active champion at the bout date. This
// catches all three cases automatically:
//   - existing champion defending (active throughout reign)
//   - challenger winning (winner's reign starts at bout date ⇒ active at start)
//   - champion losing (loser's reign ends at bout date ⇒ active at end)
// Interim reigns count (Wave 3.5 step 5A.1).
const REIGNS_BY_SLUG: ReadonlyMap<string, ChampionshipReign[]> = (() => {
  const m = new Map<string, ChampionshipReign[]>();
  for (const r of CHAMPIONSHIP_HISTORY) {
    const arr = m.get(r.slug) ?? [];
    arr.push(r);
    m.set(r.slug, arr);
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

async function main() {
  // Every (fighter, bout) row needs both participants' slugs so we can
  // ask "was either side active champion on bout date."
  const rows = await sql<BoutRow[]>`
    SELECT
      b.fighter_a_id::text AS fighter_id,
      fa.slug AS fighter_slug,
      fb.slug AS opponent_slug,
      e.date::text AS bout_date
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE b.status = 'completed'

    UNION ALL

    SELECT
      b.fighter_b_id::text AS fighter_id,
      fb.slug AS fighter_slug,
      fa.slug AS opponent_slug,
      e.date::text AS bout_date
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE b.status = 'completed'
  `;
  console.log(`Loaded ${rows.length} fighter-perspective bout rows.`);

  // Count derived title fights per fighter.
  const titleCount = new Map<string, number>();
  const slugByFighter = new Map<string, string>();
  for (const r of rows) {
    slugByFighter.set(r.fighter_id, r.fighter_slug);
    const date = new Date(r.bout_date);
    if (
      isActiveAt(r.fighter_slug, date) ||
      isActiveAt(r.opponent_slug, date)
    ) {
      titleCount.set(r.fighter_id, (titleCount.get(r.fighter_id) ?? 0) + 1);
    }
  }

  // Build update list. Every fighter in the bout set gets a row so the
  // batched UPDATE can rezet title_fight_count + era_dominance for every
  // fighter that has any UFC bouts.
  const ids: string[] = [];
  const titleFights: number[] = [];
  const eraDominance: number[] = [];
  for (const [fighterId, slug] of slugByFighter) {
    const tf = titleCount.get(fighterId) ?? 0;
    const era = Math.min(
      100,
      tf * 8 +
        (isActiveChampion(slug) ? 10 : 0) +
        (isDoubleChampion(slug) ? 5 : 0),
    );
    ids.push(fighterId);
    titleFights.push(tf);
    eraDominance.push(era);
  }
  console.log(`Computed era_dominance for ${ids.length} fighters.`);

  // Reset all fighters first, then batch-update those who have UFC bouts.
  await sql`UPDATE fighter SET title_fight_count = 0, era_dominance = 0`;

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const sliceIds = ids.slice(i, i + CHUNK);
    const sliceTf = titleFights.slice(i, i + CHUNK);
    const sliceEra = eraDominance.slice(i, i + CHUNK);
    await sql`
      UPDATE fighter f SET
        title_fight_count = v.tf,
        era_dominance = v.era
      FROM (
        SELECT
          UNNEST(${sliceIds}::uuid[]) AS id,
          UNNEST(${sliceTf}::int[])   AS tf,
          UNNEST(${sliceEra}::int[])  AS era
      ) AS v
      WHERE f.id = v.id
    `;
  }

  const sanity = await sql<Array<{
    name_en: string;
    title_fight_count: number;
    era_dominance: number;
  }>>`
    SELECT name_en, title_fight_count, era_dominance
    FROM fighter
    WHERE slug IN (
      'jon-jones-07f72a',
      'demetrious-johnson-8a304b',
      'anderson-silva-1f4543',
      'georges-st-pierre-6506c1',
      'valentina-shevchenko-132deb',
      'jose-aldo-d0f395',
      'islam-makhachev-275aca',
      'khabib-nurmagomedov-032cc3',
      'alex-pereira-e5549c',
      'merab-dvalishvili-c03520',
      'alexandre-pantoja-a0f000',
      'conor-mcgregor-f4c499',
      'tom-aspinall-399afb',
      'ilia-topuria-54f64b'
    )
    ORDER BY era_dominance DESC
  `;
  console.log("\nSanity check:");
  console.log("  name                              titles  era");
  console.log("  " + "-".repeat(45));
  for (const r of sanity) {
    console.log(
      `  ${r.name_en.padEnd(32)} ${String(r.title_fight_count).padStart(4)}  ${String(r.era_dominance).padStart(4)}`,
    );
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
