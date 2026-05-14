/**
 * Infers fighter.gender by transitive bout expansion from a seed list of
 * known-female slugs. UFC has never held a mixed-gender bout, so any
 * fighter sharing any UFC bout with a known woman is also a woman.
 *
 * Seed sources:
 *   1. All strawweight fighters (UFC women-exclusive division).
 *   2. Female champions from championship-history.ts (all women's reigns
 *      were stored under the men's bantamweight / featherweight /
 *      flyweight enum because of how our enum is structured — listed by
 *      hand below).
 *   3. Female title challengers from title-challenger-history.ts.
 *
 * After expansion converges, defaults everyone NOT flagged to male.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

// Female champions explicitly listed in src/lib/championship-history.ts.
// Strawweight is auto-included via weight_class_primary so we only need
// the women fighters in bantamweight / featherweight / flyweight divisions.
const FEMALE_CHAMPION_SLUGS = [
  // Women's Bantamweight
  "julianna-pena-3253b1",
  "raquel-pennington-fc169c",
  "amanda-nunes-80fa82",
  "miesha-tate-b96619",
  "holly-holm-634e2f",
  "ronda-rousey-8bdac2",
  // Women's Featherweight (defunct)
  "cristiane-justino-634bb0",
  "germaine-de-randamie-1d239d",
  // Women's Flyweight
  "valentina-shevchenko-132deb",
  "alexa-grasso-e8b731",
  "nicco-montano-1de9ad",
  // Mackenzie Dern — strawweight, already auto-seeded but list for clarity
  "mackenzie-dern-7447e9",
];

// Female title challengers from src/lib/title-challenger-history.ts.
const FEMALE_CHALLENGER_SLUGS = [
  "tatiana-suarez-b08012",
  "yan-xiaonan-c41d42",
  "manon-fiorot-34ff30",
  "taila-santos-f74671",
  "liz-carmouche-51a0c0",
  "sara-mcmann-7be74a",
  "cat-zingano-3ecd93",
];

async function main() {
  // Reset gender to baseline so this run is the single source of truth.
  await sql`UPDATE fighter SET gender = 'male'`;

  // Pass 0: strawweight = female (UFC women-exclusive).
  const strawweight = await sql`
    UPDATE fighter SET gender = 'female'
    WHERE weight_class_primary = 'strawweight'
    RETURNING id
  `;
  console.log(`Seeded ${strawweight.length} strawweight fighters as female.`);

  // Pass 0b: explicit female champion + challenger seeds.
  const seeds = [...FEMALE_CHAMPION_SLUGS, ...FEMALE_CHALLENGER_SLUGS];
  const seedUpdate = await sql`
    UPDATE fighter SET gender = 'female'
    WHERE slug = ANY(${seeds})
    RETURNING id, slug
  `;
  console.log(`Seeded ${seedUpdate.length} explicit female champion/challenger slugs.`);
  // (Some of the seeds may not exist in the DB — log any misses.)
  const seededSlugs = new Set(seedUpdate.map((r) => r.slug as string));
  const missing = seeds.filter((s) => !seededSlugs.has(s));
  if (missing.length > 0) {
    console.warn(`  ! ${missing.length} seed slugs not found in DB:`, missing.join(", "));
  }

  // Transitive expansion: repeatedly mark as female anyone who shares a
  // UFC bout with an existing female fighter. Iterate until fixpoint.
  let iter = 0;
  let added: number;
  do {
    iter += 1;
    const r = await sql`
      WITH female_ids AS (
        SELECT id FROM fighter WHERE gender = 'female'
      ),
      candidates AS (
        SELECT DISTINCT
          CASE
            WHEN b.fighter_a_id IN (SELECT id FROM female_ids) THEN b.fighter_b_id
            ELSE b.fighter_a_id
          END AS new_female_id
        FROM bout b
        WHERE
          (b.fighter_a_id IN (SELECT id FROM female_ids)
            OR b.fighter_b_id IN (SELECT id FROM female_ids))
          AND b.status IN ('completed', 'scheduled')
      )
      UPDATE fighter SET gender = 'female'
      WHERE id IN (SELECT new_female_id FROM candidates WHERE new_female_id IS NOT NULL)
        AND gender = 'male'
      RETURNING id
    `;
    added = r.length;
    console.log(`  iter ${iter}: +${added} female`);
  } while (added > 0 && iter < 20);

  // Final tally.
  const tally = await sql<Array<{ gender: string; count: number }>>`
    SELECT gender, COUNT(*)::int AS count
    FROM fighter
    GROUP BY gender
    ORDER BY count DESC
  `;
  console.log("\nFinal tally:");
  for (const r of tally) console.log(`  ${r.gender.padEnd(8)} ${r.count}`);

  // Sanity: a few well-known fighters.
  const sanity = await sql<Array<{ name_en: string; gender: string }>>`
    SELECT name_en, gender FROM fighter
    WHERE slug IN (
      'islam-makhachev-275aca',
      'jon-jones-07f72a',
      'valentina-shevchenko-132deb',
      'amanda-nunes-80fa82',
      'zhang-weili-1ebe20',
      'alexandre-pantoja-a0f000',
      'merab-dvalishvili-c03520',
      'tatiana-suarez-b08012',
      'cristiane-justino-634bb0',
      'georges-st-pierre-6506c1'
    )
    ORDER BY gender DESC, name_en
  `;
  console.log("\nSanity check:");
  for (const r of sanity) console.log(`  ${r.name_en.padEnd(28)} ${r.gender}`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
