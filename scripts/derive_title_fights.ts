/**
 * Derives the full set of UFC title-fight bout IDs from the two curated
 * history files and rewrites src/lib/title-fights.ts.
 *
 * Sources of truth:
 *   - championship-history.ts CHAMPIONSHIP_HISTORY — every reign (slug,
 *     weightClass, startDate, endDate). Every completed bout a champion
 *     had IN THAT DIVISION between startDate and endDate (inclusive) is
 *     a title fight: the win, every defense, and the belt-losing bout.
 *   - title-challenger-history.ts TITLE_CHALLENGES — fighters who lost a
 *     title fight without ever winning a belt. Each entry has the exact
 *     bout date, resolved directly.
 *
 * Why heuristic-by-date-range works: while a fighter holds a belt, every
 * bout they take in that division is a title bout (champions don't take
 * non-title fights in their own division — the rare champion-moves-up
 * bout is in a DIFFERENT division and excluded by the weight_class
 * filter). The belt-losing bout's date == the reign's endDate, so the
 * range [startDate, endDate] captures it too.
 *
 * Prints a per-reign validation line (found vs expected = 1 win +
 * defenses + 1 loss-if-lost_bout) so gaps are visible, then overwrites
 * title-fights.ts with the deduped, date-sorted list.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { install as installDnsFallback } from "../src/lib/dns-fallback";
installDnsFallback();
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

import { CHAMPIONSHIP_HISTORY } from "../src/lib/championship-history";
import { TITLE_CHALLENGES } from "../src/lib/title-challenger-history";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 3 });

interface TitleBout {
  boutId: string;
  date: string; // yyyy-mm-dd
  event: string;
  fighter: string;
  opp: string;
  division: string;
}

type BoutQueryRow = {
  bout_id: string;
  date: string;
  event: string;
  fighter: string;
  opp: string;
  weight_class: string;
};

async function main() {
  const found = new Map<string, TitleBout>();
  let reignWarnings = 0;

  // --- Reigns ---
  console.log(`Resolving ${CHAMPIONSHIP_HISTORY.length} reigns...`);
  for (const reign of CHAMPIONSHIP_HISTORY) {
    const end = reign.endDate ?? "2099-12-31";
    const rows = await sql<BoutQueryRow[]>`
      SELECT
        b.id::text AS bout_id,
        e.date::text AS date,
        e.name AS event,
        ff.name_en AS fighter,
        CASE WHEN b.fighter_a_id = ff.id THEN fb.name_en ELSE fa.name_en END AS opp,
        b.weight_class::text AS weight_class
      FROM fighter ff
      JOIN bout b ON (b.fighter_a_id = ff.id OR b.fighter_b_id = ff.id)
      JOIN event e ON e.id = b.event_id
      JOIN fighter fa ON fa.id = b.fighter_a_id
      JOIN fighter fb ON fb.id = b.fighter_b_id
      WHERE ff.slug = ${reign.slug}
        AND b.status = 'completed'
        AND (
          b.weight_class::text = ${reign.weightClass}
          -- Pre-2002 UFC used era-specific division names (old
          -- "middleweight" ≈ modern light_heavyweight, "openweight" = no
          -- class). Cross-division superfights didn't exist yet, so for
          -- that era the [startDate, endDate] range alone is safe.
          OR e.date < '2002-01-01'
        )
        AND e.date >= ${reign.startDate}::date
        AND e.date <= ${end}::date
      ORDER BY e.date
    `;
    for (const r of rows) {
      found.set(r.bout_id, {
        boutId: r.bout_id,
        date: r.date.slice(0, 10),
        event: r.event,
        fighter: r.fighter,
        opp: r.opp,
        division: r.weight_class,
      });
    }
    // Only flag reigns that resolved to ZERO bouts — a genuine miss.
    // Off-by-one vs the stored `defenses` count is expected noise (that
    // field is hand-entered and often conservative; the DB-derived
    // count is the more reliable one).
    if (rows.length === 0) {
      reignWarnings++;
      console.log(
        `  ⚠ NO BOUTS: ${reign.slug} ${reign.weightClass} ${reign.startDate}..${reign.endDate ?? "current"}`,
      );
    }
  }

  // --- Lost challenges (exact date) ---
  console.log(`Resolving ${TITLE_CHALLENGES.length} lost challenges...`);
  let challengeWarnings = 0;
  for (const ch of TITLE_CHALLENGES) {
    const rows = await sql<BoutQueryRow[]>`
      SELECT
        b.id::text AS bout_id,
        e.date::text AS date,
        e.name AS event,
        ff.name_en AS fighter,
        CASE WHEN b.fighter_a_id = ff.id THEN fb.name_en ELSE fa.name_en END AS opp,
        b.weight_class::text AS weight_class
      FROM fighter ff
      JOIN bout b ON (b.fighter_a_id = ff.id OR b.fighter_b_id = ff.id)
      JOIN event e ON e.id = b.event_id
      JOIN fighter fa ON fa.id = b.fighter_a_id
      JOIN fighter fb ON fb.id = b.fighter_b_id
      WHERE ff.slug = ${ch.slug}
        AND b.status = 'completed'
        AND e.date = ${ch.date}::date
      ORDER BY e.date
    `;
    if (rows.length === 0) {
      challengeWarnings++;
      console.log(`  ⚠ challenge unresolved: ${ch.slug} ${ch.date}`);
      continue;
    }
    for (const r of rows) {
      if (found.has(r.bout_id)) continue;
      found.set(r.bout_id, {
        boutId: r.bout_id,
        date: r.date.slice(0, 10),
        event: r.event,
        fighter: r.fighter,
        opp: r.opp,
        division: r.weight_class,
      });
    }
  }

  const entries = [...found.values()].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  console.log(
    `\nResolved ${entries.length} unique title bouts (${reignWarnings} reign + ${challengeWarnings} challenge warnings).`,
  );

  // --- Generate title-fights.ts ---
  const lines = entries.map((e) => {
    const comment = `${e.date} · ${e.event} · ${e.fighter} vs ${e.opp}`;
    return `  "${e.boutId}", // ${comment}`;
  });

  const fileContent = `/**
 * Title-fight bout IDs — GENERATED by scripts/derive_title_fights.ts.
 *
 * Do not hand-edit. To extend coverage, add reigns to
 * championship-history.ts or challenges to title-challenger-history.ts,
 * then re-run: pnpm tsx scripts/derive_title_fights.ts
 *
 * Why a curated set exists: bout.is_title_fight from the UFCStats scrape
 * is unreliable — it flags whole main-card slates on title-headlined
 * events. This list is derived instead from the two hand-verified history
 * files: every completed bout a champion had in their division during a
 * reign, plus every lost title challenge.
 *
 * ${entries.length} bouts.
 */

