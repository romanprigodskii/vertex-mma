/**
 * Copies the computed vertex_score from the fighter_vertex_score view into
 * fighter.vertex_score for fighters with >= 3 UFC bouts. Fighters with fewer
 * bouts keep NULL (rendered as "Unranked" in step 3 UI work).
 *
 * Also prints the top-50 and bottom-10 inspection queries so we can paste
 * them into the commit message for human review.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

async function main() {
  // Wipe existing scores first so removed champions / re-scores aren't stale.
  await sql`UPDATE fighter SET vertex_score = NULL`;

  const updated = await sql`
    UPDATE fighter f
    SET vertex_score = vs.vertex_score
    FROM fighter_vertex_score vs
    WHERE vs.id = f.id
      AND vs.ufc_bouts >= 3
    RETURNING f.id
  `;
  console.log(`Materialized vertex_score for ${updated.length} fighters with >= 3 UFC bouts.\n`);

  const top50 = await sql<Array<{
    slug: string;
    name_en: string;
    ufc_bouts: number;
    ufc_wins: number;
    ufc_losses: number;
    wq: number;
    cp: number;
    act: number;
    strk: number;
    grap: number;
    total: number;
  }>>`
    SELECT
      f.slug,
      f.name_en,
      vs.ufc_bouts,
      vs.ufc_wins,
      vs.ufc_losses,
      ROUND(vs.win_quality)::int AS wq,
      ROUND(vs.championship_pedigree)::int AS cp,
      ROUND(vs.activity)::int AS act,
      ROUND(vs.striking_excellence)::int AS strk,
      ROUND(vs.grappling_excellence)::int AS grap,
      vs.vertex_score AS total
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE vs.ufc_bouts >= 3
    ORDER BY vs.vertex_score DESC NULLS LAST, vs.ufc_wins DESC
    LIMIT 50
  `;

  console.log("=== TOP 50 ===");
  console.log("# | name                            | bouts | W-L    | WQ  CP  ACT STRK GRAP | TOTAL");
  console.log("-".repeat(100));
  top50.forEach((r, i) => {
    const name = r.name_en.padEnd(32);
    const wl = `${r.ufc_wins}-${r.ufc_losses}`.padEnd(7);
    const cells = [r.wq, r.cp, r.act, r.strk, r.grap]
      .map((v) => String(v).padStart(3))
      .join(" ");
    console.log(`${String(i + 1).padStart(2)} | ${name} | ${String(r.ufc_bouts).padStart(5)} | ${wl} | ${cells} | ${String(r.total).padStart(5)}`);
  });

  const bot10 = await sql<Array<{ slug: string; name_en: string; ufc_bouts: number; vertex_score: number }>>`
    SELECT f.slug, f.name_en, vs.ufc_bouts, vs.vertex_score
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE vs.ufc_bouts >= 3
    ORDER BY vs.vertex_score ASC NULLS FIRST, vs.ufc_bouts DESC
    LIMIT 10
  `;
  console.log("\n=== BOTTOM 10 (>=3 UFC bouts) ===");
  bot10.forEach((r) => {
    console.log(`  ${r.name_en.padEnd(32)} ${String(r.ufc_bouts).padStart(2)} bouts → ${r.vertex_score}`);
  });

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
