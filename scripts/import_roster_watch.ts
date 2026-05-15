/**
 * Imports roster.watch CSV exports into the fighter table.
 *
 * Reads:
 *   imports/roster_current.csv  (data.csv from roster.watch — current UFC roster)
 *   imports/roster_former.csv   (former_data.csv — ex-UFC fighters)
 *
 * Updates per fighter (matched by normalized name_en):
 *   - roster_status: 'active' (in current), 'released' (in former, no hof),
 *     'retired' (in former with hof=TRUE), or left as 'unknown' if no match.
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
    .replace(/[''`]/g, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNA(v: string | undefined | null): boolean {
  return !v || v === "NA" || v === "";
}

function parseIntOrNull(v: string): number | null {
  if (isNA(v)) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

interface UpdateRow {
  slug: string;
  roster_status: "active" | "released" | "retired";
  has_upcoming_bout: boolean;
  next_event_date: string | null;
  next_opponent_name: string | null;
  elo_roster_watch: number | null;
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
    let currentMatch = currentByName.get(norm);
    let formerMatch = formerByName.get(norm);

    if (!currentMatch && !formerMatch) {
      // Try alias-based match if our DB has alternate spellings.
      // This is a one-way map from alias -> slug; we already have the
      // slug, so the only useful direction here is checking if our
      // fighter has an alias that exists as a CSV name.
      // (We iterate the alias list lazily below.)
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
      });
    } else if (formerMatch) {
      matchedFormer++;
      const isRetired = formerMatch.hof === "TRUE";
      updates.push({
        slug: f.slug,
        roster_status: isRetired ? "retired" : "released",
        has_upcoming_bout: false,
        next_event_date: null,
        next_opponent_name: null,
        elo_roster_watch: parseIntOrNull(formerMatch.elo),
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
      });
      updatedSlugs.add(a.slug);
    } else if (fr) {
      matchedFormer++;
      matchedViaAlias++;
      const isRetired = fr.hof === "TRUE";
      updates.push({
        slug: a.slug,
        roster_status: isRetired ? "retired" : "released",
        has_upcoming_bout: false,
        next_event_date: null,
        next_opponent_name: null,
        elo_roster_watch: parseIntOrNull(fr.elo),
      });
      updatedSlugs.add(a.slug);
    }
  }

  console.log(`\nMatch results:`);
  console.log(`  current (active):   ${matchedCurrent}`);
  console.log(`  former (released/retired): ${matchedFormer}`);
  console.log(`  via alias:          ${matchedViaAlias}`);
  console.log(`  unmatched:          ${unmatched.length}`);

  // One transaction: reset everyone to 'unknown', then update matched
  // fighters. Atomic + keeps the pooler connection alive throughout.
  console.log(`\nApplying ${updates.length} updates in single transaction...`);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE fighter
      SET roster_status = 'unknown',
          has_upcoming_bout = false,
          next_event_date = NULL,
          next_opponent_name = NULL,
          elo_roster_watch = NULL
    `;
    let done = 0;
    for (const u of updates) {
      await tx`
        UPDATE fighter
        SET roster_status = ${u.roster_status}::roster_status,
            roster_status_updated_at = NOW(),
            has_upcoming_bout = ${u.has_upcoming_bout},
            next_event_date = ${u.next_event_date},
            next_opponent_name = ${u.next_opponent_name},
            elo_roster_watch = ${u.elo_roster_watch}
        WHERE slug = ${u.slug}
      `;
      done++;
      if (done % 250 === 0) {
        process.stdout.write(`  ${done}/${updates.length}\r`);
      }
    }
  });
  console.log(`\nUpdates applied.`);

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