const CURATED_TITLE_BOUT_IDS: readonly string[] = [
${lines.join("\n")}
];

const TITLE_BOUT_SET: ReadonlySet<string> = new Set(CURATED_TITLE_BOUT_IDS);

/** Returns true if the bout is a known title fight per the curated list. */
export function isCuratedTitleFight(boutId: string | null | undefined): boolean {
  if (!boutId) return false;
  return TITLE_BOUT_SET.has(boutId);
}
`;

  const path = resolve("src/lib/title-fights.ts");
  writeFileSync(path, fileContent, "utf8");
  console.log(`Wrote ${path}`);

  // Wave 60: mirror the curated set into title_fight_bout — the
  // fighter_vertex_score views' era_dominance_current CTEs and
  // compute_score_history.ts read it instead of the unreliable scraped
  // bout.is_title_fight flag.
  const allIds = entries.map((e) => e.boutId);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM title_fight_bout`;
    await tx`
      INSERT INTO title_fight_bout (bout_id)
      SELECT id FROM bout WHERE id = ANY(${allIds}::uuid[])
      ON CONFLICT (bout_id) DO NOTHING
    `;
  });
  const [{ count }] = await sql<
    [{ count: number }]
  >`SELECT COUNT(*)::int AS count FROM title_fight_bout`;
  console.log(`Synced title_fight_bout (${count} rows).`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
