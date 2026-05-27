import { getTranslations } from "next-intl/server";

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

const STATUS_KEY: Record<
  FighterDivisionalScoreRow["divisional_status"],
  "statusCurrent" | "statusProvisional" | "statusFormer"
> = {
  current: "statusCurrent",
  provisional: "statusProvisional",
  former: "statusFormer",
};

interface OtherDivisionsProps {
  rows: FighterDivisionalScoreRow[];
  currentDivision: string | null;
}

export async function OtherDivisions({ rows, currentDivision }: OtherDivisionsProps) {
  if (rows.length === 0) return null;
  const t = await getTranslations("otherDivisions");
  const tWeight = await getTranslations("weight");
  return (
    <section
      aria-label={t("aria")}
      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4"
    >
      <h3 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        {t("heading")}
      </h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const key = row.division;
          const label = tWeight.has(key)
            ? tWeight(key as "lightweight")
            : WEIGHT_LABEL[row.division] ?? row.division;
          const short = WEIGHT_SHORT[row.division] ?? row.division.toUpperCase();
          const inactive = !row.in_active_ranking;
          const isCurrentDivision = row.division === currentDivision;
          const statusLabel = t(STATUS_KEY[row.divisional_status]);
          return (
            <li
              key={row.division}
              aria-label={t("rowAria", {
                division: label,
                status: statusLabel,
                score: row.vertex_score ?? "—",
                bouts: row.bouts_in_division,
              })}
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
                      {t("active")}
                    </span>
                  ) : null}
                </span>
                <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {statusLabel}
                  <span aria-hidden className="mx-1 text-foreground-subtle/40">
                    ·
                  </span>
                  {t("boutsCount", { n: row.bouts_in_division })}
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
