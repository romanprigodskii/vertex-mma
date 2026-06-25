import { getTranslations } from "next-intl/server";
import { ArrowLeft, ArrowRight } from "lucide-react";

import type { BoutDetail } from "@/lib/bout-detail";
import {
  reconcileMcMethodProbs,
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

      {sim.rounds ? (
        <MonteCarloBlock bout={bout} rounds={sim.rounds} ensembleProbA={sim.probA} />
      ) : null}

      <p className="mt-4 font-sans text-[11px] leading-relaxed text-foreground-subtle">
        {t("disclaimer")}
      </p>
    </section>
  );
}

function formatFinishTime(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function MonteCarloBlock({
  bout,
  rounds,
  ensembleProbA,
}: {
  bout: BoutDetail;
  rounds: NonNullable<BoutSimulationRow["rounds"]>;
  ensembleProbA: number;
}) {
  const t = await getTranslations("boutSimulation");
  // Method totals + headline cell come from the RECONCILED MC numbers
  // (raw MC sometimes picks an underdog as the most-likely finisher,
  // which contradicts the ensemble's winner pick at the top of the
  // panel — see reconcileMcMethodProbs).
  const m = reconcileMcMethodProbs(rounds, ensembleProbA);

  // Find the most likely (method, round) cell — used for the headline
  // sentence. Decision sits at "round = scheduled_rounds + 1" so it
  // sorts after all round-finish cells.
  const finishByRound = rounds.finishByRound.filter(
    (v): v is number => v != null,
  );
  const scheduledRounds = finishByRound.length;
  // Per-round finish cells, each labelled with the round's DOMINANT method
  // (KO vs Sub) from the MC distribution — not a hardcoded "KO". Falls back to
  // the overall dominant finish method for rounds without a per-method split
  // (predictions made before the distribution payload existed).
  const overallFinishKind: "ko" | "sub" =
    m.probKoA + m.probKoB >= m.probSubA + m.probSubB ? "ko" : "sub";
  type Cell = { kind: "ko" | "sub" | "dec"; round: number; prob: number };
  const cells: Cell[] = [];
  for (let i = 0; i < scheduledRounds; i += 1) {
    cells.push({
      kind: rounds.finishMethodByRound[i] ?? overallFinishKind,
      round: i + 1,
      prob: finishByRound[i],
    });
  }
  const decisionProb = m.probDecisionA + m.probDecisionB;
  cells.push({ kind: "dec", round: scheduledRounds + 1, prob: decisionProb });
  cells.sort((x, y) => y.prob - x.prob);
  const top = cells[0];

  // Method totals strip — reconciled, so the KO/Sub/Dec totals
  // numerically sum to the same 100% the headline winner prob is
  // drawn from.
  const totalKo = m.probKoA + m.probKoB;
  const totalSub = m.probSubA + m.probSubB;
  const totalDec = decisionProb;
  const reconciledRounds = { ...rounds, ...m };

  // Per-round bars + decision bar.
  const maxRoundProb = Math.max(
    decisionProb,
    ...finishByRound,
    0.05,
  );

  const fighterAName = bout.fighter_a.name_en;
  const fighterBName = bout.fighter_b.name_en;
  const topMethodLabel =
    top.kind === "ko"
      ? t("mcMethodKo")
      : top.kind === "sub"
        ? t("mcMethodSub")
        : t("mcMethodDec");

  return (
    <div className="mt-5 border-t border-foreground/10 pt-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("mcHeading", { n: rounds.nSimulations.toLocaleString() })}
        </h4>
        {rounds.avgFinishSeconds != null ? (
          <span className="font-mono text-[10px] tabular text-foreground-subtle">
            {t("mcAvgFinish", {
              time: formatFinishTime(rounds.avgFinishSeconds),
            })}
          </span>
        ) : null}
      </div>

      {/* Headline sentence */}
      <p className="mb-3 font-sans text-sm text-foreground">
        {top.kind === "dec"
          ? t("mcMostLikely", {
              method: topMethodLabel,
              round: "—",
              pct: `${(top.prob * 100).toFixed(0)}%`,
            })
          : t("mcMostLikely", {
              method: topMethodLabel,
              round: top.round,
              pct: `${(top.prob * 100).toFixed(0)}%`,
            })}
      </p>

      {/* Method totals — stacked bar */}
      <div className="mb-3 space-y-1.5">
        <div className="flex h-2 w-full overflow-hidden rounded-sm bg-foreground/[0.05]">
          <div
            aria-hidden
            className="h-full bg-streak-loss/70"
            style={{ width: `${totalKo * 100}%` }}
            title={`${t("mcMethodKo")} ${(totalKo * 100).toFixed(0)}%`}
          />
          <div
            aria-hidden
            className="h-full bg-primary/70"
            style={{ width: `${totalSub * 100}%` }}
            title={`${t("mcMethodSub")} ${(totalSub * 100).toFixed(0)}%`}
          />
          <div
            aria-hidden
            className="h-full bg-foreground-muted/60"
            style={{ width: `${totalDec * 100}%` }}
            title={`${t("mcMethodDec")} ${(totalDec * 100).toFixed(0)}%`}
          />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          <span className="flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-streak-loss/70" />
            <span>
              {t("mcMethodKo")} · {(totalKo * 100).toFixed(0)}% ·{" "}
              <span className="text-foreground-muted">
                {(reconciledRounds.probKoA * 100).toFixed(0)}/
                {(reconciledRounds.probKoB * 100).toFixed(0)}
              </span>
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-primary/70" />
            <span>
              {t("mcMethodSub")} · {(totalSub * 100).toFixed(0)}% ·{" "}
              <span className="text-foreground-muted">
                {(reconciledRounds.probSubA * 100).toFixed(0)}/
                {(reconciledRounds.probSubB * 100).toFixed(0)}
              </span>
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-foreground-muted/60" />
            <span>
              {t("mcMethodDec")} · {(totalDec * 100).toFixed(0)}% ·{" "}
              <span className="text-foreground-muted">
                {(reconciledRounds.probDecisionA * 100).toFixed(0)}/
                {(reconciledRounds.probDecisionB * 100).toFixed(0)}
              </span>
            </span>
          </span>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle/70">
          {fighterAName} / {fighterBName}
        </p>
      </div>

      {/* Per-round finish probability strip */}
      <ul className="grid grid-cols-1 gap-1.5">
        {finishByRound.map((prob, idx) => {
          const widthPct = Math.max(4, Math.round((prob / maxRoundProb) * 100));
          return (
            <li
              key={`r${idx + 1}`}
              className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle"
            >
              <span className="w-6 shrink-0 text-foreground-muted">
                {t("mcRoundLabel", { n: idx + 1 })}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-sm bg-foreground/[0.05]">
                <div
                  aria-hidden
                  className="h-full bg-streak-loss/55"
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-foreground-muted">
                {(prob * 100).toFixed(0)}%
              </span>
            </li>
          );
        })}
        <li className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          <span className="w-6 shrink-0 text-foreground-muted">
            {t("mcDecisionLabel")}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-sm bg-foreground/[0.05]">
            <div
              aria-hidden
              className="h-full bg-foreground-muted/50"
              style={{ width: `${Math.max(4, Math.round((decisionProb / maxRoundProb) * 100))}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-foreground-muted">
            {(decisionProb * 100).toFixed(0)}%
          </span>
        </li>
      </ul>
    </div>
  );
}
