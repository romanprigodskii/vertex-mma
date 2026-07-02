/**
 * Reconciles the curated championship data against reality:
 *
 *  1. LOSS RULE (auto-applied — objective): a champion who LOSES a completed
 *     bout in their own division after winning the belt loses it. The reign
 *     line in src/lib/championship-history.ts gets its endDate set to the
 *     bout date (endReason omitted = 'lost_bout' default), its defenses
 *     recounted, and the winner gets a new active reign starting that date.
 *     Unification is handled: if the winner held an active INTERIM belt in
 *     the division, that interim reign is closed on the same date and the
 *     new reign opens as undisputed. The rule cascades until stable (the
 *     new champion is immediately re-checked). This is the same
 *     "every in-division bout during a reign is a title fight" definition
 *     derive_title_fights.ts is built on.
 *
 *  2. DEFENSE RECOUNT (auto-applied): active reigns get defenses = number
 *     of in-division wins strictly after startDate.
 *
 *  3. UFC RANKINGS CONTROL (report; --apply-rankings to auto-add): compares
 *     active undisputed reigns per (division, gender) with the latest
 *     ranking_snapshot rank-0 rows (daily ufc.com/rankings scrape).
 *     Vacations/strips/new champs we can't derive from bout results are
 *     REPORTED for manual curation — endReason is a judgment call. With
 *     --apply-rankings, a UFC-listed champion for a division where we have
 *     NO active reign is auto-added (startDate = their latest in-division
 *     win) with an AUTO comment for review.
 *
 *  4. Regenerates src/lib/champions.ts (CURRENT_CHAMPIONS strip) from the
 *     post-reconcile active reigns + fighter gender from the DB — that file
 *     becomes GENERATED and its hand-frozen TODO-verify era ends.
 *
 * KNOWN LIMITATIONS (shared with derive_title_fights.ts where noted):
 *  - The loss rule and defense recount filter on bout.weight_class = the
 *    reign's division, so a title bout recorded as 'catchweight'
 *    (weight-miss) is invisible here — the rankings check (phase 3)
 *    surfaces those as a MISMATCH for manual curation. (Shared.)
 *  - Closures are NEVER auto-reverted: if a result is later overturned to
 *    NC (or a scrape glitch mislabels a bout), re-open the reign by hand —
 *    phase 3 flags the disagreement with UFC rankings until fixed.
 *  - A third party beating an ACTIVE interim champion is treated as an
 *    interim title transfer (interim champs realistically only fight
 *    title bouts in-division); the report marks it for review.
 *
 * Edits to championship-history.ts are line-targeted with asserted
 * exactly-one-match anchors (generate_waveNN pattern): any drift aborts the
 * whole run before a single byte is written. After this script, run
 * derive_title_fights.ts (recompute.sh step 1 does) so title-fights.ts and
 * the title_fight_bout table follow the new reigns.
 *
 * Flags: --dry-run (print everything, write nothing), --apply-rankings.
 * Cron: first step of ops/cron/recompute.sh; changed files are committed
 * and pushed by the recompute wrapper so the VPS git_sync doesn't wipe them.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { install as installDnsFallback } from "../src/lib/dns-fallback";
installDnsFallback();
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

import {
  CHAMPIONSHIP_HISTORY,
  type ChampionshipReign,
  type WeightClass,
} from "../src/lib/championship-history";

const DRY_RUN = process.argv.includes("--dry-run");
const APPLY_RANKINGS = process.argv.includes("--apply-rankings");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 3 });

const HISTORY_PATH = resolve(__dirname, "../src/lib/championship-history.ts");
const CHAMPIONS_PATH = resolve(__dirname, "../src/lib/champions.ts");

const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------

type FighterRow = {
  id: string;
  slug: string;
  name_en: string;
  gender: string;
};

async function fightersBySlug(
  slugs: string[],
): Promise<Map<string, FighterRow>> {
  if (slugs.length === 0) return new Map();
  const rows = await sql<FighterRow[]>`
    SELECT id::text AS id, slug, name_en, gender
    FROM fighter WHERE slug = ANY(${slugs})
  `;
  return new Map(rows.map((r) => [r.slug, r]));
}

async function fighterById(id: string): Promise<FighterRow | null> {
  const rows = await sql<FighterRow[]>`
    SELECT id::text AS id, slug, name_en, gender
    FROM fighter WHERE id = ${id}::uuid LIMIT 1
  `;
  return rows[0] ?? null;
}

type LossRow = { date: string; winner_id: string; bout_id: string };

/** Earliest completed in-division loss strictly after `afterDate`.
 *  Draws/NCs keep the belt (winner_id NULL); DQ losses lose it (Yan). */
