import { getTranslations } from "next-intl/server";
import { ChevronRight } from "lucide-react";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { Link } from "@/i18n/navigation";
import { reconcileMcMethodProbs } from "@/lib/bout-simulation";
import type { SimulationIndexBout } from "@/lib/simulation-index";
import { cn } from "@/lib/utils";

interface Props {
  bout: SimulationIndexBout;
}

const CONFIDENCE_STYLE: Record<
  SimulationIndexBout["confidenceLabel"],
  { dot: string; text: string }
> = {
  low: { dot: "bg-foreground-subtle", text: "text-foreground-muted" },
  medium: { dot: "bg-primary", text: "text-primary" },
  high: { dot: "bg-streak-win", text: "text-streak-win" },
};

function pct(p: number): string {
  return `${(p * 100).toFixed(0)}%`;
}

/**
 * Picks the headline method+side for the bout, AFTER reconciling MC
 * method probabilities with the ensemble's winner_prob. The raw MC
 * sometimes picks an underdog as the most-likely finisher (it only
 * knows historical KO/sub rates, not the ensemble's signal); the
 * reconciliation keeps MC's relative method mix per side but scales
 * absolute totals so each side's six cells sum to the ensemble's
 * winner_prob for that side.
 */
function pickHeadlineMethod(bout: SimulationIndexBout): {
  method: "ko" | "sub" | "dec";
  side: "a" | "b";
  prob: number;
} | null {
  if (bout.mcProbKoA == null) return null;
  const rounds = {
    nSimulations: 0,
    mcWinnerProbA: 0,
    mcWinnerProbB: 0,
    probKoA: bout.mcProbKoA ?? 0,
    probKoB: bout.mcProbKoB ?? 0,
    probSubA: bout.mcProbSubA ?? 0,
    probSubB: bout.mcProbSubB ?? 0,
    probDecisionA: bout.mcProbDecisionA ?? 0,
    probDecisionB: bout.mcProbDecisionB ?? 0,
    avgFinishSeconds: bout.mcAvgFinishSeconds ?? null,
    finishByRound: [],
    // Card carries only aggregate method probs (no per-round split);
    // reconcileMcMethodProbs ignores these two fields anyway.
    finishMethodByRound: [],
  };
  const reconciled = reconcileMcMethodProbs(rounds, bout.probA);
  const candidates: Array<{
    method: "ko" | "sub" | "dec";
    side: "a" | "b";
    prob: number;
  }> = [
    { method: "ko", side: "a", prob: reconciled.probKoA },
    { method: "ko", side: "b", prob: reconciled.probKoB },
    { method: "sub", side: "a", prob: reconciled.probSubA },
    { method: "sub", side: "b", prob: reconciled.probSubB },
    { method: "dec", side: "a", prob: reconciled.probDecisionA },
    { method: "dec", side: "b", prob: reconciled.probDecisionB },
  ];
  candidates.sort((x, y) => y.prob - x.prob);
  return candidates[0];
}

