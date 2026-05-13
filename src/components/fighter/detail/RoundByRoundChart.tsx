import type { RoundAverage } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface RoundByRoundChartProps {
  rounds: RoundAverage[];
}

type Metric = {
  key: keyof RoundAverage;
  label: string;
  bar: string; // tailwind bg class
  formatter: (n: number) => string;
};

const METRICS: Metric[] = [
  {
    key: "avg_sig_str_landed",
    label: "Sig Str landed",
    bar: "bg-primary/60",
    formatter: (n) => n.toFixed(1),
  },
  {
    key: "avg_sig_str_absorbed",
    label: "Sig Str absorbed",
    bar: "bg-streak-loss/60",
    formatter: (n) => n.toFixed(1),
  },
  {
    key: "avg_td_landed",
    label: "Takedowns landed",
    bar: "bg-streak-win/60",
    formatter: (n) => n.toFixed(2),
  },
  {
    key: "avg_control_seconds",
    label: "Control time",
    bar: "bg-foreground-muted/40",
    // Format MM:SS
    formatter: (n) => {
      const total = Math.round(n);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${s.toString().padStart(2, "0")}`;
    },
  },
];

function indexByRound(rounds: RoundAverage[]): Map<number, RoundAverage> {
  return new Map(rounds.map((r) => [r.round, r]));
}

export function RoundByRoundChart({ rounds }: RoundByRoundChartProps) {
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
  const ROUND_NUMBERS = [1, 2, 3, 4, 5] as const;

  // Per-metric max across the rounds we actually have data for, so each row
  // is independently normalized (otherwise control-seconds dominates).
  const maxFor = (key: keyof RoundAverage): number => {
    const vals = rounds
      .map((r) => Number(r[key] ?? 0))
      .filter((v) => Number.isFinite(v));
    const m = vals.length > 0 ? Math.max(...vals) : 0;
    return m > 0 ? m : 1; // avoid div-by-zero; bars at 0 will still be 0-width
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr>
            <th className="w-[160px] py-2 text-left font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
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
          {METRICS.map((metric) => {
            const max = maxFor(metric.key);
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
                  const raw = Number(row[metric.key] ?? 0);
                  const pct = Math.max(2, Math.round((raw / max) * 100));
                  return (
                    <td key={r} className="py-3 pl-3 align-middle">
                      <div className="flex flex-col gap-1">
                        <div
                          className="h-1.5 rounded-sm"
                          aria-hidden
                          style={{ width: `${pct}%` }}
                        >
                          <div className={cn("h-full w-full rounded-sm", metric.bar)} />
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
  );
}
