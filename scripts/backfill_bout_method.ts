/**
 * Wave 16.2: backfill bout.method for completed bouts that still carry
 * NULL after the scraper Wave 16.1 re-pull populated bout.method_detail.
 *
 * The mapping logic mirrors map_method() in
 * scripts/scraper/src/utils/methods.py — keep the two in sync if either
 * changes. The script is idempotent: rows with non-NULL method are
 * skipped (WHERE method IS NULL), and re-running it on already-
 * backfilled rows is a no-op.
 *
 * After this script runs, re-materialise both vertex_score views so
 * finishing_dominance_score / _decayed pick up the recovered finishes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

function mapMethod(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase();

  // Exact-match table (mirrors EXACT_MAP in methods.py).
  const exact: Record<string, string> = {
    "KO/TKO": "ko",
    KO: "ko",
    TKO: "tko",
    SUBMISSION: "submission",
    SUB: "submission",
    "U-DEC": "decision_unanimous",
    "DECISION - UNANIMOUS": "decision_unanimous",
    "S-DEC": "decision_split",
    "DECISION - SPLIT": "decision_split",
    "M-DEC": "decision_majority",
    "DECISION - MAJORITY": "decision_majority",
    DRAW: "draw",
    "NO CONTEST": "no_contest",
    DQ: "dq",
    // CNC ("Could Not Continue") is a No Contest ruling, not a TKO —
    // see map_method() in methods.py for the full rationale.
    "COULD NOT CONTINUE": "no_contest",
    OVERTURNED: "no_contest",
    CNC: "no_contest",
  };
  if (exact[upper]) return exact[upper];

  // Prefix matches. NO space requirement — UFCStats detail pages
  // concatenate the bucket label directly with the technique name
  // ("SUBRear Naked Choke", "KO/TKOPunches", "OverturnedGuillotine Choke").
  if (
    upper.startsWith("KO/TKO") ||
    upper.startsWith("TKO") ||
    upper.startsWith("KO")
  ) {
    return "ko";
  }
  if (upper.startsWith("SUB")) return "submission";
  if (upper.startsWith("OVERTURNED")) return "no_contest";
  if (upper.startsWith("CNC")) return "no_contest";

  if (upper.includes("UNANIMOUS") || upper.startsWith("U-DEC"))
    return "decision_unanimous";
  if (upper.includes("SPLIT") || upper.startsWith("S-DEC"))
    return "decision_split";
  if (upper.includes("MAJORITY") || upper.startsWith("M-DEC"))
    return "decision_majority";

  if (upper.includes("DRAW")) return "draw";
  if (upper.includes("NO CONTEST")) return "no_contest";
  if (upper.startsWith("DQ") || upper.includes("DISQUALIFICATION"))
    return "dq";
  if (upper.includes("COULD NOT CONTINUE")) return "no_contest";

  return null;
}

async function main() {
  const rows = await sql<
    Array<{ id: string; method_detail: string | null }>
  >`
    SELECT id::text, method_detail
    FROM bout
    WHERE status = 'completed'
      AND method IS NULL
      AND method_detail IS NOT NULL
  `;
  console.log(`Candidates with NULL method + method_detail set: ${rows.length}`);

  // Bucket updates by mapped value so we can run one UPDATE per enum
  // value instead of one per row (2697 → 6 queries).
  const buckets = new Map<string, string[]>();
  let stillNull = 0;
  const stillNullSamples = new Map<string, number>();
  for (const r of rows) {
    const mapped = mapMethod(r.method_detail);
    if (mapped) {
      const arr = buckets.get(mapped) ?? [];
      arr.push(r.id);
      buckets.set(mapped, arr);
    } else {
      stillNull += 1;
      const sample = r.method_detail ?? "<NULL>";
      stillNullSamples.set(sample, (stillNullSamples.get(sample) ?? 0) + 1);
    }
  }

  let totalUpdated = 0;
  for (const [method, ids] of buckets) {
    const result = await sql`
      UPDATE bout SET method = ${method}::bout_method
      WHERE id = ANY(${ids}::uuid[])
        AND method IS NULL
    `;
    console.log(`  ${method.padEnd(22)} ${String(result.count).padStart(5)} rows`);
    totalUpdated += result.count;
  }

  console.log(`\nBackfilled ${totalUpdated} bouts. Still NULL: ${stillNull}.`);
  if (stillNull > 0) {
    console.log("Unmappable method_detail samples (count):");
    const sortedSamples = [...stillNullSamples.entries()].sort(
      (a, b) => b[1] - a[1],
    );
    for (const [detail, count] of sortedSamples.slice(0, 20)) {
      console.log(`  ${String(count).padStart(4)}  '${detail}'`);
    }
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
