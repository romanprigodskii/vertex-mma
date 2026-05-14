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
    peak_score: number | null;
    recent_loss_penalty: number;
    total_loss_penalty: number;
    last_fight_date: string | null;
  }>>`
    SELECT
      f.name_en,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score,
      vs.ufc_bouts,
      vs.ufc_wins,
      vs.ufc_losses,
      f.peak_score,
      ROUND(vs.recent_loss_penalty)::int AS recent_loss_penalty,
      ROUND(vs.total_loss_penalty)::int AS total_loss_penalty,
      vs.last_fight_date::text AS last_fight_date
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE f.vertex_score IS NOT NULL
    ORDER BY f.vertex_score DESC, vs.ufc_wins DESC
    LIMIT 30
  `;

  console.log("=== TOP 30 by vertex_score (CURRENT — active only) ===");
  console.log(" # | name                            | cur | all | bouts | W-L    | peak | recent-pen | last fight");
  console.log("-".repeat(110));
  current.forEach((r, i) => {
    const name = r.name_en.padEnd(32);
    const wl = `${r.ufc_wins}-${r.ufc_losses}`.padEnd(7);
    const peak = (r.peak_score ?? "—").toString().padStart(4);
    const last = (r.last_fight_date ?? "—").slice(0, 10);
    console.log(`${String(i + 1).padStart(2)} | ${name} | ${String(r.current_score).padStart(3)} | ${String(r.all_time_score).padStart(3)} | ${String(r.ufc_bouts).padStart(5)} | ${wl} | ${peak} | ${String(r.recent_loss_penalty).padStart(10)} | ${last}`);
  });

  const allTime = await sql<Array<{
    name_en: string;
    current_score: number | null;
    all_time_score: number;
    ufc_bouts: number;
    ufc_wins: number;
    ufc_losses: number;
    peak_score: number | null;
    total_loss_penalty: number;
    last_fight_date: string | null;
  }>>`
    SELECT
      f.name_en,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score,
      vs.ufc_bouts,
      vs.ufc_wins,
      vs.ufc_losses,
      f.peak_score,
      ROUND(vs.total_loss_penalty)::int AS total_loss_penalty,
      vs.last_fight_date::text AS last_fight_date
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE f.vertex_score_all_time IS NOT NULL
    ORDER BY f.vertex_score_all_time DESC, vs.ufc_wins DESC
    LIMIT 30
  `;

  console.log("\n=== TOP 30 by vertex_score_all_time ===");
  console.log(" # | name                            | cur  | all | bouts | W-L    | peak | tot-pen | last fight");
  console.log("-".repeat(110));
  allTime.forEach((r, i) => {
    const name = r.name_en.padEnd(32);
    const cur = r.current_score == null ? "  — " : String(r.current_score).padStart(4);
    const wl = `${r.ufc_wins}-${r.ufc_losses}`.padEnd(7);
    const peak = (r.peak_score ?? "—").toString().padStart(4);
    const last = (r.last_fight_date ?? "—").slice(0, 10);
    console.log(`${String(i + 1).padStart(2)} | ${name} | ${cur} | ${String(r.all_time_score).padStart(3)} | ${String(r.ufc_bouts).padStart(5)} | ${wl} | ${peak} | ${String(r.total_loss_penalty).padStart(7)} | ${last}`);
  });

  // Spot-check the legends + journeymen the spec calls out, plus a couple
  // of fighters for whom the new penalty is expected to bite.
  const spot = await sql<Array<{
    name_en: string;
    current_score: number | null;
    all_time_score: number | null;
    ufc_wins: number;
    ufc_losses: number;
    peak_score: number | null;
  }>>`
    SELECT
      f.name_en,
      f.vertex_score AS current_score,
      f.vertex_score_all_time AS all_time_score,
      vs.ufc_wins,
      vs.ufc_losses,
      f.peak_score
    FROM fighter f
    JOIN fighter_vertex_score vs ON vs.id = f.id
    WHERE f.slug IN (
      'jon-jones-07f72a',
      'islam-makhachev-275aca',
      'khabib-nurmagomedov-032cc3',
      'georges-st-pierre-6506c1',
      'anderson-silva-1f4543',
      'demetrious-johnson-8a304b',
      'conor-mcgregor-f4c499',
      'cain-velasquez-0ff11c',
      'andrei-arlovski-3738e6',
      'donald-cerrone-1d0075',
      'sean-strickland-0d8011',
      'khamzat-chimaev-767755',
      'ilia-topuria-54f64b',
      'tom-aspinall-399afb',
      'alex-pereira-e5549c'
    )
    ORDER BY all_time_score DESC NULLS LAST
  `;
  console.log("\n=== Spot check (legends + journeymen + small-sample active) ===");
  console.log("  name                            cur   all   W-L      peak");
  console.log("  " + "-".repeat(64));
  for (const r of spot) {
    const cur = r.current_score == null ? "—   " : String(r.current_score).padStart(4);
    const all = r.all_time_score == null ? "—   " : String(r.all_time_score).padStart(4);
    const wl = `${r.ufc_wins}-${r.ufc_losses}`.padEnd(8);
    const peak = (r.peak_score ?? "—").toString().padStart(4);
    console.log(`  ${r.name_en.padEnd(32)}${cur} | ${all} | ${wl} | ${peak}`);
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
