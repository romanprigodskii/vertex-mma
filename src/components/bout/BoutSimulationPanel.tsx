import { getTranslations } from "next-intl/server";
import { ArrowLeft, ArrowRight } from "lucide-react";

import type { BoutDetail } from "@/lib/bout-detail";
import {
  selectDisplayFeatures,
  type BoutSimulationRow,
  type FeatureMeta,
} from "@/lib/bout-simulation";
import { cn } from "@/lib/utils";

interface Props {
  bout: BoutDetail;
  sim: BoutSimulationRow;
}

function pct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

const CONFIDENCE_STYLE: Record<
  BoutSimulationRow["confidenceLabel"],
  { dot: string; text: string }
> = {
  low: { dot: "bg-foreground-subtle", text: "text-foreground-muted" },
  medium: { dot: "bg-primary", text: "text-primary" },
  high: { dot: "bg-streak-win", text: "text-streak-win" },
};

/** Format the raw feature value for the breakdown chip. Returns null when
 *  the value is unknown or the unit doesn't make sense to render
 *  (boolean flags, log-odds). */
function formatFeatureValue(
  meta: FeatureMeta,
  value: number | null,
): string | null {
  if (value == null) return null;
  switch (meta.unit) {
    case "cm":
      return meta.side ? `${value.toFixed(0)} cm` : `${value >= 0 ? "+" : ""}${value.toFixed(0)} cm`;
    case "years":
      return meta.side ? `${value.toFixed(0)} yr` : `${value >= 0 ? "+" : ""}${value.toFixed(0)} yr`;
    case "days":
      return meta.side ? `${value.toFixed(0)} d` : `${value >= 0 ? "+" : ""}${value.toFixed(0)} d`;
    case "perMin":
      return `${value >= 0 ? "+" : ""}${value.toFixed(2)}/min`;
    case "per15":
      return `${value >= 0 ? "+" : ""}${value.toFixed(2)}/15`;
    case "ratio":
      return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}%`;
    case "score":
      return meta.side ? `${value.toFixed(0)}` : `${value >= 0 ? "+" : ""}${value.toFixed(0)}`;
    case "count":
      return meta.side ? `${value.toFixed(0)}` : `${value >= 0 ? "+" : ""}${value.toFixed(0)}`;
    default:
      return null;
  }
}

export async function BoutSimulationPanel({ bout, sim }: Props) {
  const t = await getTranslations("boutSimulation");
  const tF = await getTranslations("boutSimulation.features");
  const winnerIsA = sim.probA >= 0.5;
  const winnerName = winnerIsA ? bout.fighter_a.name_en : bout.fighter_b.name_en;
  const winnerProb = winnerIsA ? sim.probA : sim.probB;
  const loserName = winnerIsA ? bout.fighter_b.name_en : bout.fighter_a.name_en;
  const loserProb = winnerIsA ? sim.probB : sim.probA;
  const cs = CONFIDENCE_STYLE[sim.confidenceLabel] ?? CONFIDENCE_STYLE.low;

  // Edge interpretation: edgeA = model_prob_a - market_prob_a. We want a
  // "model agrees / disagrees" signal for the PREDICTED winner — so flip
  // sign when the model picks fighter B. Threshold 5pp to keep noise out.
  const edge = sim.edgeA;
  const edgeForWinner = edge == null ? null : winnerIsA ? edge : -edge;
  const showValueChip = edgeForWinner != null && Math.abs(edgeForWinner) >= 0.05;
  const valueChipPositive = edgeForWinner != null && edgeForWinner >= 0.05;

  // Top 5 features by |SHAP|. Normalize bar widths so the biggest is 100%.
  const features = selectDisplayFeatures(sim.features, 5);
  const maxAbsShap =
    features.reduce((acc, f) => Math.max(acc, Math.abs(f.shapValue)), 0) || 1;

  return (
    <section
      aria-label={t("aria")}
      className="rounded-md border border-primary/25 bg-primary/[0.04] p-4 sm:p-5"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-sans text-[11px] font-medium uppercase tracking-widest text-primary">
          {t("heading")}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {sim.modelVersion}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-3">
          <span className="font-display tabular text-5xl leading-none text-foreground">
            {(winnerProb * 100).toFixed(0)}
            <span className="text-2xl text-foreground-muted">%</span>
          </span>
          <div className="flex flex-col">
            <span className="font-display text-lg uppercase tracking-tight text-foreground">
              {winnerName}
            </span>
            <span className="font-sans text-xs text-foreground-muted">
              {t("vs")}{" "}
              <span className="text-foreground-subtle">
                {loserName} · {pct(loserProb)}
              </span>
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2 font-sans text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden
              className={cn("inline-block h-2 w-2 rounded-full", cs.dot)}
            />
            <span className={cn("text-[11px] uppercase tracking-widest", cs.text)}>
              {t(`confidence.${sim.confidenceLabel}`)}
            </span>
            {showValueChip ? (
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest",
                  valueChipPositive
                    ? "border-streak-win/40 bg-streak-win/10 text-streak-win"
                    : "border-streak-loss/40 bg-streak-loss/10 text-streak-loss",
                )}
              >
                {valueChipPositive
                  ? t("valueChipPositive")
                  : t("valueChipNegative")}
              </span>
            ) : null}
          </div>
          {edgeForWinner != null && sim.marketProbA != null ? (
            <div className="text-[11px] uppercase tracking-widest text-foreground-subtle">
              {t("vsMarket", {
                edge: `${edgeForWinner >= 0 ? "+" : ""}${(edgeForWinner * 100).toFixed(1)}%`,
                market: pct(
                  winnerIsA ? sim.marketProbA : 1 - sim.marketProbA,
                ),
              })}
            </div>
          ) : null}
        </div>
      </div>

      {features.length > 0 ? (
        <div className="mt-5 border-t border-foreground/10 pt-4">
          <h4 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("whyHeading")}
          </h4>
          <ul className="flex flex-col gap-2.5">
            {features.map((f) => {
              const favorsA = f.shapValue > 0;
              const favorName = favorsA ? bout.fighter_a.name_en : bout.fighter_b.name_en;
              const sideName = f.meta.side
                ? f.meta.side === "a"
                  ? bout.fighter_a.name_en
                  : bout.fighter_b.name_en
                : null;
              const label = sideName
                ? tF(f.meta.labelKey as "abs_age", { name: sideName })
                : tF(f.meta.labelKey as "diff_age");
              const widthPct =
                Math.max(8, Math.round((Math.abs(f.shapValue) / maxAbsShap) * 100));
              const formattedValue = formatFeatureValue(f.meta, f.featureValue);
              return (
                <li key={f.featureName} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 font-sans text-xs">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="text-foreground">{label}</span>
                      {formattedValue ? (
                        <span className="font-mono text-[10px] tabular text-foreground-subtle">
                          {formattedValue}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-widest",
                        favorsA ? "text-streak-win" : "text-streak-loss",
                      )}
                    >
                      {favorsA ? (
                        <ArrowLeft className="h-3 w-3" aria-hidden />
                      ) : (
                        <ArrowRight className="h-3 w-3" aria-hidden />
                      )}
                      <span>
                        {t(favorsA ? "favorsA" : "favorsB", { name: favorName })}
                      </span>
                    </span>
                  </div>
                  <div className="h-1 w-full rounded-sm bg-foreground/[0.05]">
                    <div
                      aria-hidden
                      className={cn(
                        "h-full rounded-sm",
                        favorsA ? "bg-streak-win/70" : "bg-streak-loss/70",
                      )}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 font-sans text-[11px] leading-relaxed text-foreground-subtle">
        {t("disclaimer")}
      </p>
    </section>
  );
}
