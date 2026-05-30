import { getTranslations } from "next-intl/server";
import { ChevronRight } from "lucide-react";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { Link } from "@/i18n/navigation";
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
 * Picks the headline method+side for the bout. Returns the (method,
 * favored fighter, probability) triple with the highest joint MC
 * probability — that's what the headline tag should advertise.
 * Falls back to null when no MC row was joined for this bout.
 */
function pickHeadlineMethod(bout: SimulationIndexBout): {
  method: "ko" | "sub" | "dec";
  side: "a" | "b";
  prob: number;
} | null {
  if (bout.mcProbKoA == null) return null;
  const candidates: Array<{ method: "ko" | "sub" | "dec"; side: "a" | "b"; prob: number }> = [
    { method: "ko", side: "a", prob: bout.mcProbKoA ?? 0 },
    { method: "ko", side: "b", prob: bout.mcProbKoB ?? 0 },
    { method: "sub", side: "a", prob: bout.mcProbSubA ?? 0 },
    { method: "sub", side: "b", prob: bout.mcProbSubB ?? 0 },
    { method: "dec", side: "a", prob: bout.mcProbDecisionA ?? 0 },
    { method: "dec", side: "b", prob: bout.mcProbDecisionB ?? 0 },
  ];
  candidates.sort((x, y) => y.prob - x.prob);
  return candidates[0];
}

export async function SimulationBoutCard({ bout }: Props) {
  const t = await getTranslations("simulationIndex");
  const tSim = await getTranslations("boutSimulation");
  const tWeight = await getTranslations("weight");

  const winnerIsA = bout.probA >= 0.5;
  const winnerName = winnerIsA ? bout.fighterAName : bout.fighterBName;
  const winnerProb = winnerIsA ? bout.probA : bout.probB;
  const winnerSlug = winnerIsA ? bout.fighterASlug : bout.fighterBSlug;
  const loserName = winnerIsA ? bout.fighterBName : bout.fighterAName;
  const loserProb = winnerIsA ? bout.probB : bout.probA;
  const cs = CONFIDENCE_STYLE[bout.confidenceLabel] ?? CONFIDENCE_STYLE.low;
  const weightLabel = tWeight.has(bout.weightClass)
    ? tWeight(bout.weightClass as "lightweight")
    : bout.weightClass.replace(/_/g, " ");

  // Edge for predicted winner — flip sign when model picks B.
  const edge = bout.edgeA;
  const edgeForWinner = edge == null ? null : winnerIsA ? edge : -edge;
  const showValueChip = edgeForWinner != null && Math.abs(edgeForWinner) >= 0.05;
  const valuePositive = edgeForWinner != null && edgeForWinner >= 0.05;

  // Headline method from MC.
  const headline = pickHeadlineMethod(bout);

  return (
    <Link
      href={`/bouts/${bout.boutId}`}
      prefetch={false}
      aria-label={t("cardAria", {
        winner: winnerName,
        loser: loserName,
        pct: pct(winnerProb),
      })}
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
              winnerIsA ? "text-foreground" : "text-foreground-muted",
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
              !winnerIsA ? "text-foreground" : "text-foreground-muted",
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

      {/* Pick row — big number + winner + confidence + value chip */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-foreground/10 pt-3">
        <span className="font-display tabular text-3xl leading-none text-foreground">
          {(winnerProb * 100).toFixed(0)}
          <span className="text-lg text-foreground-muted">%</span>
        </span>
        <span className="font-display text-base uppercase tracking-tight text-foreground">
          {winnerName}
        </span>
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
            {/* No MC available — render the score-confidence summary instead. */}
            {t("noMcFallback", { name: loserName, pct: pct(loserProb) })}
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
