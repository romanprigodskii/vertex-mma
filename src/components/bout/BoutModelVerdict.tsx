import { useTranslations } from "next-intl";
import { Check, X } from "lucide-react";

import type { BoutDetail } from "@/lib/bout-detail";
import type { BoutSimulationRow } from "@/lib/bout-simulation";

/**
 * Closes the prediction loop on a COMPLETED bout: shows what the model picked
 * pre-fight and whether it was right. Only rendered when the bout has a real
 * winner and the model made a pick — accountability, not second-guessing.
 */
export function BoutModelVerdict({
  bout,
  sim,
}: {
  bout: BoutDetail;
  sim: BoutSimulationRow;
}) {
  const t = useTranslations("boutSimulation");
  const predId = sim.predictedWinnerId;
  // No stored pick (e.g. winner id nulled by a fighter re-import) → nothing to
  // grade honestly, so skip rather than mislabel.
  if (!predId) return null;

  const predictedA = predId === bout.fighter_a.id;
  const predName = predictedA ? bout.fighter_a.name_en : bout.fighter_b.name_en;
  const predPct = Math.round((predictedA ? sim.probA : sim.probB) * 100);
  const hit = predId === bout.winner_id;
  const predictedDate = sim.generatedAt.slice(0, 10);

  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4 sm:p-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
        {t("verdictHeading")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest ${
            hit
              ? "bg-streak-win/15 text-streak-win"
              : "bg-streak-loss/15 text-streak-loss"
          }`}
        >
          {hit ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <X className="h-3.5 w-3.5" aria-hidden />
          )}
          {hit ? t("verdictHit") : t("verdictMiss")}
        </span>
        <p className="font-sans text-sm text-foreground">
          {t("verdictPredicted", { name: predName, pct: predPct })}
        </p>
      </div>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {t("verdictMeta", { version: sim.modelVersion, date: predictedDate })}
      </p>
    </div>
  );
}