async function firstLossAfter(
  fighterId: string,
  division: WeightClass,
  afterDate: string,
): Promise<LossRow | null> {
  const rows = await sql<LossRow[]>`
    SELECT (e.date AT TIME ZONE 'UTC')::date::text AS date,
           b.winner_id::text AS winner_id,
           b.id::text AS bout_id
    FROM bout b
    JOIN event e ON e.id = b.event_id
    WHERE b.status = 'completed'
      AND b.weight_class = ${division}::weight_class
      AND (b.fighter_a_id = ${fighterId}::uuid OR b.fighter_b_id = ${fighterId}::uuid)
      AND b.winner_id IS NOT NULL
      AND b.winner_id != ${fighterId}::uuid
      AND b.method IS DISTINCT FROM 'no_contest'
      AND (e.date AT TIME ZONE 'UTC')::date > ${afterDate}::date
    ORDER BY e.date ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** In-division wins strictly after `afterDate` and (when given) strictly
 *  before `untilDate` — i.e. title defenses between the win and the loss. */
async function winsBetween(
  fighterId: string,
  division: WeightClass,
  afterDate: string,
  untilDate: string | null,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM bout b
    JOIN event e ON e.id = b.event_id
    WHERE b.status = 'completed'
      AND b.weight_class = ${division}::weight_class
      AND b.winner_id = ${fighterId}::uuid
      AND (e.date AT TIME ZONE 'UTC')::date > ${afterDate}::date
      AND (${untilDate}::date IS NULL
           OR (e.date AT TIME ZONE 'UTC')::date < ${untilDate}::date)
  `;
  return rows[0]?.n ?? 0;
}

/** Latest in-division win date — startDate for a rankings-derived reign. */
async function latestWinDate(
  fighterId: string,
  division: WeightClass,
): Promise<string | null> {
  const rows = await sql<{ date: string }[]>`
    SELECT (e.date AT TIME ZONE 'UTC')::date::text AS date
    FROM bout b
    JOIN event e ON e.id = b.event_id
    WHERE b.status = 'completed'
      AND b.weight_class = ${division}::weight_class
      AND b.winner_id = ${fighterId}::uuid
    ORDER BY e.date DESC
    LIMIT 1
  `;
  return rows[0]?.date ?? null;
}

// ---------------------------------------------------------------------
// Source-file editing (asserted single-match anchors — abort on drift)
// ---------------------------------------------------------------------

type MutableReign = ChampionshipReign;

function reignLineIndex(lines: string[], r: ChampionshipReign): number {
  const hits = lines
    .map((line, i) => ({ line, i }))
    .filter(
      ({ line }) =>
        line.includes(`slug: "${r.slug}"`) &&
        line.includes(`weightClass: "${r.weightClass}"`) &&
        line.includes(`startDate: "${r.startDate}"`),
    );
  if (hits.length !== 1) {
    throw new Error(
      `reconcile: expected exactly 1 source line for reign ${r.slug}/${r.weightClass}/${r.startDate}, found ${hits.length} — aborting, no writes done`,
    );
  }
  return hits[0].i;
}

function closeReignLine(
  lines: string[],
  r: ChampionshipReign,
  endDate: string,
  defenses: number,
): void {
  const i = reignLineIndex(lines, r);
  if (!lines[i].includes("endDate: null")) {
    throw new Error(
      `reconcile: reign line for ${r.slug}/${r.weightClass} does not contain "endDate: null" — aborting`,
    );
  }
  lines[i] = lines[i]
    .replace("endDate: null", `endDate: "${endDate}"`)
    .replace(/defenses: \d+/, `defenses: ${defenses}`);
  // Mark the closure so a hand-curator sees the line was machine-edited
  // (existing comments can otherwise contradict the new endDate).
  const marker = `AUTO(reconcile ${TODAY}): closed ${endDate}`;
  lines[i] = /\/\//.test(lines[i])
    ? `${lines[i]}; ${marker}`
    : `${lines[i]} // ${marker}`;
}

