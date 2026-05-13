"use client";

import * as React from "react";

import type { FighterBoutRound } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface RoundByRoundChartProps {
  boutRounds: FighterBoutRound[];
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

type GroupKey = "strikes" | "takedowns" | "knockdowns" | "subs" | "control";

interface MetricDef {
  key: MetricKey;
  label: string;
  bar: string;
  column: keyof FighterBoutRound;
  group: GroupKey;
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
  {
    key: "sig_str_landed",
    label: "Sig Str landed",
    bar: "bg-primary/65",
    column: "sig_str_landed",
    group: "strikes",
    formatter: formatDecimal,
  },
  {
    key: "sig_str_absorbed",
    label: "Sig Str absorbed",
    bar: "bg-streak-loss/65",
    column: "sig_str_absorbed",
    group: "strikes",
    formatter: formatDecimal,
  },
  {
    key: "td_landed",
    label: "Takedowns landed",
    bar: "bg-streak-win/65",
    column: "td_landed",
    group: "takedowns",
    formatter: formatCount,
  },
  {
    key: "td_absorbed",
    label: "Takedowns absorbed",
    bar: "bg-streak-loss/55",
    column: "td_absorbed",
    group: "takedowns",
    formatter: formatCount,
  },
  {
    key: "total_str_landed",
    label: "Total str landed",
    bar: "bg-primary/40",
    column: "total_str_landed",
    group: "strikes",
    formatter: formatDecimal,
  },
  {
    key: "total_str_absorbed",
    label: "Total str absorbed",
    bar: "bg-streak-loss/40",
    column: "total_str_absorbed",
    group: "strikes",
    formatter: formatDecimal,
  },
  {
    key: "sub_attempts",
    label: "Sub attempts",
    bar: "bg-submission/65",
    column: "sub_attempts",
    group: "subs",
    formatter: formatCount,
  },
  {
    key: "kd_landed",
    label: "Knockdowns landed",
    bar: "bg-knockdown/70",
    column: "kd_landed",
    group: "knockdowns",
    formatter: formatCount,
  },
  {
    key: "kd_absorbed",
    label: "Knockdowns absorbed",
    bar: "bg-knockdown/35",
    column: "kd_absorbed",
    group: "knockdowns",
    formatter: formatCount,
  },
  {
    key: "control",
    label: "Control time",
    bar: "bg-foreground-muted/35",
    column: "control_seconds",
    group: "control",
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

type FilterMode = "all" | "wins" | "losses" | "last5" | "title";

const FILTERS: ReadonlyArray<{ id: FilterMode; label: string; hint?: string }> = [
  { id: "all", label: "All fights" },
  { id: "wins", label: "Wins only" },
  { id: "losses", label: "Losses only" },
  { id: "last5", label: "Last 5" },
  {
    id: "title",
    label: "Title fights",
    hint:
      "Experimental — scraper flagged is_title_fight at event level, not per bout, so undercard rounds of title-headlined cards can leak in.",
  },
];

const ROUND_NUMBERS = [1, 2, 3, 4, 5] as const;

function applyFilter(
  entries: FighterBoutRound[],
  mode: FilterMode,
): FighterBoutRound[] {
  if (mode === "all") return entries;
  if (mode === "wins") return entries.filter((e) => e.result === "W");
  if (mode === "losses") return entries.filter((e) => e.result === "L");
  if (mode === "title") return entries.filter((e) => e.is_title_fight);
  // last5 — most recent 5 distinct bouts. `entries` is already date-DESC.
  const seen = new Set<string>();
  const keep = new Set<string>();
  for (const e of entries) {
    if (!seen.has(e.bout_id)) {
      seen.add(e.bout_id);
      if (keep.size < 5) keep.add(e.bout_id);
    }
  }
  return entries.filter((e) => keep.has(e.bout_id));
}

interface RoundAggregate {
  round: number;
  sample_size: number;
  values: Record<MetricKey, number>;
}

function aggregateByRound(entries: FighterBoutRound[]): RoundAggregate[] {
  const byRound = new Map<number, FighterBoutRound[]>();
  for (const e of entries) {
    const list = byRound.get(e.round) ?? [];
    list.push(e);
    byRound.set(e.round, list);
  }

  const rounds: RoundAggregate[] = [];
  for (const [round, items] of [...byRound.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const n = items.length;
    const avg = (col: keyof FighterBoutRound) =>
      items.reduce((acc, it) => acc + Number(it[col] ?? 0), 0) / n;
    const values = {} as Record<MetricKey, number>;
    for (const m of METRICS) values[m.key] = avg(m.column);
    rounds.push({ round, sample_size: n, values });
  }
  return rounds;
}

/**
 * Per-group maxes. Sharing a denominator within a metric group means a
 * "12 Sig Str absorbed" bar is visually shorter than a "22 Sig Str landed"
 * bar in the same round — which it should be.
 */
function computeGroupMaxes(
  rounds: RoundAggregate[],
): Record<GroupKey, number> {
  const acc: Record<GroupKey, number> = {
    strikes: 0,
    takedowns: 0,
    knockdowns: 0,
    subs: 0,
    control: 300, // 5:00 — fixed scale so quiet rounds don't blow up the bar
  };
  for (const m of METRICS) {
    for (const r of rounds) {
      const v = r.values[m.key];
      if (v > acc[m.group]) acc[m.group] = v;
    }
  }
  return acc;
}

export function RoundByRoundChart({ boutRounds }: RoundByRoundChartProps) {
  const [visible, setVisible] = React.useState<Set<MetricKey>>(
    () => new Set(DEFAULT_VISIBLE),
  );
  const [filter, setFilter] = React.useState<FilterMode>("all");

  const filteredEntries = React.useMemo(
    () => applyFilter(boutRounds, filter),
    [boutRounds, filter],
  );
  const aggregated = React.useMemo(
    () => aggregateByRound(filteredEntries),
    [filteredEntries],
  );
  const groupMax = React.useMemo(() => computeGroupMaxes(aggregated), [aggregated]);

  const toggleMetric = (key: MetricKey) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (boutRounds.length === 0) {
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

  const visibleMetrics = METRICS.filter((m) => visible.has(m.key));
  const byRound = new Map(aggregated.map((r) => [r.round, r]));

  return (
    <div className="flex flex-col gap-5">
      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          Filter
        </span>
        {FILTERS.map((f) => {
          const isActive = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={isActive}
              title={f.hint}
              className={cn(
                "inline-flex h-7 items-center rounded-sm border px-2.5 transition-colors",
                "font-sans text-[11px] font-medium uppercase tracking-widest",
                isActive
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-foreground/10 bg-foreground/[0.02] text-foreground-muted hover:border-foreground/25 hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Metric toggles */}
      <div className="flex flex-wrap gap-1.5">
        <span className="mr-1 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          Metrics
        </span>
        {METRICS.map((m) => {
          const isOn = visible.has(m.key);
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => toggleMetric(m.key)}
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
                className={cn(
                  "h-2 w-2 rounded-sm",
                  isOn ? m.bar : "bg-foreground/15",
                )}
              />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Chart */}
      {aggregated.length === 0 ? (
        <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-10 text-center">
          <p className="font-sans text-sm text-foreground-muted">
            No round data matches the current filter.
          </p>
        </div>
      ) : (
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
                const max = groupMax[metric.group] || 1;
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
                      const raw = row.values[metric.key];
                      const pct =
                        raw > 0
                          ? Math.max(4, Math.round((raw / max) * 100))
                          : 0;
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
      )}
    </div>
  );
}
