"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type {
  ScoreBreakdownData,
  ScoreComponentRow,
} from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

const WEIGHT_DIVISION_LABEL: Record<string, string> = {
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

interface ScoreBreakdownProps {
  data: ScoreBreakdownData;
  divisionalStatus?: "current" | "provisional" | "former" | null;
}

/**
 * Wave 17 — collapsible score-breakdown section. Default closed. Two
 * tabs: Current (follows the hero — divisional row when one drives the
 * hero, otherwise global) and All-Time (always global). Each row shows
 * the raw component value, its weight in the formula, and the
 * contribution (raw × weight). The Current tab also shows the curve
 * multiplier between raw subtotal and final score; the All-Time tab
 * skips it because the all-time formula has no curve.
 */
export function ScoreBreakdown({ data, divisionalStatus }: ScoreBreakdownProps) {
  const [open, setOpen] = React.useState(false);
  // Wave 29: retired fighters have no Current score — default the tab to
  // All-Time so the breakdown lands on a populated view. User can still
  // switch to the (empty) Current tab manually.
  const [tab, setTab] = React.useState<"current" | "all-time">(
    data.current.finalScore == null ? "all-time" : "current",
  );

  const sourceLabel =
    data.source === "divisional" && data.divisionLabel
      ? `Divisional · ${WEIGHT_DIVISION_LABEL[data.divisionLabel] ?? data.divisionLabel}${
          divisionalStatus ? ` (${divisionalStatus})` : ""
        }`
      : "Global";

  return (
    <section aria-label="Score breakdown" className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        Score breakdown
      </button>

      {open ? (
        <div className="mt-4 rounded-md border border-foreground/10 bg-background-elevated/30 p-4">
          <div
            role="tablist"
            aria-label="Score breakdown view"
            className="flex gap-1 border-b border-foreground/10"
          >
            {(["current", "all-time"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-3 py-1.5 font-sans text-[11px] uppercase tracking-widest transition-colors",
                  tab === t
                    ? "border-b-2 border-foreground text-foreground"
                    : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
                )}
              >
                {t === "current" ? "Current" : "All-Time"}
              </button>
            ))}
          </div>

          {tab === "current" ? (
            <BreakdownTable
              rows={data.current.rows}
              rawTotal={data.current.rawTotal}
              curveMultiplier={data.current.curveMultiplier}
              finalScore={data.current.finalScore}
              sourceLabel={sourceLabel}
            />
          ) : (
            <BreakdownTable
              rows={data.allTime.rows}
              rawTotal={null}
              curveMultiplier={null}
              finalScore={data.allTime.finalScore}
              sourceLabel="Global"
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function BreakdownTable({
  rows,
  rawTotal,
  curveMultiplier,
  finalScore,
  sourceLabel,
}: {
  rows: ScoreComponentRow[];
  rawTotal: number | null;
  curveMultiplier: number | null;
  finalScore: number | null;
  sourceLabel: string;
}) {
  return (
    <div className="mt-4">
      <p className="mb-3 font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
        Source <span className="ml-1 text-foreground-muted">{sourceLabel}</span>
      </p>
      <table className="w-full font-mono text-xs tabular">
        <thead>
          <tr className="border-b border-foreground/10 text-foreground-subtle">
            <th className="py-1 text-left font-sans text-[10px] font-medium uppercase tracking-widest">
              Component
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
              Raw
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
              ×Weight
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
              Contribution
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const raw = row.raw ?? 0;
            const contribution = raw * row.weight;
            const negativeWeight = row.weight < 0;
            return (
              <tr key={row.label} className="border-b border-foreground/5">
                <td className="py-1.5 text-foreground">{row.label}</td>
                <td className="py-1.5 text-right text-foreground-muted">
                  {row.raw != null ? row.raw.toFixed(1) : "—"}
                </td>
                <td className="py-1.5 text-right text-foreground-subtle">
                  ×{row.weight.toFixed(2)}
                </td>
                <td
                  className={cn(
                    "py-1.5 text-right",
                    negativeWeight && contribution !== 0
                      ? "text-streak-loss"
                      : "text-foreground",
                  )}
                >
                  {contribution > 0 ? "+" : ""}
                  {contribution.toFixed(1)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          {rawTotal != null ? (
            <tr>
              <td
                colSpan={3}
                className="pt-3 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                Raw subtotal
              </td>
              <td className="pt-3 text-right font-mono text-sm tabular text-foreground">
                {rawTotal.toFixed(1)}
              </td>
            </tr>
          ) : null}
          {curveMultiplier != null ? (
            <tr>
              <td
                colSpan={3}
                className="pt-1 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                Curve multiplier
              </td>
              <td className="pt-1 text-right font-mono text-sm tabular text-foreground">
                ×{curveMultiplier.toFixed(2)}
              </td>
            </tr>
          ) : null}
          <tr>
            <td
              colSpan={3}
              className="pt-3 text-right font-sans text-[10px] font-medium uppercase tracking-widest text-foreground"
            >
              Final {curveMultiplier != null ? "(after curve, clamp 0-100)" : "(clamp 0-100)"}
            </td>
            <td className="pt-3 text-right font-display text-xl tabular text-foreground">
              {finalScore != null ? finalScore : "—"}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
