/**
 * Imports roster.watch CSV exports into the fighter table.
 *
 * Reads:
 *   imports/roster_current.csv  (data.csv from roster.watch — current UFC roster)
 *   imports/roster_former.csv   (former_data.csv — ex-UFC fighters)
 *
 * Roster status, derived per fighter:
 *   - 'active'   for fighters in roster_current.csv
 *   - 'retired'  for fighters in roster_former.csv with hof='TRUE'
 *                (Hall of Famers and other genuine retirees — ~40 of 2078)
 *                AND for fighters not found in either CSV (older / obscure
 *                ancient fighters; safer to keep them off the active
 *                leaderboard than to surface them as released).
 *   - 'released' for fighters in roster_former.csv with hof='NA'
 *                (the bulk of former_data.csv — fighters cut from the roster
 *                without a HoF or formal-retirement classification).
 *
 * The split was added in Wave 6C.1 task 5. Before then the importer
 * collapsed all of former_data.csv into 'retired', leaving the 'released'
 * enum value unused (0 rows). The 'inactive' / 'unknown' enum values
 * remain reserved for a future UI without requiring a schema change.
 *
 * Other fields touched per fighter:
 *   - roster_status_updated_at = NOW()
 *   - has_upcoming_bout, next_event_date, next_opponent_name (current only)
 *   - elo_roster_watch (cross-reference ELO, not used in Vertex Score)
 *
 * Does NOT touch championship_pedigree — that's curated in
 * src/lib/championship-history.ts and backfilled by
 * scripts/compute_championship_pedigree.ts.
 *
 * Re-runnable. The next refresh: drop fresh data.csv + former_data.csv into
 * imports/ and run `pnpm roster:import`.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(content: string): Record<string, string>[] {
  // roster.watch exports use CRLF; normalize to LF first.
  const norm = content.replace(/\r\n?/g, "\n");
  // CSV cells may contain embedded newlines inside quoted fields, but
  // roster.watch exports don't — so a naive line split is safe here.
  const lines = norm.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length === 0 || fields.every((f) => f === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = fields[j] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Treat -, ', ', `, ., , and _ as word separators so "Cortes-Acosta"
    // matches "Cortes Acosta" and "O'Malley" matches "OMalley".
    .replace(/[-''`._,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Surname-first ↔ given-first retry. Two-word names only — for longer
 *  names the orderings diverge too quickly for a simple swap to help. */
function reversedName(normalized: string): string {
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length !== 2) return normalized;
  return `${parts[1]} ${parts[0]}`;
}

/** Map a former_data.csv row's hof column to a roster_status. The column
 *  is "TRUE" for Hall-of-Famers and other genuine retirees and "NA" for
 *  released-but-not-retired fighters. */
function formerStatus(row: Record<string, string>): "retired" | "released" {
  return row.hof === "TRUE" ? "retired" : "released";
}

/** Pull peak_rank / peak_p4p / streak from a roster CSV row. Both the
 *  current-roster and former-roster CSVs use the same column names for
 *  these. roster.watch encodes "was champion" as -1 in peak_rank/peak_p4p
 *  and signed integers for streak (positive = win streak). */
function extractRankFields(row: Record<string, string>): {
  peak_rank: number | null;
  peak_p4p: number | null;
  current_streak: number | null;
} {
  return {
    peak_rank: parseIntOrNull(row.peak_rank ?? ""),
    peak_p4p: parseIntOrNull(row.peak_p4p ?? ""),
    current_streak: parseIntOrNull(row.streak ?? ""),
  };
}

// DB-name → CSV-name aliases for fighters whose roster.watch entry uses a
// fight-name pseudonym instead of their legal name. Add new aliases here
// as we discover them in the post-import "Unmatched" log. Keys AND values
// are normalised (lowercase, no punctuation) — match the output of
// normalizeName above. Intentionally small; fuzzy matching is the wrong
// escape hatch on 2700×2700.
const NAME_ALIASES: Record<string, string> = {
  "patricio pitbull": "patricio freire",
  "cristiane justino": "cris cyborg",
  "jacare souza": "ronaldo souza",
  "zach reese": "zachary reese",
  "xiong jingnan": "jingnan xiong",
};

function isNA(v: string | undefined | null): boolean {
  return !v || v === "NA" || v === "";
}

