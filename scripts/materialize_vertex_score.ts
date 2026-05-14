/**
 * Copies vertex_score (current) and vertex_score_all_time from the
 * fighter_vertex_score view into the matching fighter columns.
 *
 * - vertex_score gets the view value (NULL for inactive fighters or <3 bouts).
 * - vertex_score_all_time gets the view value (NULL only for <3 bouts).
 *
 * Then prints the top-30 active + top-30 all-time tables so the deltas are
 * easy to paste into a commit message for human review.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  // Reset both columns first so this run is the single source of truth.
  await sql`UPDATE fighter SET vertex_score = NULL, vertex_score_all_time = NULL`;

  const updated = await sql`
    UPDATE fighter f
    SET
      vertex_score = vs.vertex_score,
      vertex_score_all_time = vs.vertex_score_all_time
    FROM fighter_vertex_score vs
    WHERE vs.id = f.id
    RETURNING f.id
  `;
  console.log(`Materialized vertex_score(_all_time) for ${updated.length} fighter rows.\n`);

  const current = await sql<Array<{
    name_en: string;
    current_score: number;
    all_time_score: number;
    ufc_bouts: number;
    ufc_wins: number;
    ufc_losses: number;
    last_fight_date: string | null;
    is_active: boolean;
  }>>`
    SELECT
      f.name_en,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score,
      vs.ufc_bouts,
      vs.ufc_wins,
      vs.ufc_losses,
      vs.last_fight_date::text AS last_fight_date,
      vs.is_active
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE f.vertex_score IS NOT NULL
    ORDER BY f.vertex_score DESC, vs.ufc_wins DESC
    LIMIT 30
  `;

  console.log("=== TOP 30 by vertex_score (CURRENT — active only) ===");
  console.log(" # | name                            | cur | all | bouts | W-L    | last fight");
  console.log("-".repeat(90));
  current.forEach((r, i) => {
    const name = r.name_en.padEnd(32);
    const wl = `${r.ufc_wins}-${r.ufc_losses}`.padEnd(7);
    const last = (r.last_fight_date ?? "—").slice(0, 10);
    console.log(`${String(i + 1).padStart(2)} | ${name} | ${String(r.current_score).padStart(3)} | ${String(r.all_time_score).padStart(3)} | ${String(r.ufc_bouts).padStart(5)} | ${wl} | ${last}`);
  });

  const allTime = await sql<Array<{
    name_en: string;
    current_score: number | null;
    all_time_score: number;
    ufc_bouts: number;
    ufc_wins: number;
    ufc_losses: number;
    last_fight_date: string | null;
    is_active: boolean;
  }>>`
    SELECT
      f.name_en,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score,
      vs.ufc_bouts,
      vs.ufc_wins,
      vs.ufc_losses,
      vs.last_fight_date::text AS last_fight_date,
      vs.is_active
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE f.vertex_score_all_time IS NOT NULL
    ORDER BY f.vertex_score_all_time DESC, vs.ufc_wins DESC
    LIMIT 30
  `;

  console.log("\n=== TOP 30 by vertex_score_all_time ===");
  console.log(" # | name                            | cur  | all | bouts | W-L    | last fight");
  console.log("-".repeat(90));
  allTime.forEach((r, i) => {
    const name = r.name_en.padEnd(32);
    const cur = r.current_score == null ? "  — " : String(r.current_score).padStart(4);
    const wl = `${r.ufc_wins}-${r.ufc_losses}`.padEnd(7);
    const last = (r.last_fight_date ?? "—").slice(0, 10);
    console.log(`${String(i + 1).padStart(2)} | ${name} | ${cur} | ${String(r.all_time_score).padStart(3)} | ${String(r.ufc_bouts).padStart(5)} | ${wl} | ${last}`);
  });

  // Spot-check the legends the spec calls out.
  const spot = await sql<Array<{ name_en: string; current_score: number | null; all_time_score: number | null }>>`
    SELECT name_en, vertex_score AS current_score, vertex_score_all_time AS all_time_score
    FROM fighter
    WHERE slug IN (
      'khabib-nurmagomedov-032cc3',
      'georges-st-pierre-6506c1',
      'anderson-silva-1f4543',
      'demetrious-johnson-8a304b',
      'conor-mcgregor-f4c499',
      'cain-velasquez-0ff11c',
      'islam-makhachev-275aca',
      'khamzat-chimaev-767755',
      'ilia-topuria-54f64b',
      'tom-aspinall-399afb'
    )
    ORDER BY vertex_score_all_time DESC NULLS LAST
  `;
  console.log("\n=== Spot check (legends + small-sample active) ===");
  for (const r of spot) {
    const cur = r.current_score == null ? "NULL" : String(r.current_score);
    console.log(`  ${r.name_en.padEnd(32)} cur=${cur.padEnd(5)} all-time=${r.all_time_score}`);
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
