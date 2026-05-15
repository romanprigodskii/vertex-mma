/**
 * Imports imports/ufc_rankings_parsed.csv into ranking_snapshot.
 *
 * Wave 6C.1 task 4. The parser (parse_ufc_rankings.py) emits ~38k rows
 * across 233 biweekly Wayback snapshots (2017-01 → 2026-05). This script
 *
 *   - reads the CSV row-by-row,
 *   - resolves each fighter_name_raw → fighter.id, FILTERED BY GENDER:
 *       is_women=true  → only fighters with gender='female'
 *       is_women=false → only fighters with gender='male'
 *     (so e.g. Valentina Shevchenko at W-FlyW #1 doesn't accidentally
 *      collide with Brandon Moreno's name-similarity at men's FlyW #1),
 *   - upserts via ON CONFLICT on the new
 *     (snapshot_date, division, rank, fighter_name_raw, is_women)
 *     unique key — rerunning is idempotent.
 *
 * Matching strategy, in order:
 *   1. Exact match on normalised name_en, gender-scoped.
 *   2. Reversed-name (surname-first ↔ given-first), gender-scoped.
 *   3. fighter_alias table, gender-scoped via JOIN to fighter.
 *   4. pg_trgm similarity ≥ 0.7 against fighter.name_en, gender-scoped
 *      — one batched query at the end for the residual unmatched set.
 *
 * Unmatched rows are still INSERTED with fighter_id = NULL; the raw
 * name is preserved so a later re-match pass (or a manually-added
 * fighter_alias) can resolve it without a re-import.
 *
 * Halt point per spec: STOP after this script reports — do not run task 7
 * verification SQL until the dev reviews the report.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false });

const CSV_PATH = path.resolve("imports/ufc_rankings_parsed.csv");
const BATCH_SIZE = 500;
const TRGM_THRESHOLD = 0.7;

type CsvRow = {
  snapshotDate: string;
  division: string;
  isWomen: boolean;
  rank: number;
  fighterNameRaw: string;
  sourceUrl: string;
};

type FighterRow = {
  id: string;
  name_en: string;
  gender: "male" | "female";
};

// Letters that don't decompose under NFKD (so the combining-diacritic
// strip below can't reach them). Keep this list minimal and additive —
// only entries we've actually observed failing OR that are commonly
// seen in MMA roster names (Polish, Czech/Croatian/Vietnamese).
//   ł / Ł — UFC.com uses Polish "Jan Błachowicz"; UFCStats has plain l.
//   đ / Đ — Vietnamese/Croatian (e.g. "Đặng", "Marko Nikolić-Đorđević")
//           appear in roster.watch occasionally; defensive add.
const PRECOMPOSED_LATIN_MAP: Record<string, string> = {
  "ł": "l", "Ł": "L",
  "đ": "d", "Đ": "D",
};

function normalizeName(name: string): string {
  let s = name;
  for (const [from, to] of Object.entries(PRECOMPOSED_LATIN_MAP)) {
    s = s.replaceAll(from, to);
  }
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-''`._,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reversedName(normalized: string): string {
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length !== 2) return normalized;
  return `${parts[1]} ${parts[0]}`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function loadFighterIndex(): Promise<{
  byName: Map<string, FighterRow>; // gender-prefixed key: "m:<norm>" / "f:<norm>"
}> {
  const fighters = await sql<FighterRow[]>`
    SELECT id, name_en, gender::text AS gender FROM fighter
  `;
  const byName = new Map<string, FighterRow>();
  for (const f of fighters) {
    const prefix = f.gender === "female" ? "f:" : "m:";
    const norm = normalizeName(f.name_en);
    // First-write-wins. Duplicates (rare — would be two real fighters
    // sharing the exact same normalised name in the same gender) get
    // skipped here and fall through to a logged unmatched.
    if (!byName.has(prefix + norm)) byName.set(prefix + norm, f);
  }
  // Aliases — same gender prefix via the joined fighter row.
  const aliases = await sql<
    { alias: string; fighter_id: string; name_en: string; gender: string }[]
  >`
    SELECT fa.alias, fa.fighter_id, f.name_en, f.gender::text AS gender
    FROM fighter_alias fa JOIN fighter f ON f.id = fa.fighter_id
  `;
  for (const a of aliases) {
    const prefix = a.gender === "female" ? "f:" : "m:";
    const norm = normalizeName(a.alias);
    const key = prefix + norm;
    if (!byName.has(key)) {
      byName.set(key, {
        id: a.fighter_id, name_en: a.name_en,
        gender: a.gender as "male" | "female",
      });
    }
  }
  return { byName };
}

function readCsv(): Promise<CsvRow[]> {
  return new Promise((resolve, reject) => {
    const rows: CsvRow[] = [];
    const rl = createInterface({ input: createReadStream(CSV_PATH) });
    let header: string[] | null = null;
    rl.on("line", (line) => {
      if (!line) return;
      const fields = parseCsvLine(line);
      if (!header) { header = fields; return; }
      const rec: Record<string, string> = {};
      header.forEach((h, i) => { rec[h] = fields[i] ?? ""; });
      rows.push({
        snapshotDate: rec.snapshot_date,
        division: rec.division,
        isWomen: rec.is_women === "True",
        rank: Number(rec.rank),
        fighterNameRaw: rec.fighter_name_raw,
        sourceUrl: rec.source_url,
      });
    });
    rl.on("close", () => resolve(rows));
    rl.on("error", reject);
  });
}

async function trgmResolve(
  unresolvedNames: { name: string; isWomen: boolean }[],
): Promise<Map<string, string>> {
  // name -> fighter_id (one entry per unique unresolved name; gender
  // disambiguation is folded into the key so two fighters w/ the same
  // raw name across genders get separate trgm lookups).
  const result = new Map<string, string>();
  if (unresolvedNames.length === 0) return result;
  // Dedupe — many snapshots share the same fighter name.
  const unique = new Map<string, { name: string; isWomen: boolean }>();
  for (const u of unresolvedNames) {
    unique.set(`${u.isWomen ? "f" : "m"}:${u.name}`, u);
  }
  console.log(`  pg_trgm fallback: ${unique.size} unique unresolved names`);
  let resolved = 0;
  for (const [key, u] of unique) {
    const gender = u.isWomen ? "female" : "male";
    const rows = await sql<{ id: string; sim: number }[]>`
      SELECT id, similarity(name_en, ${u.name}) AS sim
      FROM fighter
      WHERE gender = ${gender}
        AND similarity(name_en, ${u.name}) >= ${TRGM_THRESHOLD}
      ORDER BY sim DESC
      LIMIT 1
    `;
    if (rows.length > 0) {
      result.set(key, rows[0].id);
      resolved++;
    }
  }
  console.log(`  pg_trgm resolved: ${resolved}/${unique.size}`);
  return result;
}

async function main() {
  if (!readFileSync(CSV_PATH, "utf8")) {
    throw new Error(`Empty CSV at ${CSV_PATH}`);
  }
  console.log("Loading fighter index...");
  const { byName } = await loadFighterIndex();
  console.log(`  ${byName.size} (name|alias, gender)→fighter entries`);

  console.log(`Reading ${CSV_PATH}...`);
  const rows = await readCsv();
  console.log(`  ${rows.length} rows`);

  // Pass 1+2+3 (in-memory): normalised exact, reversed, alias.
  type Resolved = CsvRow & { fighterId: string | null };
  const resolved: Resolved[] = [];
  let matchedExact = 0;
  let matchedReversed = 0;
  const unresolvedForTrgm: { name: string; isWomen: boolean }[] = [];

  for (const r of rows) {
    const prefix = r.isWomen ? "f:" : "m:";
    const norm = normalizeName(r.fighterNameRaw);
    let hit = byName.get(prefix + norm);
    if (hit) matchedExact++;
    if (!hit) {
      const rev = reversedName(norm);
      if (rev !== norm) {
        hit = byName.get(prefix + rev);
        if (hit) matchedReversed++;
      }
    }
    if (hit) {
      resolved.push({ ...r, fighterId: hit.id });
    } else {
      unresolvedForTrgm.push({ name: r.fighterNameRaw, isWomen: r.isWomen });
      resolved.push({ ...r, fighterId: null });
    }
  }

  // Pass 4: pg_trgm for the residual.
  const trgmHits = await trgmResolve(unresolvedForTrgm);
  let matchedTrgm = 0;
  for (const r of resolved) {
    if (r.fighterId !== null) continue;
    const key = `${r.isWomen ? "f" : "m"}:${r.fighterNameRaw}`;
    const id = trgmHits.get(key);
    if (id) { r.fighterId = id; matchedTrgm++; }
  }

  const matched = resolved.filter((r) => r.fighterId !== null).length;
  const unmatched = resolved.length - matched;
  console.log(`Resolution summary:`);
  console.log(`  exact:    ${matchedExact}`);
  console.log(`  reversed: ${matchedReversed}`);
  console.log(`  pg_trgm:  ${matchedTrgm}`);
  console.log(`  matched:  ${matched} / ${resolved.length}`);
  console.log(`  unmatched: ${unmatched}`);

  // Dedupe within the resolved set on the unique-constraint shape.
  // UFC.com occasionally double-publishes the same fighter at the same
  // rank in one snapshot (e.g. Serghei Spivac twice at HW #15 on
  // 2019-10-16). Postgres' ON CONFLICT DO UPDATE refuses to touch the
  // same target row twice in one INSERT, so we keep the first occurrence
  // and log the rest.
  const seen = new Set<string>();
  const beforeDedup = resolved.length;
  const dedupedRows: Resolved[] = [];
  for (const r of resolved) {
    const key = `${r.snapshotDate}|${r.division}|${r.rank}|${r.fighterNameRaw}|${r.isWomen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedRows.push(r);
  }
  if (dedupedRows.length < beforeDedup) {
    console.log(
      `Deduped ${beforeDedup - dedupedRows.length} source-data duplicate(s)`,
    );
  }

  // Upsert in batches.
  console.log(`Upserting in batches of ${BATCH_SIZE}...`);
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
    const slice = dedupedRows.slice(i, i + BATCH_SIZE);
    const values = slice.map((r) => ({
      snapshot_date: r.snapshotDate,
      division: r.division,
      is_women: r.isWomen,
      rank: r.rank,
      fighter_id: r.fighterId,
      fighter_name_raw: r.fighterNameRaw,
      source_url: r.sourceUrl,
    }));
    const result = await sql`
      INSERT INTO ranking_snapshot ${sql(values, "snapshot_date", "division", "is_women", "rank", "fighter_id", "fighter_name_raw", "source_url")}
      ON CONFLICT ON CONSTRAINT ranking_snapshot_unique
      DO UPDATE SET fighter_id = EXCLUDED.fighter_id
      RETURNING (xmax = 0) AS inserted_flag
    `;
    for (const row of result) {
      if ((row as { inserted_flag: boolean }).inserted_flag) inserted++;
      else updated++;
    }
    if ((i / BATCH_SIZE) % 10 === 0) {
      const done = Math.min(i + BATCH_SIZE, dedupedRows.length);
      console.log(`  ${done}/${dedupedRows.length}`);
    }
  }

  // Report.
  const [{ count: totalRows }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM ranking_snapshot
  `;
  const [{ count: rowsWithFighter }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM ranking_snapshot WHERE fighter_id IS NOT NULL
  `;
  const [{ count: distinctFighters }] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT fighter_id)::int AS count FROM ranking_snapshot
    WHERE fighter_id IS NOT NULL
  `;

  console.log("");
  console.log("=== Import report ===");
  console.log(`Rows attempted:  ${resolved.length}`);
  console.log(`Inserted:        ${inserted}`);
  console.log(`Updated:         ${updated}`);
  console.log(`Total in table:  ${totalRows}`);
  console.log(`With fighter_id: ${rowsWithFighter} (${((rowsWithFighter / totalRows) * 100).toFixed(1)}%)`);
  console.log(`Distinct fighters matched: ${distinctFighters}`);
  console.log(`Unmatched rows:  ${unmatched}`);

  if (unmatched > 0) {
    // Show top 20 unmatched names by frequency to highlight the easiest
    // wins for manual fighter_alias entries.
    const counts = new Map<string, { count: number; isWomen: boolean }>();
    for (const r of resolved) {
      if (r.fighterId !== null) continue;
      const key = `${r.isWomen ? "F" : "M"} ${r.fighterNameRaw}`;
      const cur = counts.get(key) ?? { count: 0, isWomen: r.isWomen };
      cur.count++;
      counts.set(key, cur);
    }
    const sorted = [...counts].sort((a, b) => b[1].count - a[1].count);
    console.log("");
    console.log(`Top unmatched names (${sorted.length} unique):`);
    for (const [key, { count }] of sorted.slice(0, 20)) {
      console.log(`  ${count.toString().padStart(4)} × ${key}`);
    }
  }

  console.log("");
  console.log("Halting before task 7 verification per spec.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
