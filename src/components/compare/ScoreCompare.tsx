import { useTranslations } from "next-intl";

import type { ScoreBreakdownData } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface ScoreCompareProps {
  fighterAName: string;
  fighterBName: string;
  breakdownA: ScoreBreakdownData | null;
  breakdownB: ScoreBreakdownData | null;
  vertexA: number | null;
  vertexB: number | null;
  vertexAllTimeA: number | null;
  vertexAllTimeB: number | null;
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

export function ScoreCompare({
  fighterAName,
  fighterBName,
  breakdownA,
  breakdownB,
  vertexA,
  vertexB,
  vertexAllTimeA,
  vertexAllTimeB,
}: ScoreCompareProps) {
  const t = useTranslations("compare");
  if (!breakdownA && !breakdownB) {
    return (
      <p className="py-6 text-center font-sans text-sm text-foreground-muted">
        {t("noBreakdown")}
      </p>
    );
  }

  const rowsA = breakdownA?.current.rows ?? [];
  const rowsB = breakdownB?.current.rows ?? [];
  const rowCount = Math.max(rowsA.length, rowsB.length);
  const labelA = lastName(fighterAName);
  const labelB = lastName(fighterBName);

  return (
    <div className="mt-4 space-y-6">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
        <div>
          <p className="font-display text-3xl tabular text-foreground sm:text-4xl">
            {vertexA != null ? vertexA : vertexAllTimeA ?? "—"}
          </p>
          <p className="mt-0.5 font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
            {vertexA != null ? t("scoreModeCurrent") : t("scoreModeAllTime")}
          </p>
        </div>
        <p className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
          {t("vertexLabel")}
        </p>
        <div>
          <p className="font-display text-3xl tabular text-foreground sm:text-4xl">
            {vertexB != null ? vertexB : vertexAllTimeB ?? "—"}
          </p>
          <p className="mt-0.5 font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
            {vertexB != null ? t("scoreModeCurrent") : t("scoreModeAllTime")}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/30">
        <table className="w-full font-mono text-xs tabular">
          <thead>
            <tr className="border-b border-foreground/10 text-foreground-subtle">
              <th className="w-[30%] px-2 py-1.5 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
                {labelA}
              </th>
              <th className="px-2 py-1.5 text-center font-sans text-[10px] font-medium uppercase tracking-widest">
                {t("componentLabel")}
              </th>
              <th className="w-[30%] px-2 py-1.5 text-left font-sans text-[10px] font-medium uppercase tracking-widest">
                {labelB}
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }).map((_, i) => {
              const a = rowsA[i];
              const b = rowsB[i];
              const label = a?.label ?? b?.label ?? "";
              const weight = a?.weight ?? b?.weight ?? 0;
              const rawA = a?.raw ?? null;
              const rawB = b?.raw ?? null;
              const contribA = rawA != null ? rawA * weight : null;
              const contribB = rawB != null ? rawB * weight : null;
              const isNegativeWeight = weight < 0;
              const aLeads =
                rawA != null &&
                rawB != null &&
                (isNegativeWeight ? rawA < rawB : rawA > rawB);
              const bLeads =
                rawA != null &&
                rawB != null &&
                (isNegativeWeight ? rawB < rawA : rawB > rawA);
              return (
                <tr key={label} className="border-b border-foreground/5 last:border-b-0">
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right",
                      aLeads
                        ? "font-medium text-foreground"
                        : "text-foreground-muted",
                    )}
                  >
                    {rawA != null ? (
                      <span>
                        {rawA.toFixed(1)}
                        <span
                          className={cn(
                            "ml-1.5 text-[10px]",
                            isNegativeWeight && contribA != null && contribA !== 0
                              ? "text-streak-loss"
                              : "text-foreground-subtle",
                          )}
                        >
                          (
                          {contribA != null
                            ? `${contribA > 0 ? "+" : ""}${contribA.toFixed(1)}`
                            : "—"}
                          )
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center text-foreground-subtle">
                    {label}
                    <span className="ml-1.5 text-[9px]">
                      ×{weight.toFixed(2)}
                    </span>
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-left",
                      bLeads
                        ? "font-medium text-foreground"
                        : "text-foreground-muted",
                    )}
                  >
                    {rawB != null ? (
                      <span>
                        {rawB.toFixed(1)}
                        <span
                          className={cn(
                            "ml-1.5 text-[10px]",
                            isNegativeWeight && contribB != null && contribB !== 0
                              ? "text-streak-loss"
                              : "text-foreground-subtle",
                          )}
                        >
                          (
                          {contribB != null
                            ? `${contribB > 0 ? "+" : ""}${contribB.toFixed(1)}`
                            : "—"}
                          )
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
