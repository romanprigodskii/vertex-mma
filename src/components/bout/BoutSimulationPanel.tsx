import { getTranslations } from "next-intl/server";

import type { BoutDetail } from "@/lib/bout-detail";
import type { BoutSimulationRow } from "@/lib/bout-simulation";
import { cn } from "@/lib/utils";

interface Props {
  bout: BoutDetail;
  sim: BoutSimulationRow;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

const CONFIDENCE_STYLE: Record<
  BoutSimulationRow["confidenceLabel"],
  { dot: string; text: string }
> = {
  low: { dot: "bg-foreground-subtle", text: "text-foreground-muted" },
  medium: { dot: "bg-primary", text: "text-primary" },
  high: { dot: "bg-streak-win", text: "text-streak-win" },
};

export async function BoutSimulationPanel({ bout, sim }: Props) {
  const t = await getTranslations("boutSimulation");
  const winnerIsA = sim.probA >= 0.5;
  const winnerName = winnerIsA ? bout.fighter_a.name_en : bout.fighter_b.name_en;
  const winnerProb = winnerIsA ? sim.probA : sim.probB;
  const loserName = winnerIsA ? bout.fighter_b.name_en : bout.fighter_a.name_en;
  const loserProb = winnerIsA ? sim.probB : sim.probA;
  const cs = CONFIDENCE_STYLE[sim.confidenceLabel] ?? CONFIDENCE_STYLE.low;
  // Edge vs market — Phase 1 just renders the raw delta when both sides
  // are available. Phase 2 turns this into a "value" indicator.
  const edge = sim.edgeA;
  const edgeText = edge == null ? null : edge >= 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;

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
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn("inline-block h-2 w-2 rounded-full", cs.dot)}
            />
            <span className={cn("text-[11px] uppercase tracking-widest", cs.text)}>
              {t(`confidence.${sim.confidenceLabel}`)}
            </span>
          </div>
          {edgeText && sim.marketProbA != null ? (
            <div className="text-[11px] uppercase tracking-widest text-foreground-subtle">
              {t("vsMarket", {
                edge: edgeText,
                market: pct(
                  winnerIsA ? sim.marketProbA : 1 - sim.marketProbA,
                ),
              })}
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-4 font-sans text-[11px] leading-relaxed text-foreground-subtle">
        {t("disclaimer")}
      </p>
    </section>
  );
}