function parseIntOrNull(v: string): number | null {
  if (isNA(v)) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Wave 6A.5b: roster_status emitted by this importer collapses to a
// binary active/retired view. The granular enum (released/inactive/
// unknown) stays in the DB for future use; the importer just no longer
// writes those values. Anything not on the current roster bulk-resets
// to 'retired' before the matched updates run.
interface UpdateRow {
  slug: string;
  roster_status: "active" | "retired" | "released";
  has_upcoming_bout: boolean;
  next_event_date: string | null;
  next_opponent_name: string | null;
  elo_roster_watch: number | null;
  // Wave 6C.2: roster.watch's "rank" / "peak_rank" / "streak" columns,
  // surfaced for the rank-at-bout pre-2017 fallback (peak_rank) and the
  // current_streak_bonus in fighter_vertex_score.
  peak_rank: number | null;
  peak_p4p: number | null;
  current_streak: number | null;
}

async function main() {
  const currentPath = path.resolve("imports/roster_current.csv");
  const formerPath = path.resolve("imports/roster_former.csv");

  const currentRows = parseCsv(readFileSync(currentPath, "utf8"));
  const formerRows = parseCsv(readFileSync(formerPath, "utf8"));

  console.log(
    `Loaded ${currentRows.length} current + ${formerRows.length} former fighters from CSVs`,
  );

  const currentByName = new Map<string, Record<string, string>>();
  const formerByName = new Map<string, Record<string, string>>();
  for (const r of currentRows) {
    if (r.fighter) currentByName.set(normalizeName(r.fighter), r);
  }
  for (const r of formerRows) {
    if (r.fighter) formerByName.set(normalizeName(r.fighter), r);
  }

  const dbFighters = await sql<
    { slug: string; name_en: string; weight_class_primary: string | null }[]
  >`SELECT slug, name_en, weight_class_primary FROM fighter`;

  console.log(`DB fighters: ${dbFighters.length}`);

  // Also pull aliases for fallback matching.
  const dbAliases = await sql<{ fighter_id: string; alias: string; slug: string }[]>`
    SELECT fa.fighter_id, fa.alias, f.slug
    FROM fighter_alias fa
    JOIN fighter f ON f.id = fa.fighter_id
  `;
  const aliasMap = new Map<string, string>(); // normalized alias -> slug
  for (const a of dbAliases) {
    aliasMap.set(normalizeName(a.alias), a.slug);
  }

  const updates: UpdateRow[] = [];
  let matchedCurrent = 0;
  let matchedFormer = 0;
  let matchedViaAlias = 0;
  const unmatched: string[] = [];

  for (const f of dbFighters) {
    const norm = normalizeName(f.name_en);
    // Try the normalized name, then a manual pseudonym alias, then a
    // surname-first swap. dedupe so a 1-word name doesn't probe the
    // map three times for the same key.
    const tries = [norm, NAME_ALIASES[norm], reversedName(norm)].filter(
      (s, i, arr): s is string => Boolean(s) && arr.indexOf(s) === i,
    );
    let currentMatch: Record<string, string> | undefined;
    let formerMatch: Record<string, string> | undefined;
    for (const candidate of tries) {
      if (!currentMatch) currentMatch = currentByName.get(candidate);
      if (!formerMatch) formerMatch = formerByName.get(candidate);
      if (currentMatch || formerMatch) break;
    }

    if (currentMatch) {
      matchedCurrent++;
      const hasUpcoming = !isNA(currentMatch.next_date);
      updates.push({
        slug: f.slug,
        roster_status: "active",
        has_upcoming_bout: hasUpcoming,
        next_event_date: hasUpcoming ? currentMatch.next_date : null,
        next_opponent_name: hasUpcoming
          ? currentMatch.next_opp
          : null,
        elo_roster_watch: parseIntOrNull(currentMatch.elo),
        ...extractRankFields(currentMatch),
      });
    } else if (formerMatch) {
      matchedFormer++;
      updates.push({
        slug: f.slug,
        roster_status: formerStatus(formerMatch),
        has_upcoming_bout: false,
        next_event_date: null,
        next_opponent_name: null,
        elo_roster_watch: parseIntOrNull(formerMatch.elo),
        ...extractRankFields(formerMatch),
      });
    } else {
      unmatched.push(f.name_en);
    }
  }

  // Second pass: try aliases for unmatched DB fighters.
  // (Each fighter_alias row points to our slug; if any alias normalizes
  // to a CSV name, use it.)
  const updatedSlugs = new Set(updates.map((u) => u.slug));
  for (const a of dbAliases) {
    if (updatedSlugs.has(a.slug)) continue;
    const norm = normalizeName(a.alias);
    const c = currentByName.get(norm);
    const fr = formerByName.get(norm);
    if (c) {
      matchedCurrent++;
      matchedViaAlias++;
      const hasUpcoming = !isNA(c.next_date);
      updates.push({
        slug: a.slug,
        roster_status: "active",
        has_upcoming_bout: hasUpcoming,
        next_event_date: hasUpcoming ? c.next_date : null,
        next_opponent_name: hasUpcoming ? c.next_opp : null,
        elo_roster_watch: parseIntOrNull(c.elo),
        ...extractRankFields(c),
      });
      updatedSlugs.add(a.slug);
    } else if (fr) {
      matchedFormer++;
      matchedViaAlias++;
      updates.push({
        slug: a.slug,
        roster_status: formerStatus(fr),
        has_upcoming_bout: false,
        next_event_date: null,
        next_opponent_name: null,
        elo_roster_watch: parseIntOrNull(fr.elo),
        ...extractRankFields(fr),
      });
      updatedSlugs.add(a.slug);
    }
  }

  // Add unmatched DB fighters to the updates list as explicit 'retired'.
  // This way every fighter gets its row in the temp table and the bulk
  // UPDATE touches all 2697 rows in one statement — no separate reset
  // query (which itself hit statement_timeout on the pooler).
  const updatedSlugs2 = new Set(updates.map((u) => u.slug));
  for (const f of dbFighters) {
    if (updatedSlugs2.has(f.slug)) continue;
    updates.push({
      slug: f.slug,
      roster_status: "retired",
      has_upcoming_bout: false,
      next_event_date: null,
      next_opponent_name: null,
      elo_roster_watch: null,
      peak_rank: null,
      peak_p4p: null,
      current_streak: null,
    });
  }

  console.log(`\nMatch results:`);
  console.log(`  current (active):   ${matchedCurrent}`);
  console.log(`  former (split):     ${matchedFormer}`);
  console.log(`  via alias:          ${matchedViaAlias}`);
  console.log(`  unmatched:          ${unmatched.length}`);
  console.log(`  total updates:      ${updates.length}`);

  // Bulk update via a temp table. Row-by-row UPDATE through the Supabase
  // session pooler exceeded statement_timeout at ~1400 rows, and even a
  // single "UPDATE fighter SET roster_status='retired'" reset hit the
  // same limit. The temp-table-and-join pattern stays well under the
  // server timeout because each individual statement is fast.
  console.log(`\nApplying ${updates.length} updates via temp table...`);
  await sql.begin(async (tx) => {
    await tx`
      CREATE TEMP TABLE _roster_updates (
        slug text PRIMARY KEY,
        roster_status text NOT NULL,
        has_upcoming_bout boolean NOT NULL,
        next_event_date date,
        next_opponent_name text,
        elo_roster_watch integer,
        peak_rank smallint,
        peak_p4p smallint,
        current_streak smallint
      ) ON COMMIT DROP
    `;

    // postgres-js bulk-insert helper: sql(rows, ...columnNames).
    await tx`
      INSERT INTO _roster_updates ${tx(
        updates,
        "slug",
        "roster_status",
        "has_upcoming_bout",
        "next_event_date",
        "next_opponent_name",
        "elo_roster_watch",
        "peak_rank",
        "peak_p4p",
        "current_streak",
      )}
    `;

    await tx`
      UPDATE fighter AS f
      SET roster_status = u.roster_status::roster_status,
          roster_status_updated_at = NOW(),
          has_upcoming_bout = u.has_upcoming_bout,
          next_event_date = u.next_event_date,
          next_opponent_name = u.next_opponent_name,
          elo_roster_watch = u.elo_roster_watch,
          peak_rank = u.peak_rank,
          peak_p4p = u.peak_p4p,
          current_streak = u.current_streak
      FROM _roster_updates u
      WHERE f.slug = u.slug
    `;
  });
  console.log(`Updates applied.`);

  // Verification
  const counts = await sql<{ roster_status: string; n: number }[]>`
    SELECT roster_status::text, COUNT(*)::int AS n
    FROM fighter
    GROUP BY roster_status
    ORDER BY n DESC
  `;
  console.log(`\nFinal roster_status distribution:`);
  for (const r of counts) {
    console.log(`  ${r.roster_status.padEnd(10)} ${r.n}`);
  }

  const [{ count: upcoming }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM fighter WHERE has_upcoming_bout = true
  `;
  console.log(`  has_upcoming_bout: ${upcoming}`);

  // Spot-check key fighters
  const spot = await sql<
    {
      slug: string;
      name_en: string;
      roster_status: string;
      has_upcoming_bout: boolean;
      next_event_date: string | null;
      next_opponent_name: string | null;
      elo_roster_watch: number | null;
    }[]
  >`
    SELECT slug, name_en, roster_status::text, has_upcoming_bout, next_event_date,
           next_opponent_name, elo_roster_watch
    FROM fighter
    WHERE slug IN ('islam-makhachev', 'ilia-topuria', 'alex-pereira',
                   'carlos-ulberg', 'sean-strickland', 'tom-aspinall',
                   'magomed-ankalaev', 'jingnan-xiong', 'jon-jones',
                   'khabib-nurmagomedov', 'amanda-nunes', 'henry-cejudo')
    ORDER BY name_en
  `;
  console.log(`\nSpot-check:`);
  for (const r of spot) {
    const next = r.has_upcoming_bout
      ? ` next=${r.next_event_date} ${r.next_opponent_name}`
      : "";
    console.log(
      `  ${r.name_en.padEnd(28)} ${r.roster_status.padEnd(10)} elo=${r.elo_roster_watch ?? "—"}${next}`,
    );
  }

  if (unmatched.length > 0) {
    console.log(`\nUnmatched DB fighters (first 20):`);
    for (const name of unmatched.slice(0, 20)) {
      console.log(`  ${name}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => sql.end());
