/**
 * Computes fighter.peak_score for every fighter with >= 10 UFC bouts.
 *
 * Algorithm — sliding 5-fight window over the fighter's UFC career:
 *
 *   peak = wins * 12 + KO_wins * 5 + sub_wins * 5 + title_fights * 4
 *   capped at 100, best window kept
 *
 * KO / Sub use the same NULL-method fallback as the rest of the Vertex Score
 * pipeline — knockdowns >0 in the finishing round ⇒ KO, sub_attempts >0 ⇒
 * Sub. Title fights are sourced from the curated set in
 * src/lib/title-fights.ts (Wave 3C.1.2).
 *
 * Re-runnable: resets peak_score to NULL for everyone first, then writes the
 * computed value for fighters with >= 10 bouts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

import { isCuratedTitleFight } from "../src/lib/title-fights";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

interface CareerFight {
  bout_id: string;
  winner_id: string | null;
  method: string | null;
  knockdowns: number;
  sub_attempts: number;
  event_date: string;
}

function classifyFight(f: CareerFight, fighterId: string) {
  const isWin = f.winner_id === fighterId;
  const m = (f.method ?? "").toLowerCase();
  const isKo =
    isWin &&
    (m.startsWith("ko") || m.startsWith("tko") || (f.method == null && f.knockdowns > 0));
  const isSub =
    isWin &&
    (m.startsWith("sub") ||
      (f.method == null && f.knockdowns === 0 && f.sub_attempts > 0));
  return { isWin, isKo, isSub, isTitle: isCuratedTitleFight(f.bout_id) };
}

async function main() {
  // Reset so this run is the single source of truth.
  await sql`UPDATE fighter SET peak_score = NULL`;

  // Fighters with >= 10 completed UFC bouts.
  const fighters = await sql<Array<{ id: string; bouts: number }>>`
    SELECT f.id::text AS id, COUNT(b.id)::int AS bouts
    FROM fighter f
    JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
    WHERE b.status = 'completed'
    GROUP BY f.id
    HAVING COUNT(b.id) >= 10
  `;
  console.log(`${fighters.length} fighters have >= 10 completed UFC bouts.`);

  let updated = 0;
  for (const f of fighters) {
    const career = await sql<CareerFight[]>`
      SELECT
        b.id::text AS bout_id,
        b.winner_id::text AS winner_id,
        b.method::text AS method,
        COALESCE(brs.knockdowns, 0)::int AS knockdowns,
        COALESCE(brs.sub_attempts, 0)::int AS sub_attempts,
        e.date::text AS event_date
      FROM bout b
      JOIN event e ON e.id = b.event_id
      LEFT JOIN bout_round_stats brs
        ON brs.bout_id = b.id
       AND brs.fighter_id = ${f.id}::uuid
       AND brs.round = b.round_finished
      WHERE (b.fighter_a_id = ${f.id}::uuid OR b.fighter_b_id = ${f.id}::uuid)
        AND b.status = 'completed'
      ORDER BY e.date ASC, b.id ASC
    `;

    if (career.length < 10) continue;

    let bestPeak = 0;
    for (let i = 0; i <= career.length - 5; i += 1) {
      const window = career.slice(i, i + 5);
      let wins = 0;
      let kos = 0;
      let subs = 0;
      let titles = 0;
      for (const fight of window) {
        const c = classifyFight(fight, f.id);
        if (c.isWin) wins += 1;
        if (c.isKo) kos += 1;
        if (c.isSub) subs += 1;
        if (c.isTitle) titles += 1;
      }
      const peak = Math.min(100, wins * 12 + kos * 5 + subs * 5 + titles * 4);
      if (peak > bestPeak) bestPeak = peak;
    }

    await sql`UPDATE fighter SET peak_score = ${bestPeak} WHERE id = ${f.id}::uuid`;
    updated += 1;
  }
  console.log(`Updated ${updated} fighters with peak scores.`);

  // Quick sanity: who got the highest peaks?
  const topPeaks = await sql<Array<{ name_en: string; peak_score: number; bouts: number }>>`
    SELECT f.name_en, f.peak_score, vs.ufc_bouts AS bouts
    FROM fighter f
    JOIN fighter_vertex_score vs ON vs.id = f.id
    WHERE f.peak_score IS NOT NULL
    ORDER BY f.peak_score DESC, vs.ufc_bouts DESC
    LIMIT 15
  `;
  console.log("\nTop 15 peak scores:");
  for (const r of topPeaks) {
    console.log(`  ${r.name_en.padEnd(32)} peak=${r.peak_score}  (bouts ${r.bouts})`);
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
