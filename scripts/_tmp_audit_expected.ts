import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

const SLUGS = [
  "islam-makhachev-275aca", // active, NO divisional row → headline = global
  "justin-gaethje-9e8f6c", // active, divisional current row
  "ilia-topuria-54f64b", // active, divisional PROVISIONAL row
  "khabib-nurmagomedov-032cc3", // retired → all-time
  "jon-jones-07f72a", // released → all-time
];

async function main() {
  for (const slug of SLUGS) {
    const [f] = await sql`
      SELECT id::text, slug, name_en, roster_status, current_division,
             vertex_score, vertex_score_all_time
      FROM fighter WHERE slug = ${slug}`;
    const divs = await sql`
      SELECT division::text, vertex_score, divisional_status, in_active_ranking
      FROM fighter_divisional_score WHERE fighter_id = ${f.id}::uuid`;
    const [hist] = await sql`
      SELECT vertex_score, vertex_score_all_time, as_of_date::text
      FROM fighter_score_history
      WHERE fighter_id = ${f.id}::uuid
      ORDER BY as_of_date DESC, kind DESC LIMIT 1`;
    const activeDiv = divs.find(
      (d) => d.division === f.current_division && d.in_active_ranking,
    );
    const retired = ["retired", "released", "inactive"].includes(
      f.roster_status,
    );
    const expected = retired
      ? { value: f.vertex_score_all_time, mode: "all_time" }
      : activeDiv?.vertex_score != null
        ? { value: activeDiv.vertex_score, mode: "current(divisional)" }
        : f.vertex_score != null
          ? { value: f.vertex_score, mode: "current(global)" }
          : { value: f.vertex_score_all_time, mode: "all_time(fallback)" };
    console.log(
      JSON.stringify({
        slug,
        roster: f.roster_status,
        curDiv: f.current_division,
        global: f.vertex_score,
        allTime: f.vertex_score_all_time,
        divRows: divs.map(
          (d) =>
            `${d.division}:${d.vertex_score}(${d.divisional_status},${d.in_active_ranking ? "act" : "inact"})`,
        ),
        lastHistAnchor: hist
          ? `${hist.as_of_date} cur=${hist.vertex_score} at=${hist.vertex_score_all_time}`
          : null,
        EXPECTED_HEADLINE: expected,
      }),
    );
  }
  // find an active fighter carrying ONLY an all-time score (fallback class)
  const [only] = await sql`
    SELECT f.slug, f.vertex_score_all_time FROM fighter f
    WHERE f.roster_status = 'active' AND f.vertex_score IS NULL
      AND f.vertex_score_all_time IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM fighter_divisional_score d WHERE d.fighter_id = f.id)
    LIMIT 1`;
  console.log("active-allTime-only sample:", JSON.stringify(only));
  await sql.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