export async function SimulationBoutCard({ bout }: Props) {
  const t = await getTranslations("simulationIndex");
  const tSim = await getTranslations("boutSimulation");
  const tWeight = await getTranslations("weight");

  // Within ±2pp of an even split, crowning one side as "the pick" is
  // misleading — surface a neutral "too close to call" state instead.
  const isPickEm = Math.abs(bout.probA - 0.5) <= 0.02;
  const winnerIsA = bout.probA >= 0.5;
  const winnerName = winnerIsA ? bout.fighterAName : bout.fighterBName;
  const winnerProb = winnerIsA ? bout.probA : bout.probB;
  const loserName = winnerIsA ? bout.fighterBName : bout.fighterAName;
  const cs = CONFIDENCE_STYLE[bout.confidenceLabel] ?? CONFIDENCE_STYLE.low;
  const weightLabel = tWeight.has(bout.weightClass)
    ? tWeight(bout.weightClass as "lightweight")
    : bout.weightClass.replace(/_/g, " ");

  // Edge for predicted winner — flip sign when model picks B.
  const edge = bout.edgeA;
  const edgeForWinner = edge == null ? null : winnerIsA ? edge : -edge;
  // Suppress the value chip on a coin-flip: it's computed from an arbitrary
  // side (probA >= 0.5) and the pick row no longer names a favorite, so the
  // chip would have no fighter to attribute the edge to.
  const showValueChip =
    !isPickEm && edgeForWinner != null && Math.abs(edgeForWinner) >= 0.05;
  const valuePositive = edgeForWinner != null && edgeForWinner >= 0.05;

  // Headline method from MC.
  const headline = pickHeadlineMethod(bout);

  return (
    <Link
      href={`/bouts/${bout.boutId}`}
      prefetch={false}
      aria-label={
        isPickEm
          ? t("cardAriaPickEm", {
              a: bout.fighterAName,
              b: bout.fighterBName,
            })
          : t("cardAria", {
              winner: winnerName,
              loser: loserName,
              pct: pct(winnerProb),
            })
      }
      className={cn(
        "group flex flex-col gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-4",
        "transition-colors hover:border-primary/30 hover:bg-foreground/[0.04]",
      )}
    >
      {/* Top kicker — weight + main/title chips */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        <span>{weightLabel}</span>
        {bout.isMainEvent ? (
          <>
            <span aria-hidden>·</span>
            <span className="text-primary">{t("mainEvent")}</span>
          </>
        ) : null}
        {bout.isTitleFight ? (
          <>
            <span aria-hidden>·</span>
            <span className="rounded-sm border border-primary/40 bg-primary/10 px-1 text-primary">
              {t("titleFight")}
            </span>
          </>
        ) : null}
      </div>

      {/* Fighter A vs B row */}
      <div className="flex items-center gap-3">
        <FighterAvatar
          name={bout.fighterAName}
          photoUrl={bout.fighterAPhotoUrl}
          size="md"
          imageSizes="56px"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "font-display text-base uppercase tracking-tight leading-tight",
              isPickEm || winnerIsA
                ? "text-foreground"
                : "text-foreground-muted",
            )}
          >
            {bout.fighterAName}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
            {pct(bout.probA)}
          </span>
        </div>
        <span className="px-2 font-display text-[11px] uppercase tracking-widest text-foreground-subtle">
          {tSim("vs")}
        </span>
        <div className="flex min-w-0 flex-1 flex-col items-end text-right">
          <span
            className={cn(
              "font-display text-base uppercase tracking-tight leading-tight",
              isPickEm || !winnerIsA
                ? "text-foreground"
                : "text-foreground-muted",
            )}
          >
            {bout.fighterBName}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
            {pct(bout.probB)}
          </span>
        </div>
        <FighterAvatar
          name={bout.fighterBName}
          photoUrl={bout.fighterBPhotoUrl}
          size="md"
          imageSizes="56px"
        />
      </div>

      {/* Pick row — big number + winner + confidence + value chip. A near-even
          split shows a neutral "too close to call" instead of crowning a side. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-foreground/10 pt-3">
        {isPickEm ? (
          <span className="font-display text-base uppercase tracking-tight text-foreground">
            {t("pickEm")}
          </span>
        ) : (
          <>
            <span className="font-display tabular text-3xl leading-none text-foreground">
              {(winnerProb * 100).toFixed(0)}
              <span className="text-lg text-foreground-muted">%</span>
            </span>
            <span className="font-display text-base uppercase tracking-tight text-foreground">
              {winnerName}
            </span>
          </>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[11px] uppercase tracking-widest">
          <span className="flex items-center gap-1">
            <span aria-hidden className={cn("h-2 w-2 rounded-full", cs.dot)} />
            <span className={cs.text}>{tSim(`confidence.${bout.confidenceLabel}`)}</span>
          </span>
          {showValueChip ? (
            <span
              className={cn(
                "rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
                valuePositive
                  ? "border-streak-win/40 bg-streak-win/10 text-streak-win"
                  : "border-streak-loss/40 bg-streak-loss/10 text-streak-loss",
              )}
            >
              {valuePositive ? tSim("valueChipPositive") : tSim("valueChipNegative")}
            </span>
          ) : null}
        </span>
      </div>

      {/* Method headline from MC + open link */}
      <div className="flex items-baseline justify-between gap-3 font-sans text-[11px] text-foreground-subtle">
        {headline ? (
          <span>
            {t("headlineMethod", {
              method:
                headline.method === "ko"
                  ? tSim("mcMethodKo")
                  : headline.method === "sub"
                    ? tSim("mcMethodSub")
                    : tSim("mcMethodDec"),
              name: headline.side === "a" ? bout.fighterAName : bout.fighterBName,
              pct: pct(headline.prob),
            })}
          </span>
        ) : (
          <span className="text-foreground-subtle/60">
            {/* No Monte Carlo data for this bout — state that plainly rather
                than dressing the loser's win chance up as a second pick. */}
            {t("noMcFallback")}
          </span>
        )}
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-primary transition-transform group-hover:translate-x-0.5">
          {t("openBout")}
          <ChevronRight className="h-3 w-3" aria-hidden />
        </span>
      </div>
    </Link>
  );
}
