/**
 * One-shot reconcile of duplicate / stale upcoming bouts.
 *
 * Two failure modes the daily scrape produced:
 *   A) News auto-created a PROVISIONAL bout (ufc_stats_id NULL) on the WRONG
 *      event/date; UFCStats later created the real bout (with ufc_stats_id) on
 *      the correct event. The old same-event-only reconcile in
 *      loaders/events.py left the provisional twin behind on the wrong card.
 *   B) A real scheduled bout VANISHED from its event's UFCStats page (opponent
 *      swap / fight moved) but was never deleted, so it lingers with a stale
 *      updated_at while the rest of the card got refreshed.
 *
 * Fix A: repoint any news_item.related_bout_id from the provisional twin to the
 *        real bout, then delete the provisional.
 * Fix B: null out news links, then delete the stale real bout (updated_at lags
 *        the event's last scrape by > 2h on an upcoming UFCStats event).
 *
 * Idempotent. Prints what it removed and re-verifies that no fighter is left in
 * more than one upcoming bout. The permanent fix lives in
 * loaders/events.py (cross-event provisional dedup + vanished-bout reconcile).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 2 });

async function main() {
  await sql.begin(async (tx) => {
    // --- Fix A: provisional twins superseded by a real bout for the same pair.
    const repointed = await tx`
      UPDATE news_item ni SET related_bout_id = r.id
      FROM bout p, bout r
      WHERE ni.related_bout_id = p.id
        AND p.ufc_stats_id IS NULL AND p.status = 'scheduled'
        AND r.ufc_stats_id IS NOT NULL AND r.status = 'scheduled' AND r.id <> p.id
        AND (
          (r.fighter_a_id = p.fighter_a_id AND r.fighter_b_id = p.fighter_b_id)
          OR (r.fighter_a_id = p.fighter_b_id AND r.fighter_b_id = p.fighter_a_id)
        )
      RETURNING ni.id
    `;
    console.log(`Fix A: repointed ${repointed.length} news_item link(s) to the real bout`);

    const delA = await tx`
      DELETE FROM bout b USING fighter fa, fighter fb
      WHERE fa.id = b.fighter_a_id AND fb.id = b.fighter_b_id
        AND b.ufc_stats_id IS NULL AND b.status = 'scheduled'
        AND EXISTS (
          SELECT 1 FROM bout r
          WHERE r.ufc_stats_id IS NOT NULL AND r.status = 'scheduled' AND r.id <> b.id
            AND ((r.fighter_a_id = b.fighter_a_id AND r.fighter_b_id = b.fighter_b_id)
              OR (r.fighter_a_id = b.fighter_b_id AND r.fighter_b_id = b.fighter_a_id))
        )
      RETURNING fa.name_en AS a, fb.name_en AS b
    `;
    console.log(`Fix A: deleted ${delA.length} provisional twin bout(s):`);
    for (const x of delA) console.log(`   - ${x.a} vs ${x.b}`);

    // --- Fix B: real scheduled bouts that vanished from their event page.
    const stale = await tx`
      WITH ev AS (SELECT event_id, max(updated_at) AS mx FROM bout GROUP BY event_id)
      SELECT b.id FROM bout b
      JOIN ev ON ev.event_id = b.event_id
      JOIN event e ON e.id = b.event_id
      WHERE e.ufc_stats_id IS NOT NULL AND e.status = 'upcoming'
        AND b.status = 'scheduled' AND b.ufc_stats_id IS NOT NULL
        AND b.updated_at < ev.mx - interval '2 hours'
    `;
    const staleIds = stale.map((r) => r.id);
    if (staleIds.length) {
      await tx`UPDATE news_item SET related_bout_id = NULL WHERE related_bout_id = ANY(${staleIds}::uuid[])`;
      const delB = await tx`
        DELETE FROM bout b USING fighter fa, fighter fb, event e
        WHERE fa.id = b.fighter_a_id AND fb.id = b.fighter_b_id AND e.id = b.event_id
          AND b.id = ANY(${staleIds}::uuid[])
        RETURNING fa.name_en AS a, fb.name_en AS b, e.name AS ev
      `;
      console.log(`Fix B: deleted ${delB.length} vanished real bout(s):`);
      for (const x of delB) console.log(`   - ${x.a} vs ${x.b} — ${x.ev}`);
    } else {
      console.log("Fix B: nothing stale");
    }
  });

  // --- Re-verify ---
  const dups = await sql`
    WITH ub AS (
      SELECT b.id AS bout_id, b.fighter_a_id AS fa, b.fighter_b_id AS fb
      FROM bout b JOIN event e ON e.id = b.event_id
      WHERE b.status = 'scheduled' AND e.date >= current_date
    ), f AS (SELECT fa AS fid, bout_id FROM ub UNION ALL SELECT fb, bout_id FROM ub)
    SELECT fr.name_en, count(DISTINCT f.bout_id)::int AS n
    FROM f JOIN fighter fr ON fr.id = f.fid
    GROUP BY fr.id, fr.name_en HAVING count(DISTINCT f.bout_id) > 1
    ORDER BY n DESC
  `;
  console.log(
    dups.length === 0
      ? "\n✓ RE-VERIFY: every fighter has at most one upcoming bout"
      : "\n✗ STILL DUPLICATED:\n" + dups.map((d) => `   ${d.name_en} (${d.n})`).join("\n"),
  );
  await sql.end();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
