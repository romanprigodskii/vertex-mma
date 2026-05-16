/**
 * Backfills fighter.championship_pedigree from the curated TS data files.
 *
 * Pedigree mapping:
 *   - 100 if the fighter currently holds a UFC undisputed belt
 *   - 100 STICKY (Wave 6E.2) for vacated/stripped undisputed reigns where the
 *         fighter hasn't fought since (Wave 10B: rule does NOT apply to
 *         interim-only fighters)
 *   -  80 if the fighter held a UFC undisputed belt (former champion via bout
 *         loss, retirement, or already-fought-since-vacate)
 *   -  70 if the fighter has held only INTERIM UFC titles (Wave 10B)
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
  hasOnlyInterimReigns,
  isCurrentChampion,
  isDominantChampion,
  isFormerChampion,
  mostRecentClosedReign,
} from "../src/lib/championship-history";
import {
  TITLE_CHALLENGES,
  lostTitleChallenges,
} from "../src/lib/title-challenger-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

/** Sticky CP rule (Wave 6E.2): a vacated or stripped reign keeps CP=100 only
 *  until the fighter's next bout. `nextBoutDate` should be the slug's most
 *  recent completed bout date (or null if they haven't fought since).
 *
 *  Wave 10B: fighters whose only reigns are interim cap at 70 (not 80) and
 *  the sticky rule does not apply to them — interim is a procedural sub-title,
 *  not an undisputed claim. */
function pedigreeFor(slug: string, lastBoutDate: string | null): number {
  const interimOnly = hasOnlyInterimReigns(slug);
  if (isCurrentChampion(slug)) {
    // Edge case: someone currently holds ONLY an interim belt → cap at 70.
    // No fighter matches today, but be defensive.
    return interimOnly ? 70 : 100;
  }
  if (isFormerChampion(slug)) {
    // Wave 10B: interim-only fighters max at 70, sticky rule skipped.
    if (interimOnly) return 70;
    const reign = mostRecentClosedReign(slug);
    if (reign && (reign.endReason === "vacated" || reign.endReason === "stripped")) {
      // Strictly greater — same-day bouts don't break stickiness, but anything
      // after the vacate/strip date does. If lastBoutDate is null the fighter
      // never fought since (rare), keep them at 100.
      if (lastBoutDate == null || lastBoutDate <= reign.endDate!) return 100;
    }
    return 80;
  }
  if (lostTitleChallenges(slug) > 0) return 40;
  return 0;
}

async function main() {
  // Reset to 0 / false first so this run is the single source of truth.
  await sql`
    UPDATE fighter
    SET championship_pedigree = 0,
        is_dominant_champion = false
  `;

  const slugs = new Set<string>();
  for (const r of CHAMPIONSHIP_HISTORY) slugs.add(r.slug);
  for (const c of TITLE_CHALLENGES) slugs.add(c.slug);

  // Wave 6E.2: pre-fetch the most recent completed bout date per slug so we
  // can apply the sticky-CP rule without a per-slug round-trip below.
  const slugList = Array.from(slugs);
  const boutDates = await sql<Array<{ slug: string; last_bout_date: string | null }>>`
    SELECT
      f.slug,
      MAX(e.date)::text AS last_bout_date
    FROM fighter f
    LEFT JOIN bout b
      ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
     AND b.status = 'completed'
    LEFT JOIN event e ON e.id = b.event_id
    WHERE f.slug = ANY(${slugList})
    GROUP BY f.slug
  `;
  const lastBoutBySlug = new Map<string, string | null>();
  for (const r of boutDates) lastBoutBySlug.set(r.slug, r.last_bout_date);

  let updated = 0;
  let missing = 0;
  let dominantCount = 0;
  let stickyCount = 0;
  const buckets = { 100: 0, 80: 0, 70: 0, 40: 0, 0: 0 };
  for (const slug of slugs) {
    const ped = pedigreeFor(slug, lastBoutBySlug.get(slug) ?? null);
    if (ped === 0) continue; // shouldn't happen — every entry in either list yields ≥40
    const dominant = isDominantChampion(slug);
    const rows = await sql`
      UPDATE fighter
      SET championship_pedigree = ${ped},
          is_dominant_champion = ${dominant}
      WHERE slug = ${slug}
      RETURNING id
    `;
    if (rows.length === 0) {
      missing += 1;
      console.warn(`  ! no fighter row for slug ${slug}`);
    } else {
      updated += 1;
      buckets[ped as keyof typeof buckets] += 1;
      if (dominant) dominantCount += 1;
      // Sticky-100 audit: former champ rendered as 100 means the rule fired.
      if (ped === 100 && !isCurrentChampion(slug)) stickyCount += 1;
    }
  }

  console.log(`Updated ${updated} fighters; missing ${missing} slugs.`);
  console.log(`Buckets — current champ (100): ${buckets[100]}, former champ (80): ${buckets[80]}, interim-only (70): ${buckets[70]}, lost challenger (40): ${buckets[40]}`);
  console.log(`Sticky-100 (vacated/stripped, no bouts since): ${stickyCount}`);
  console.log(`Dominant champion flag set on ${dominantCount} fighters.`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
