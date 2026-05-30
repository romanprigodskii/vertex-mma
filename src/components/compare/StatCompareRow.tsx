import { ArrowLeft, ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

export type StatFormat = "number" | "percent" | "integer" | "time";

interface StatCompareRowProps {
  label: string;
  valueA: number | null;
  valueB: number | null;
  format: StatFormat;
  /** Decimal places for `number` format. Ignored otherwise. */
  decimals?: number;
  /** When true, higher value wins. When false, lower wins. When omitted, no leader is highlighted. */
  higherIsBetter?: boolean;
  /** Suffix to append to formatted values (e.g. " cm", " bouts"). */
  unit?: string;
  /** Inline note rendered under the row (e.g. "Retired" caveats). */
  noteA?: string | null;
  noteB?: string | null;
}

function format(
  v: number | null,
  fmt: StatFormat,
  decimals = 2,
  unit?: string,
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  let body: string;
  switch (fmt) {
    case "integer":
      body = Math.round(v).toString();
      break;
    case "percent":
      body = `${Math.round(v * 100)}%`;
      break;
    case "time": {
      const total = Math.round(v);
      const m = Math.floor(total / 60);
      const s = total % 60;
      body = `${m}:${s.toString().padStart(2, "0")}`;
      break;
    }
    case "number":
    default:
      body = v.toFixed(decimals);
  }
  return unit ? `${body}${unit}` : body;
}

/** Treat values within 5% relative as a tie, modulo a tiny absolute fudge. */
function decideLeader(
  a: number | null,
  b: number | null,
  higherIsBetter: boolean | undefined,
): "a" | "b" | "tie" | "none" {
  if (higherIsBetter == null) return "none";
  if (a == null && b == null) return "none";
  if (a == null) return "b";
  if (b == null) return "a";
  if (a === b) return "tie";
  const max = Math.max(Math.abs(a), Math.abs(b));
  const rel = max > 0 ? Math.abs(a - b) / max : 0;
  if (rel < 0.05) return "tie";
  if (higherIsBetter) return a > b ? "a" : "b";
  return a < b ? "a" : "b";
}

function MobileIndicator({
  leader,
}: {
  leader: "a" | "b" | "tie" | "none";
}) {
  if (leader === "a")
    return <ArrowLeft className="h-5 w-5 text-streak-win" aria-hidden />;
  if (leader === "b")
    return <ArrowRight className="h-5 w-5 text-streak-win" aria-hidden />;
  if (leader === "tie")
    return (
      <span aria-hidden className="text-foreground-subtle/60">
        =
      </span>
    );
  return (
    <span aria-hidden className="text-foreground-subtle/30">
      ·
    </span>
  );
}

export function StatCompareRow({
  label,
  valueA,
  valueB,
  format: fmt,
  decimals,
  higherIsBetter,
  unit,
  noteA,
  noteB,
}: StatCompareRowProps) {
  const leader = decideLeader(valueA, valueB, higherIsBetter);
  const aWon = leader === "a";
  const bWon = leader === "b";
  const tie = leader === "tie";

  return (
    <div className="border-b border-foreground/[0.06] py-4 last:border-b-0 sm:py-5">
      {/* Mobile: label on top, then 3-col values with single indicator */}
      <div className="sm:hidden">
        <div className="mb-2 text-center font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {label}
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-baseline gap-3">
          <div
            className={cn(
              "text-right font-display tabular text-xl tracking-tight",
              aWon ? "text-streak-win" : "text-foreground",
            )}
          >
            <span>{format(valueA, fmt, decimals, unit)}</span>
            {noteA ? (
              <p className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                {noteA}
              </p>
            ) : null}
          </div>
          <div className="flex h-6 w-6 items-center justify-center text-foreground-subtle">
            <MobileIndicator leader={leader} />
          </div>
          <div
            className={cn(
              "text-left font-display tabular text-xl tracking-tight",
              bWon ? "text-streak-win" : "text-foreground",
            )}
          >
            <span>{format(valueB, fmt, decimals, unit)}</span>
            {noteB ? (
              <p className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                {noteB}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Desktop: 5-col grid (value · arrow · label · arrow · value) */}
      <div className="hidden grid-cols-[1fr_auto_2fr_auto_1fr] items-baseline gap-4 sm:grid">
        <div
          className={cn(
            "text-right font-display tabular text-3xl tracking-tight",
            aWon ? "text-streak-win" : "text-foreground",
          )}
        >
          <span>{format(valueA, fmt, decimals, unit)}</span>
          {noteA ? (
            <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
              {noteA}
            </p>
          ) : null}
        </div>
        <div
          className="flex h-6 w-6 items-center justify-center text-foreground-subtle"
          aria-hidden
        >
          {aWon ? (
            <ArrowLeft className="h-5 w-5 text-streak-win" />
          ) : tie ? (
            <span className="text-foreground-subtle/60">=</span>
          ) : (
            <span className="text-foreground-subtle/30">·</span>
          )}
        </div>
        <div className="text-center font-sans text-[13px] font-medium uppercase tracking-widest text-foreground-muted">
          {label}
        </div>
        <div
          className="flex h-6 w-6 items-center justify-center text-foreground-subtle"
          aria-hidden
        >
          {bWon ? (
            <ArrowRight className="h-5 w-5 text-streak-win" />
          ) : tie ? (
            <span className="text-foreground-subtle/60">=</span>
          ) : (
            <span className="text-foreground-subtle/30">·</span>
          )}
        </div>
        <div
          className={cn(
            "text-left font-display tabular text-3xl tracking-tight",
            bWon ? "text-streak-win" : "text-foreground",
          )}
        >
          <span>{format(valueB, fmt, decimals, unit)}</span>
          {noteB ? (
            <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
              {noteB}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Stat row with arbitrary string values (e.g. stance "Orthodox" / "Southpaw"). */
export function StatTextRow({
  label,
  valueA,
  valueB,
  noteA,
  noteB,
}: {
  label: string;
  valueA: string | null;
  valueB: string | null;
  noteA?: string | null;
  noteB?: string | null;
}) {
  return (
    <div className="border-b border-foreground/[0.06] py-4 last:border-b-0 sm:py-5">
      {/* Mobile */}
      <div className="sm:hidden">
        <div className="mb-2 text-center font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {label}
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-baseline gap-3">
          <div className="text-right font-display text-lg uppercase tracking-tight text-foreground">
            {valueA ?? "—"}
            {noteA ? (
              <p className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                {noteA}
              </p>
            ) : null}
          </div>
          <span aria-hidden className="text-foreground-subtle/30">
            ·
          </span>
          <div className="text-left font-display text-lg uppercase tracking-tight text-foreground">
            {valueB ?? "—"}
            {noteB ? (
              <p className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                {noteB}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden grid-cols-[1fr_auto_2fr_auto_1fr] items-baseline gap-4 sm:grid">
        <div className="text-right font-display text-3xl uppercase tracking-tight text-foreground">
          {valueA ?? "—"}
          {noteA ? (
            <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
              {noteA}
            </p>
          ) : null}
        </div>
        <span aria-hidden className="text-foreground-subtle/30">
          ·
        </span>
        <div className="text-center font-sans text-[13px] font-medium uppercase tracking-widest text-foreground-muted">
          {label}
        </div>
        <span aria-hidden className="text-foreground-subtle/30">
          ·
        </span>
        <div className="text-left font-display text-3xl uppercase tracking-tight text-foreground">
          {valueB ?? "—"}
          {noteB ? (
            <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
              {noteB}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
