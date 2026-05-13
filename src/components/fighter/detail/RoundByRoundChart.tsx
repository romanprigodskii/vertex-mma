"use client";

import * as React from "react";

import type { RoundAverage } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface RoundByRoundChartProps {
  rounds: RoundAverage[];
}

type MetricKey =
  | "sig_str_landed"
  | "sig_str_absorbed"
  | "td_landed"
  | "td_absorbed"
  | "total_str_landed"
  | "total_str_absorbed"
  | "sub_attempts"
  | "kd_landed"
  | "kd_absorbed"
  | "control";

interface MetricDef {
  key: MetricKey;
  label: string;
  bar: string;
  column: keyof RoundAverage;
  formatter: (n: number) => string;
}

const formatDecimal = (n: number) => n.toFixed(1);
const formatCount = (n: number) => n.toFixed(2);
const formatTime = (n: number) => {
  const total = Math.round(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const METRICS: readonly MetricDef[] = [
  // Defaults shown on first paint
  {
    key: "sig_str_landed",
    label: "Sig Str landed",
    bar: "bg-primary/65",
    column: "avg_sig_str_landed",
    formatter: formatDecimal,
  },
  {
    key: "sig_str_absorbed",
    label: "Sig Str absorbed",
    bar: "bg-streak-loss/65",
    column: "avg_sig_str_absorbed",
    formatter: formatDecimal,
  },
  {
    key: "td_landed",
    label: "Takedowns landed",
    bar: "bg-streak-win/65",
    column: "avg_td_landed",
    formatter: formatCount,
  },
  {
    key: "td_absorbed",
    label: "Takedowns absorbed",
    bar: "bg-streak-loss/55",
    column: "avg_td_absorbed",
    formatter: formatCount,
  },
  // Off by default — toggle to show
  {
    key: "total_str_landed",
    label: "Total str landed",
    bar: "bg-primary/40",
    column: "avg_total_str_landed",
    formatter: formatDecimal,
  },
  {
    key: "total_str_absorbed",
    label: "Total str absorbed",
    bar: "bg-streak-loss/40",
    column: "avg_total_str_absorbed",
    formatter: formatDecimal,
  },
  {
    key: "sub_attempts",
    label: "Sub attempts",
    bar: "bg-submission/65",
    column: "avg_sub_attempts",
    formatter: formatCount,
  },
  {
    key: "kd_landed",
    label: "Knockdowns landed",
    bar: "bg-knockdown/70",
    column: "avg_kd_landed",
    formatter: formatCount,
  },
  {
    key: "kd_absorbed",
    label: "Knockdowns absorbed",
    bar: "bg-knockdown/35",
    column: "avg_kd_absorbed",
    formatter: formatCount,
  },
  {
    key: "control",
    label: "Control time",
    bar: "bg-foreground-muted/35",
    column: "avg_control_seconds",
    formatter: formatTime,
  },
];

const DEFAULT_VISIBLE: ReadonlyArray<MetricKey> = [
  "sig_str_landed",
  "sig_str_absorbed",
  "td_landed",
  "td_absorbed",
  "control",
];

function indexByRound(rounds: RoundAverage[]): Map<number, RoundAverage> {
  return new Map(rounds.map((r) => [r.round, r]));
}

const ROUND_NUMBERS = [1, 2, 3, 4, 5] as const;

export function RoundByRoundChart({ rounds }: RoundByRoundChartProps) {
  const [visible, setVisible] = React.useState<Set<MetricKey>>(
    () => new Set(DEFAULT_VISIBLE),
  );

  const toggle = (key: MetricKey) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (rounds.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          No round-by-round data available for this fighter.
        </p>
        <p className="mt-1 font-sans text-xs text-foreground-subtle">
          UFCStats only publishes per-round numbers for newer bouts, so older
          careers can be partially or fully missing.
        </p>
      </div>
    );
  }

  const byRound = indexByRound(rounds);

  // Per-metric max across the rounds we actually have data for.
  const maxFor = (col: keyof RoundAverage): number => {
    const vals = rounds
      .map((r) => Number(r[col] ?? 0))
      .filter((v) => Number.isFinite(v));
    const m = vals.length > 0 ? Math.max(...vals) : 0;
    return m > 0 ? m : 1;
  };

  const visibleMetrics = METRICS.filter((m) => visible.has(m.key));

  return (
    <div className="flex flex-col gap-4">
      {/* Toggle row */}
      <div className="flex flex-wrap gap-1.5">
        {METRICS.map((m) => {
          const isOn = visible.has(m.key);
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => toggle(m.key)}
              aria-pressed={isOn}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 transition-colors",
                "font-sans text-[11px] font-medium uppercase tracking-widest",
                isOn
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-foreground/15 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn("h-2 w-2 rounded-sm", isOn ? m.bar : "bg-foreground/15")}
              />
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr>
              <th className="w-[180px] py-2 text-left font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                Metric
              </th>
              {ROUND_NUMBERS.map((r) => {
                const data = byRound.get(r);
                return (
                  <th
                    key={r}
                    className="py-2 pl-3 text-left font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle"
                  >
                    R{r}
                    {data ? (
                      <span className="ml-1.5 font-mono tabular text-foreground-subtle/70">
                        ({data.sample_size})
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleMetrics.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="py-8 text-center font-sans text-xs text-foreground-subtle"
                >
                  Toggle at least one metric above to view round breakdowns.
                </td>
              </tr>
            ) : null}
            {visibleMetrics.map((metric) => {
              const max = maxFor(metric.column);
              return (
                <tr
                  key={metric.key}
                  className="border-t border-foreground/[0.06]"
                >
                  <td className="py-3 font-sans text-xs text-foreground-muted">
                    {metric.label}
                  </td>
                  {ROUND_NUMBERS.map((r) => {
                    const row = byRound.get(r);
                    if (!row) {
                      return (
                        <td
                          key={r}
                          className="py-3 pl-3 font-mono text-xs text-foreground-subtle/50"
                        >
                          —
                        </td>
                      );
                    }
                    const raw = Number(row[metric.column] ?? 0);
                    const pct =
                      raw > 0 ? Math.max(4, Math.round((raw / max) * 100)) : 0;
                    return (
                      <td key={r} className="py-3 pl-3 align-middle">
                        <div className="flex flex-col gap-1">
                          <div
                            className="h-1.5 rounded-sm"
                            aria-hidden
                            style={{ width: `${pct}%` }}
                          >
                            <div
                              className={cn(
                                "h-full w-full rounded-sm",
                                metric.bar,
                              )}
                            />
                          </div>
                          <span className="font-mono tabular text-[11px] text-foreground">
                            {metric.formatter(raw)}
                          </span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
