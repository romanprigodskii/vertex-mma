"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";

import type {
  ScoreAdjustmentRow,
  ScoreBreakdownData,
  ScoreComponentRow,
} from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

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
  const t = useTranslations("fighter");
  const tWeight = useTranslations("weight");
  const [open, setOpen] = React.useState(false);
  // Wave 29: retired fighters have no Current score — default the tab to
  // All-Time so the breakdown lands on a populated view. User can still
  // switch to the (empty) Current tab manually.
  // Retired/inactive fighters have no current score; the Current tab would
  // render an all-dashes table that reads as broken data. Default to All-Time
  // and disable Current entirely (with an explanatory tooltip).
  const currentEmpty = data.current.finalScore == null;
  const [tab, setTab] = React.useState<"current" | "all-time">(
    currentEmpty ? "all-time" : "current",
  );

  const sourceLabel = (() => {
    if (data.source !== "divisional" || !data.divisionLabel) {
      return t("sourceGlobal");
    }
    const divisionTranslated = tWeight.has(data.divisionLabel)
      ? tWeight(data.divisionLabel)
      : data.divisionLabel;
    const statusKey = divisionalStatus
      ? `divisionalStatus_${divisionalStatus}`
      : null;
    const statusSuffix =
      statusKey && t.has(statusKey) ? t(statusKey) : "";
    return t("sourceDivisional", {
      division: divisionTranslated,
      statusSuffix,
    });
  })();

  return (
    <section aria-label={t("scoreBreakdown")} className="mt-6">
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
        {t("scoreBreakdown")}
      </button>

      {open ? (
        <div className="mt-4 rounded-md border border-foreground/10 bg-background-elevated/30 p-4">
          <div
            role="tablist"
            aria-label={t("scoreBreakdownView")}
            className="flex gap-1 border-b border-foreground/10"
          >
            {(["current", "all-time"] as const).map((tabKey) => {
              const disabled = tabKey === "current" && currentEmpty;
              return (
                <button
                  key={tabKey}
                  type="button"
                  role="tab"
                  aria-selected={tab === tabKey}
                  aria-disabled={disabled || undefined}
                  title={disabled ? t("noCurrentScoreNote") : undefined}
                  onClick={() => {
                    if (!disabled) setTab(tabKey);
                  }}
                  className={cn(
                    "px-3 py-1.5 font-sans text-[11px] uppercase tracking-widest transition-colors",
                    disabled
                      ? "border-b-2 border-transparent cursor-not-allowed text-foreground-subtle/50"
                      : tab === tabKey
                        ? "border-b-2 border-foreground text-foreground"
                        : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
                  )}
                >
                  {tabKey === "current" ? t("tabCurrent") : t("tabAllTime")}
                </button>
              );
            })}
          </div>

          {currentEmpty ? (
            <p className="mt-2 font-sans text-[11px] text-foreground-subtle">
              {t("noCurrentScoreNote")}
            </p>
          ) : null}

          {tab === "current" ? (
            <BreakdownTable
              rows={data.current.rows}
              adjustments={data.current.adjustments}
              ageMultiplier={data.current.ageMultiplier}
              credibility={data.current.credibility}
              rawTotal={data.current.rawTotal}
              curveMultiplier={data.current.curveMultiplier}
              skidPenalty={data.current.skidPenalty}
              finalScore={data.current.finalScore}
              sourceLabel={sourceLabel}
            />
          ) : (
            <BreakdownTable
              rows={data.allTime.rows}
              adjustments={[]}
              ageMultiplier={null}
              credibility={data.allTime.credibility}
              rawTotal={null}
              curveMultiplier={null}
              skidPenalty={null}
              finalScore={data.allTime.finalScore}
              sourceLabel={t("sourceGlobal")}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function BreakdownTable({
  rows,
  adjustments,
  ageMultiplier,
  credibility,
  rawTotal,
  curveMultiplier,
  skidPenalty,
  finalScore,
  sourceLabel,
}: {
  rows: ScoreComponentRow[];
  adjustments: ScoreAdjustmentRow[];
  ageMultiplier: number | null;
  credibility: number | null;
  rawTotal: number | null;
  curveMultiplier: number | null;
  skidPenalty: number | null;
  finalScore: number | null;
  sourceLabel: string;
}) {
  const t = useTranslations("fighter");
  // Wave 61: the visible pre-multiplier sum — component contributions
  // plus the flat streak/layoff adjustments. raw_current = this
  // × age × credibility (modulo the view's ≥0 clamps), so the chain in
  // the footer reconciles the table with the stored raw subtotal.
  const componentsSubtotal =
    rows.reduce((s, r) => s + (r.raw ?? 0) * r.weight, 0) +
    adjustments.reduce((s, a) => s + a.points, 0);
  const showAge = ageMultiplier != null && Math.abs(ageMultiplier - 1) > 5e-4;
  const showCred = credibility != null && credibility < 1 - 5e-4;
  // Only worth a separate line when a multiplier sits between the
  // components sum and the raw subtotal (or, on the all-time tab, when
  // credibility damps the sum into the final score).
  const showComponentsSubtotal = showAge || showCred;
  return (
    <div className="mt-4">
      <p className="mb-3 font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
        {t("sourceLabel")}{" "}
        <span className="ml-1 text-foreground-muted">{sourceLabel}</span>
      </p>
      <div className="overflow-x-auto -mx-2 sm:mx-0">
      <table className="w-full min-w-[320px] font-mono text-xs tabular">
        <thead>
          <tr className="border-b border-foreground/10 text-foreground-subtle">
            <th className="py-1 text-left font-sans text-[10px] font-medium uppercase tracking-widest">
              {t("colComponent")}
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
              {t("colRaw")}
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
              {t("colWeight")}
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest">
              {t("colContribution")}
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
          {/* Wave 61: flat raw-point adjustments (no weight column) —
              the streak bonus and the layoff penalty that were always
              inside raw_current but invisible here. */}
          {adjustments.map((adj) => (
            <tr key={adj.label} className="border-b border-foreground/5">
              <td className="py-1.5 text-foreground">{adj.label}</td>
              <td className="py-1.5 text-right text-foreground-muted">
                {adj.raw != null ? adj.raw.toFixed(1) : "—"}
              </td>
              <td className="py-1.5 text-right text-foreground-subtle">—</td>
              <td
                className={cn(
                  "py-1.5 text-right",
                  adj.points < 0 ? "text-streak-loss" : "text-foreground",
                )}
              >
                {adj.points > 0 ? "+" : ""}
                {adj.points.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {/* Wave 61: full reconciliation chain — components subtotal,
              the age/credibility multipliers (shown only when ≠1), the
              stored raw subtotal, the curve, the post-curve skid
              deduction (only when it fired), then the final score. */}
          {showComponentsSubtotal ? (
            <tr>
              <td
                colSpan={3}
                className="pt-3 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                {t("componentsSubtotal")}
              </td>
              <td className="pt-3 text-right font-mono text-sm tabular text-foreground">
                {componentsSubtotal.toFixed(1)}
              </td>
            </tr>
          ) : null}
          {showAge ? (
            <tr>
              <td
                colSpan={3}
                className="pt-1 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                {t("ageFactorLine")}
              </td>
              <td
                className={cn(
                  "pt-1 text-right font-mono text-sm tabular",
                  ageMultiplier < 1 ? "text-streak-loss" : "text-foreground",
                )}
              >
                ×{ageMultiplier.toFixed(2)}
              </td>
            </tr>
          ) : null}
          {showCred ? (
            <tr>
              <td
                colSpan={3}
                className="pt-1 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                {t("credibilityLine")}
              </td>
              <td className="pt-1 text-right font-mono text-sm tabular text-streak-loss">
                ×{credibility.toFixed(2)}
              </td>
            </tr>
          ) : null}
          {rawTotal != null ? (
            <tr>
              <td
                colSpan={3}
                className="pt-3 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                {t("rawSubtotal")}
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
                {t("curveMultiplier")}
              </td>
              <td className="pt-1 text-right font-mono text-sm tabular text-foreground">
                ×{curveMultiplier.toFixed(2)}
              </td>
            </tr>
          ) : null}
          {skidPenalty != null && skidPenalty > 0 ? (
            <tr>
              <td
                colSpan={3}
                className="pt-1 text-right font-sans text-[10px] uppercase tracking-widest text-foreground-muted"
              >
                {t("skidPenaltyLine")}
              </td>
              <td className="pt-1 text-right font-mono text-sm tabular text-streak-loss">
                −{skidPenalty.toFixed(0)}
              </td>
            </tr>
          ) : null}
          <tr>
            <td
              colSpan={3}
              className="pt-3 text-right font-sans text-[10px] font-medium uppercase tracking-widest text-foreground"
            >
              {curveMultiplier != null ? t("finalAfterCurve") : t("finalClamp")}
            </td>
            <td className="pt-3 text-right font-display text-xl tabular text-foreground">
              {finalScore != null ? finalScore : "—"}
            </td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  );
}
