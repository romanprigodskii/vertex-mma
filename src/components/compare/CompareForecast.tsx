import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { clampHeadline } from "@/lib/vertex-tier";

interface Props {
  fighterAName: string;
  fighterBName: string;
  probA: number;
  probB: number;
  scoreA: number;
  scoreB: number;
  basis: "all_time" | "current";
}

/**
 * The FREE win-probability teaser on the Compare page. Shows only the win
 * split (who's favoured, by how much) from the Vertex Score gap, and routes
 * users to the paid Simulation for the full method / rounds / Monte-Carlo
 * breakdown. Deliberately does NOT reproduce any of that premium depth here.
 */
export function CompareForecast({
  fighterAName,
  fighterBName,
  probA,
  probB,
  scoreA,
  scoreB,
  basis,
}: Props) {
  const t = useTranslations("compare");
  // The win split is computed from the RAW score gap (SCORE_SCALE is tuned on
  // raw points), but the numbers we PRINT must match the clamped 0–100 headline
  // shown on cards / profile / search. Clamp at the display point, like
  // FighterCard does — never leak an all-time score above 100.
  const displayScoreA = clampHeadline(scoreA) ?? scoreA;
  const displayScoreB = clampHeadline(scoreB) ?? scoreB;
  const pctA = Math.round(probA * 100);
  const pctB = 100 - pctA;
  const even = Math.abs(pctA - 50) <= 2;
  const aFav = probA >= probB;
  const favName = aFav ? fighterAName : fighterBName;
  const favPct = Math.max(pctA, pctB);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <p className="text-center font-display text-xl uppercase tracking-tight text-foreground">
        {even
          ? t("forecastEven")
          : t("forecastLeanFull", { name: favName, pct: favPct })}
      </p>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2 font-sans text-xs">
          <span className="truncate text-foreground">{fighterAName}</span>
          <span className="truncate text-right text-foreground">
            {fighterBName}
          </span>
        </div>
        <div
          className="flex h-7 w-full overflow-hidden rounded-md border border-foreground/10"
          role="img"
          aria-label={`${fighterAName} ${pctA}% — ${fighterBName} ${pctB}%`}
        >
          <div
            className={cn(
              "flex items-center justify-start px-2 font-mono text-[11px] tabular transition-[width]",
              aFav ? "bg-primary text-background-base" : "bg-foreground/15 text-foreground",
            )}
            style={{ width: `${pctA}%` }}
          >
            {pctA >= 12 ? `${pctA}%` : ""}
          </div>
          <div
            className={cn(
              "flex items-center justify-end px-2 font-mono text-[11px] tabular transition-[width]",
              !aFav ? "bg-primary text-background-base" : "bg-foreground/15 text-foreground",
            )}
            style={{ width: `${pctB}%` }}
          >
            {pctB >= 12 ? `${pctB}%` : ""}
          </div>
        </div>
        <p className="mt-2 text-center font-sans text-[11px] text-foreground-subtle">
          {basis === "all_time"
            ? t("forecastBasisAllTime", { a: displayScoreA, b: displayScoreB })
            : t("forecastBasisCurrent", { a: displayScoreA, b: displayScoreB })}
        </p>
      </div>

      <div className="flex flex-col items-center gap-1.5 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3 text-center">
        <p className="font-sans text-xs text-foreground-muted">
          {t("forecastEstimate")}
        </p>
        <Link
          href="/simulation"
          className="inline-flex items-center gap-1.5 font-sans text-sm font-medium text-primary transition-colors hover:opacity-80"
        >
          {t("forecastSimCta")}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
        <p className="font-sans text-[11px] text-foreground-subtle">
          {t("forecastSimNote")}
        </p>
      </div>
    </div>
  );
}