function setDefensesOnLine(
  lines: string[],
  r: ChampionshipReign,
  defenses: number,
): void {
  const i = reignLineIndex(lines, r);
  lines[i] = lines[i].replace(/defenses: \d+/, `defenses: ${defenses}`);
}

/** Section header text inside championship-history.ts. */
function sectionHeader(division: WeightClass, isWomens: boolean): string {
  const name = division.replace(/_/g, " ").toUpperCase();
  return isWomens ? `// WOMEN'S ${name} (` : `// ${name}`;
}

function insertReignLine(
  lines: string[],
  entry: {
    slug: string;
    name: string;
    weightClass: WeightClass;
    isWomens: boolean;
    startDate: string;
    isInterim?: boolean;
    note: string;
  },
): void {
  const header = sectionHeader(entry.weightClass, entry.isWomens);
  const hits = lines
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line }) =>
      entry.isWomens ? line.startsWith(header) : line === header,
    );
  if (hits.length !== 1) {
    throw new Error(
      `reconcile: expected exactly 1 section header "${header}", found ${hits.length} — aborting`,
    );
  }
  // Header block is: // ==== / // NAME / // ==== — insert after the closing rule.
  const ruleIdx = hits[0].i + 1;
  if (!lines[ruleIdx]?.trim().startsWith("// ====")) {
    throw new Error(
      `reconcile: line after section header "${header}" is not the closing rule — aborting`,
    );
  }
  const interim = entry.isInterim ? ", isInterim: true" : "";
  lines.splice(
    ruleIdx + 1,
    0,
    `  { slug: "${entry.slug}", weightClass: "${entry.weightClass}", startDate: "${entry.startDate}", endDate: null, defenses: 0${interim} }, // AUTO(reconcile ${TODAY}): ${entry.note}`,
  );
}

// ---------------------------------------------------------------------
// champions.ts generation
// ---------------------------------------------------------------------

const DIVISION_LABEL: Record<string, string> = {
  strawweight: "Strawweight",
  flyweight: "Flyweight",
  bantamweight: "Bantamweight",
  featherweight: "Featherweight",
  lightweight: "Lightweight",
  welterweight: "Welterweight",
  middleweight: "Middleweight",
  light_heavyweight: "Light Heavyweight",
  heavyweight: "Heavyweight",
};
// Champion-strip short codes (existing champions.ts convention: FLW for
// flyweight, W- prefix for women — distinct from constants.WEIGHT_SHORT).
const STRIP_SHORT: Record<string, string> = {
  strawweight: "SW",
  flyweight: "FLW",
  bantamweight: "BW",
  featherweight: "FW",
  lightweight: "LW",
  welterweight: "WW",
  middleweight: "MW",
  light_heavyweight: "LHW",
  heavyweight: "HW",
};
// Strip display order: men heavy→fly, then women straw/fly/bantam/feather.
const MENS_ORDER: WeightClass[] = [
  "heavyweight",
  "light_heavyweight",
  "middleweight",
  "welterweight",
  "lightweight",
  "featherweight",
  "bantamweight",
  "flyweight",
];
const WOMENS_ORDER: WeightClass[] = [
  "strawweight",
  "flyweight",
  "bantamweight",
  "featherweight",
];

