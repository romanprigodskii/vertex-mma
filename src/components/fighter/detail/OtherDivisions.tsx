import type { FighterDivisionalScoreRow } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

const WEIGHT_LABEL: Record<string, string> = {
  strawweight: "Strawweight",
  flyweight: "Flyweight",
  bantamweight: "Bantamweight",
  featherweight: "Featherweight",
  lightweight: "Lightweight",
  welterweight: "Welterweight",
  middleweight: "Middleweight",
  light_heavyweight: "Light Heavyweight",
  heavyweight: "Heavyweight",
  catchweight: "Catchweight",
  openweight: "Openweight",
};

const WEIGHT_SHORT: Record<string, string> = {
  strawweight: "STR",
  flyweight: "FLY",
  bantamweight: "BW",
  featherweight: "FW",
  lightweight: "LW",
  welterweight: "WW",
  middleweight: "MW",
  light_heavyweight: "LHW",
  heavyweight: "HW",
  catchweight: "CW",
  openweight: "OW",
};

const STATUS_LABEL: Record<FighterDivisionalScoreRow["divisional_status"], string> = {
  current: "Current",
  provisional: "Provisional",
  former: "Former",
};

interface OtherDivisionsProps {
  rows: FighterDivisionalScoreRow[];
  currentDivision: string | null;
}

/**
 * Wave 14B.2 — sidebar/footer block summarising the fighter's score in
 * every division OTHER than the one driving the hero. Each chip surfaces
 * the divisional vertex_score, the status badge (current / provisional
 * / former), and a muted style when the row is ineligible for active
 * ranking display (`in_active_ranking = FALSE` — moved-up fighters in
 * old divisions, retired fighters, etc.).
 */
export function OtherDivisions({ rows, currentDivision }: OtherDivisionsProps) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Scores in other divisions"
      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4"
    >
      <h3 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        Other divisions
      </h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const label = WEIGHT_LABEL[row.division] ?? row.division;
          const short = WEIGHT_SHORT[row.division] ?? row.division.toUpperCase();
          const inactive = !row.in_active_ranking;
          const isCurrentDivision = row.division === currentDivision;
          return (
            <li
              key={row.division}
              aria-label={`${label}: ${STATUS_LABEL[row.divisional_status]} rating ${row.vertex_score ?? "—"}, ${row.bouts_in_division} bouts`}
              className={cn(
                "flex items-center justify-between gap-3 rounded-sm border border-foreground/10 bg-background-base/40 px-3 py-2",
                inactive ? "opacity-60" : null,
              )}
            >
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                  <span className="font-display text-sm uppercase tracking-tight text-foreground">
                    {short}
                  </span>
                  {isCurrentDivision ? (
                    <span className="font-mono text-[9px] uppercase tracking-widest text-primary">
                      Active
                    </span>
                  ) : null}
                </span>
                <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {STATUS_LABEL[row.divisional_status]}
                  <span aria-hidden className="mx-1 text-foreground-subtle/40">
                    ·
                  </span>
                  {row.bouts_in_division} bouts
                </span>
              </div>
              <span
                className={cn(
                  "font-display tabular text-2xl leading-none",
                  inactive ? "text-foreground-muted" : "text-foreground",
                )}
              >
                {row.vertex_score ?? "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
