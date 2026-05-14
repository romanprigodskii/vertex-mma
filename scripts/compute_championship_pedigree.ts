/**
 * Backfills fighter.championship_pedigree from the curated TS data files.
 *
 * Pedigree mapping:
 *   - 100 if the fighter currently holds a UFC belt (any reign with endDate=null)
 *   -  80 if the fighter ever held a UFC belt but none currently
 *   -  40 if the fighter lost a UFC title fight without ever winning one
 *   -   0 otherwise (default, already in place from the column DEFAULT)
 *
 * Re-runnable: resets every known champion + challenger to its computed
 * value. Any fighter NOT in either list keeps the column DEFAULT (0).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import {
  CHAMPIONSHIP_HISTORY,
  isCurrentChampion,
  isFormerChampion,
} from "../src/lib/championship-history";
import {
  TITLE_CHALLENGES,
  lostTitleChallenges,
} from "../src/lib/title-challenger-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

function pedigreeFor(slug: string): number {
  if (isCurrentChampion(slug)) return 100;
  if (isFormerChampion(slug)) return 80;
  if (lostTitleChallenges(slug) > 0) return 40;
  return 0;
}

async function main() {
  // Reset to 0 first so this run is the single source of truth.
  await sql`UPDATE fighter SET championship_pedigree = 0`;

  const slugs = new Set<string>();
  for (const r of CHAMPIONSHIP_HISTORY) slugs.add(r.slug);
  for (const c of TITLE_CHALLENGES) slugs.add(c.slug);

  let updated = 0;
  let missing = 0;
  const buckets = { 100: 0, 80: 0, 40: 0, 0: 0 };
  for (const slug of slugs) {
    const ped = pedigreeFor(slug);
    if (ped === 0) continue; // shouldn't happen — every entry in either list yields ≥40
    const rows = await sql`
      UPDATE fighter SET championship_pedigree = ${ped} WHERE slug = ${slug} RETURNING id
    `;
    if (rows.length === 0) {
      missing += 1;
      console.warn(`  ! no fighter row for slug ${slug}`);
    } else {
      updated += 1;
      buckets[ped as keyof typeof buckets] += 1;
    }
  }

  console.log(`Updated ${updated} fighters; missing ${missing} slugs.`);
  console.log(`Buckets — current champ (100): ${buckets[100]}, former champ (80): ${buckets[80]}, lost challenger (40): ${buckets[40]}`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
