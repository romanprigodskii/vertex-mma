/**
 * Wave 6C.1 task 7: post-import verification block.
 *
 * Confirms the rankings + roster + CP work landed cleanly. Run via:
 *   npx tsx scripts/_verify_6c1.ts
 *
 * (Throwaway — delete after the wave commits if you don't want it kept.)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

async function main() {
  console.log("=== ranking_snapshot integrity ===");
  const [{ rows, snaps, divs, named }] = await sql<
    { rows: number; snaps: number; divs: number; named: number }[]
  >`
    SELECT COUNT(*)::int AS rows,
           COUNT(DISTINCT snapshot_date)::int AS snaps,
           COUNT(DISTINCT (division, is_women))::int AS divs,
           (COUNT(*) FILTER (WHERE fighter_id IS NOT NULL))::int AS named
    FROM ranking_snapshot
  `;
  console.log(`  rows=${rows}  snapshots=${snaps}  (division,is_women) combos=${divs}  with fighter_id=${named} (${(named / rows * 100).toFixed(1)}%)`);

  console.log("\n=== rows by year ===");
  const yearly = await sql`
    SELECT EXTRACT(YEAR FROM snapshot_date)::int AS year, COUNT(*)::int AS rows
    FROM ranking_snapshot GROUP BY year ORDER BY year
  `;
  for (const r of yearly) console.log(`  ${r.year}: ${r.rows}`);

  console.log("\n=== gender split (sanity: men should outnumber women ~3:1) ===");
  const gender = await sql`
    SELECT is_women, COUNT(*)::int AS rows
    FROM ranking_snapshot GROUP BY is_women ORDER BY is_women
  `;
  console.table(gender);

  console.log("\n=== division coverage (latest snapshot) ===");
  const latest = await sql`
    SELECT MAX(snapshot_date) AS latest FROM ranking_snapshot
  `;
  const latestDate = (latest[0] as { latest: Date }).latest
    .toISOString().slice(0, 10);
  console.log(`  latest snapshot: ${latestDate}`);
  const coverage = await sql`
    SELECT division, is_women, COUNT(*)::int AS rows,
           MIN(rank)::int AS min_rank, MAX(rank)::int AS max_rank
    FROM ranking_snapshot
    WHERE snapshot_date = ${latestDate}
    GROUP BY division, is_women
    ORDER BY is_women, division
  `;
  console.table(coverage);

  console.log("\n=== unmatched-name leaderboard (top 10) ===");
  const unmatched = await sql`
    SELECT fighter_name_raw, is_women, COUNT(*)::int AS occurrences
    FROM ranking_snapshot
    WHERE fighter_id IS NULL
    GROUP BY fighter_name_raw, is_women
    ORDER BY occurrences DESC LIMIT 10
  `;
  console.table(unmatched);

  console.log("\n=== sanity: Khabib LW reign — should be rank=0 from UFC 223 (2018-04-07) ===");
  const khabib = await sql`
    SELECT snapshot_date, rank
    FROM ranking_snapshot rs
    JOIN fighter f ON f.id = rs.fighter_id
    WHERE f.slug = 'khabib-nurmagomedov-032cc3'
      AND snapshot_date BETWEEN '2018-04-08' AND '2020-10-25'
      AND division = 'lightweight' AND is_women = false
    ORDER BY snapshot_date
  `;
  const ranks = khabib.map((r) => (r as { rank: number }).rank);
  const allChamp = ranks.every((r) => r === 0);
  console.log(
    `  ${khabib.length} LW rows in his reign; all rank=0? ${allChamp ? "✓" : "✗ — got: " + JSON.stringify([...new Set(ranks)])}`,
  );

  console.log("\n=== roster_status distribution ===");
  const roster = await sql`
    SELECT roster_status::text AS status, COUNT(*)::int AS count
    FROM fighter GROUP BY roster_status ORDER BY count DESC
  `;
  console.table(roster);

  console.log("\n=== Ciryl Gane CP backfill ===");
  const gane = await sql`
    SELECT slug, name_en, championship_pedigree, is_dominant_champion
    FROM fighter WHERE slug = 'ciryl-gane-787bb1'
  `;
  console.table(gane);

  console.log("\n=== CP buckets ===");
  const cp = await sql`
    SELECT championship_pedigree AS cp,
           COUNT(*)::int AS fighters,
           SUM(CASE WHEN is_dominant_champion THEN 1 ELSE 0 END)::int AS dominant
    FROM fighter
    WHERE championship_pedigree > 0
    GROUP BY championship_pedigree ORDER BY championship_pedigree DESC
  `;
  console.table(cp);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
