import Link from "next/link";

import type { PeakVertexInfo } from "@/lib/score-history";

const METHOD_SHORT: Record<string, string> = {
  ko: "KO",
  tko: "TKO",
  submission: "Sub",
  decision_unanimous: "U-Dec",
  decision_split: "S-Dec",
  decision_majority: "M-Dec",
  draw: "Draw",
  no_contest: "NC",
  dq: "DQ",
};

function methodLabel(method: string | null): string {
  if (!method) return "—";
  return METHOD_SHORT[method] ?? method;
}

function ResultPill({ result }: { result: "W" | "L" | "D" | "NC" }) {
  const cls =
    result === "W"
      ? "text-streak-win"
      : result === "L"
        ? "text-streak-loss"
        : "text-foreground-muted";
  return <span className={cls}>{result}</span>;
}

interface PeakVertexProps {
  info: PeakVertexInfo;
}

/**
 * Wave 31.7 — Peak Vertex profile panel. Surfaces the highest historical
 * vertex_score plus the bout that produced it and (if applicable) the
 * bout where the score first dropped below peak.
 *
 * Layout: large number on the left (peak), date + anchor bout chip on
 * the right. When endingBout is null the fighter is at-or-above their
 * historical peak — show a single-bout layout. When current < peak,
 * show the delta below the bouts row.
 */
export function PeakVertex({ info }: PeakVertexProps) {
  const { peak, peakDate, anchorBout, endingBout, currentScore } = info;
  // Null current (no recent UFC activity) counts as 0 — the user sees the
  // full peak as the drop, not a misleadingly small delta vs all-time.
  const effectiveCurrent = currentScore ?? 0;
  const delta = effectiveCurrent - peak;
  const isAtPeak = endingBout == null && delta === 0;

  return (
    <section
      aria-label="Peak Vertex Score"
      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4 sm:p-5"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
          Peak Vertex
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {peakDate}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-display tabular text-5xl leading-none text-foreground">
            {peak}
          </span>
          {delta !== 0 ? (
            <span
              className={
                "font-sans text-xs " +
                (delta > 0 ? "text-streak-win" : "text-foreground-muted")
              }
            >
              {delta > 0 ? `+${delta}` : delta} vs current
            </span>
          ) : (
            <span className="font-sans text-xs text-foreground-muted">
              currently at peak
            </span>
          )}
        </div>

        <div className="min-w-[200px] flex-1 space-y-2 font-sans text-sm">
          <div>
            <span className="text-[11px] uppercase tracking-widest text-foreground-subtle">
              After
            </span>
            <span className="ml-2 text-foreground-muted">
              <ResultPill result={anchorBout.result} />
              <span className="ml-1.5">vs</span>{" "}
              <Link
                href={`/fighters/${anchorBout.opponentSlug}`}
                className="text-foreground transition-colors hover:text-primary"
              >
                {anchorBout.opponentName}
              </Link>
              <span className="text-foreground-subtle">
                {" · "}
                {methodLabel(anchorBout.method)}
              </span>
            </span>
          </div>

          {endingBout ? (
            <div>
              <span className="text-[11px] uppercase tracking-widest text-foreground-subtle">
                Ended
              </span>
              <span className="ml-2 text-foreground-muted">
                <ResultPill result={endingBout.result} />
                <span className="ml-1.5">vs</span>{" "}
                <Link
                  href={`/fighters/${endingBout.opponentSlug}`}
                  className="text-foreground transition-colors hover:text-primary"
                >
                  {endingBout.opponentName}
                </Link>
                <span className="text-foreground-subtle">
                  {" · "}
                  {methodLabel(endingBout.method)} · {endingBout.eventDate}
                  {" · "}
                  <span className="text-foreground-muted">
                    score → {endingBout.scoreAfter}
                  </span>
                </span>
              </span>
            </div>
          ) : isAtPeak ? (
            <div className="text-[11px] uppercase tracking-widest text-streak-win">
              Still at career peak
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