function renderChampionsFile(
  active: MutableReign[],
  meta: Map<string, FighterRow>,
): string {
  const entry = (r: MutableReign): string => {
    const isWomens = meta.get(r.slug)?.gender === "female";
    const division = isWomens
      ? `Women's ${DIVISION_LABEL[r.weightClass]}`
      : DIVISION_LABEL[r.weightClass];
    const short = isWomens
      ? `W-${STRIP_SHORT[r.weightClass]}`
      : STRIP_SHORT[r.weightClass];
    const interim = r.isInterim ? ", isInterim: true" : "";
    const name = meta.get(r.slug)?.name_en ?? r.slug;
    return `  { slug: "${r.slug}", division: "${division}", divisionShort: "${short}"${interim} }, // ${name}, since ${r.startDate}`;
  };

  const byGenderDivision = (gender: "male" | "female", order: WeightClass[]) =>
    order.flatMap((wc) =>
      active
        .filter(
          (r) =>
            r.weightClass === wc &&
            (meta.get(r.slug)?.gender === "female") === (gender === "female"),
        )
        // undisputed first, interim second
        .sort((a, b) => Number(a.isInterim === true) - Number(b.isInterim === true))
        .map(entry),
    );

  const lines = [
    ...byGenderDivision("male", MENS_ORDER),
    ...byGenderDivision("female", WOMENS_ORDER),
  ];

  return `/**
 * GENERATED by scripts/reconcile_champions.ts — do not hand-edit.
 * Derived from the active reigns in src/lib/championship-history.ts
 * (+ fighter gender from the DB). To change a champion, edit
 * championship-history.ts and run \`pnpm champions:reconcile\`.
 * (No timestamp here on purpose: the file must be byte-identical on
 * no-change days so the cron commit gate stays quiet.)
 */

export interface ChampionEntry {
  slug: string;
  division: string;
  divisionShort: string;
  isInterim?: boolean;
}

export const CURRENT_CHAMPIONS: readonly ChampionEntry[] = [
${lines.join("\n")}
];

export const CHAMPION_SLUGS: readonly string[] = CURRENT_CHAMPIONS.map(
  (c) => c.slug,
);

/** Quick lookup by slug for the strip rendering path. */
export const CHAMPION_BY_SLUG: Map<string, ChampionEntry> = new Map(
  CURRENT_CHAMPIONS.map((c) => [c.slug, c]),
);
`;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const reigns: MutableReign[] = CHAMPIONSHIP_HISTORY.map((r) => ({ ...r }));
  const lines = readFileSync(HISTORY_PATH, "utf8").split("\n");
  const report: string[] = [];
  let historyChanged = false;

  const metaBySlug = await fightersBySlug([
    ...new Set(reigns.map((r) => r.slug)),
  ]);
  const requireMeta = (slug: string): FighterRow => {
    const m = metaBySlug.get(slug);
    if (!m) throw new Error(`reconcile: fighter slug not in DB: ${slug}`);
    return m;
  };

  const isActive = (r: MutableReign) => r.endDate === null;

  // ---- Phase 1: loss rule (cascades until stable) --------------------
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const r of reigns.filter(isActive)) {
      // The filter is a snapshot: a unification close earlier in this pass
      // can deactivate a reign we haven't reached yet — re-check.
      if (!isActive(r)) continue;
      const holder = requireMeta(r.slug);
      const loss = await firstLossAfter(holder.id, r.weightClass, r.startDate);
      if (!loss) continue;

      const defenses = await winsBetween(
        holder.id,
        r.weightClass,
        r.startDate,
        loss.date,
      );
      closeReignLine(lines, r, loss.date, defenses);
      r.endDate = loss.date;
      r.defenses = defenses;
      historyChanged = true;

      const winner = await fighterById(loss.winner_id);
      if (!winner) throw new Error(`reconcile: winner ${loss.winner_id} not found`);
      report.push(
        `LOSS RULE: ${holder.name_en} lost the ${r.isInterim ? "interim " : ""}${r.weightClass} belt to ${winner.name_en} on ${loss.date} (defenses recounted: ${defenses})`,
      );

      // UFC has no mixed-gender bouts, so the winner's gender IS the
      // dethroned holder's gender. fighter.gender defaults to 'male' until
      // scripts/infer_fighter_gender.ts runs, so the DB value for a fresh
      // winner can be wrong — inherit from the curated holder instead
      // (drives the section placement AND the champions.ts grouping).
      const holderIsWomens = holder.gender === "female";
      if ((winner.gender === "female") !== holderIsWomens) {
        report.push(
          `  ⚠ gender mismatch: DB says ${winner.slug} is ${winner.gender} but they beat a ${holder.gender} champion — inheriting ${holder.gender}; run scripts/infer_fighter_gender.ts`,
        );
      }
      metaBySlug.set(winner.slug, { ...winner, gender: holder.gender });

      // Unification: the winner's own active interim belt folds into the
      // new undisputed reign.
      const winnerInterim = reigns.find(
        (x) =>
          x.slug === winner.slug &&
          x.weightClass === r.weightClass &&
          x.endDate === null &&
          x.isInterim === true,
      );
      if (winnerInterim) {
        const iDef = await winsBetween(
          winner.id,
          r.weightClass,
          winnerInterim.startDate,
          loss.date,
        );
        closeReignLine(lines, winnerInterim, loss.date, iDef);
        winnerInterim.endDate = loss.date;
        winnerInterim.defenses = iDef;
        report.push(
          `  ↳ unification: ${winner.name_en}'s interim reign closed on ${loss.date}`,
        );
      }

      const winnerActive = reigns.find(
        (x) =>
          x.slug === winner.slug &&
          x.weightClass === r.weightClass &&
          x.endDate === null,
      );
      if (!winnerActive) {
        // The belt-losing bout was interim-only? A win over an interim champ
        // yields an interim belt only in a pure interim bout — but the loss
        // rule fires for BOTH interim and undisputed reigns. New reign is
        // undisputed unless the CLOSED reign was interim-only AND an
        // undisputed champion still reigns in the division.
        const undisputedStillActive = reigns.some(
          (x) =>
            x.weightClass === r.weightClass &&
            x.endDate === null &&
            x.isInterim !== true &&
            (requireMeta(x.slug).gender === "female") === holderIsWomens,
        );
        const asInterim = r.isInterim === true && undisputedStillActive;
        insertReignLine(lines, {
          slug: winner.slug,
          name: winner.name_en,
          weightClass: r.weightClass,
          isWomens: holderIsWomens,
          startDate: loss.date,
          isInterim: asInterim,
          note: `beat ${holder.name_en}`,
        });
        reigns.push({
          slug: winner.slug,
          weightClass: r.weightClass,
          startDate: loss.date,
          endDate: null,
          defenses: 0,
          ...(asInterim ? { isInterim: true } : {}),
        });
        report.push(
          `  ↳ new ${asInterim ? "interim " : ""}champion: ${winner.name_en} (${r.weightClass}) since ${loss.date}`,
        );
      }
      changed = true;
    }
    if (!changed) break;
  }

  // ---- Phase 2: defense recount for ALL active reigns ----------------
  // Including reigns inserted this run: on a catch-up run (gap in cron)
  // the new champion may already have post-title-win defenses.
  for (const r of reigns.filter(isActive)) {
    const holder = requireMeta(r.slug);
    const n = await winsBetween(holder.id, r.weightClass, r.startDate, null);
    if (n !== r.defenses) {
      setDefensesOnLine(lines, r, n);
      report.push(
        `DEFENSES: ${holder.name_en} (${r.weightClass}${r.isInterim ? " interim" : ""}) ${r.defenses} → ${n}`,
      );
      r.defenses = n;
      historyChanged = true;
    }
  }

  // ---- Phase 3: UFC rankings control ---------------------------------
  const latest = await sql<{ d: string }[]>`
    SELECT MAX(snapshot_date)::text AS d FROM ranking_snapshot
  `;
  const snapshotDate = latest[0]?.d ?? null;
  if (snapshotDate) {
    const rank0 = await sql<
      { division: string; is_women: boolean; slug: string | null; raw: string }[]
    >`
      SELECT rs.division::text AS division, rs.is_women,
             f.slug, rs.fighter_name_raw AS raw
      FROM ranking_snapshot rs
      LEFT JOIN fighter f ON f.id = rs.fighter_id
      WHERE rs.snapshot_date = ${snapshotDate}::date AND rs.rank = 0
    `;
    report.push(
      `UFC RANKINGS CHECK (snapshot ${snapshotDate}, ${rank0.length} champion slots):`,
    );
    // The rankings pipeline is non-fatal at every step — a truncated page
    // can import a partial snapshot. Comparing against one would produce
    // false "OURS-ONLY, close the reign" advice for every missing slot.
    if (rank0.length < 8) {
      report.push(
        `  snapshot looks PARTIAL (${rank0.length}/11 champion slots) — skipping comparisons this run`,
      );
    } else {
    const boards: { division: WeightClass; isWomen: boolean }[] = [
      ...(
        [
          "flyweight",
          "bantamweight",
          "featherweight",
          "lightweight",
          "welterweight",
          "middleweight",
          "light_heavyweight",
          "heavyweight",
        ] as WeightClass[]
      ).map((division) => ({ division, isWomen: false })),
      ...(["strawweight", "flyweight", "bantamweight"] as WeightClass[]).map(
        (division) => ({ division, isWomen: true }),
      ),
    ];
    for (const { division, isWomen } of boards) {
      const ufc = rank0.find(
        (r) => r.division === division && r.is_women === isWomen,
      );
      const ours = reigns.find(
        (r) =>
          isActive(r) &&
          r.weightClass === division &&
          r.isInterim !== true &&
          (requireMeta(r.slug).gender === "female") === isWomen,
      );
      const label = `${isWomen ? "W-" : ""}${division}`;
      if (ufc?.slug && ours && ufc.slug === ours.slug) continue; // agree
      if (!ufc && !ours) continue; // both vacant

      if (ufc && ours && ufc.slug !== ours.slug) {
        report.push(
          `  MISMATCH ${label}: UFC lists ${ufc.raw}${ufc.slug ? ` (${ufc.slug})` : " (unresolved)"} but we have ${ours.slug} — review championship-history.ts by hand`,
        );
      } else if (ufc && !ours) {
        // Interim → undisputed promotion (announcement, not a bout):
        // the date is a judgment call, so this is NEVER auto-applied —
        // auto-adding an undisputed reign while the interim reign stays
        // active would duplicate the champion (and can collide anchors).
        const interimHolder = ufc.slug
          ? reigns.find(
              (x) =>
                isActive(x) &&
                x.weightClass === division &&
                x.isInterim === true &&
                x.slug === ufc.slug,
            )
          : undefined;
        if (interimHolder) {
          report.push(
            `  PROMOTION ${label}: UFC lists ${ufc.raw} as champion but we hold them as INTERIM — promote by hand: close the interim reign at the announcement date and add an undisputed reign`,
          );
        } else if (APPLY_RANKINGS && ufc.slug) {
          const f = metaBySlug.get(ufc.slug) ?? (await fightersBySlug([ufc.slug])).get(ufc.slug);
          if (f) {
            const start = (await latestWinDate(f.id, division)) ?? snapshotDate;
            insertReignLine(lines, {
              slug: f.slug,
              name: f.name_en,
              weightClass: division,
              isWomens: isWomen,
              startDate: start,
              note: `from UFC rankings ${snapshotDate} — REVIEW startDate/endReason of previous reign`,
            });
            reigns.push({
              slug: f.slug,
              weightClass: division,
              startDate: start,
              endDate: null,
              defenses: 0,
            });
            metaBySlug.set(f.slug, f);
            historyChanged = true;
            report.push(
              `  AUTO-ADDED ${label}: ${f.name_en} champion since ${start} (from UFC rankings) — review the previous reign's end`,
            );
          } else {
            report.push(`  UFC-ONLY ${label}: ${ufc.raw} — slug unresolved, add manually`);
          }
        } else {
          report.push(
            `  UFC-ONLY ${label}: UFC lists ${ufc.raw}${ufc.slug ? ` (${ufc.slug})` : ""} but we have no active reign — likely a missed title change (re-run with --apply-rankings or edit by hand)`,
          );
        }
      } else if (!ufc && ours) {
        report.push(
          `  OURS-ONLY ${label}: we list ${ours.slug} but UFC shows no champion in today's snapshot — if this persists across days it is a vacated/stripped belt; close the reign by hand (endReason is a judgment call)`,
        );
      }
    }
    } // partial-snapshot gate
  } else {
    report.push("UFC RANKINGS CHECK skipped: ranking_snapshot is empty");
  }

  // ---- Phase 4: write files ------------------------------------------
  const active = reigns.filter(isActive);
  const championsSource = renderChampionsFile(active, metaBySlug);
  const championsChanged =
    readFileSync(CHAMPIONS_PATH, "utf8") !== championsSource;

  console.log("\n===== reconcile_champions report =====");
  for (const l of report) console.log(l);
  console.log(
    `\nActive reigns after reconcile: ${active.length} (${active.filter((r) => r.isInterim).length} interim)`,
  );

  if (DRY_RUN) {
    console.log(
      `\n--dry-run: no files written (championship-history ${historyChanged ? "WOULD change" : "unchanged"}, champions.ts ${championsChanged ? "WOULD change" : "unchanged"})`,
    );
  } else {
    if (historyChanged) {
      writeFileSync(HISTORY_PATH, lines.join("\n"));
      console.log(`wrote ${HISTORY_PATH}`);
    }
    if (championsChanged) {
      writeFileSync(CHAMPIONS_PATH, championsSource);
      console.log(`wrote ${CHAMPIONS_PATH}`);
    }
    if (historyChanged) {
      console.log(
        "\nNEXT: run `pnpm tsx scripts/derive_title_fights.ts` (recompute.sh does this as its next step) so title-fights.ts + title_fight_bout follow the new reigns.",
      );
    }
    if (!historyChanged && !championsChanged) console.log("no changes");
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
