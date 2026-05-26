"use client";

import * as React from "react";

import type { ScoreHistoryPoint } from "@/lib/score-history";

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

// SVG canvas. Width auto-scales via viewBox; height locked to keep
// label space sensible.
const W = 760;
const H = 280;
const PAD_L = 36;
const PAD_R = 20;
const PAD_T = 18;
const PAD_B = 36;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const Y_GRID = [0, 25, 50, 75, 100];

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function resultColor(r: "W" | "L" | "D" | "NC"): string {
  if (r === "W") return "var(--color-streak-win)";
  if (r === "L") return "var(--color-streak-loss)";
  return "var(--color-foreground-muted)";
}

interface ScoreHistoryChartProps {
  history: ScoreHistoryPoint[];
  mode: "current" | "all_time";
}

export function ScoreHistoryChart({ history, mode }: ScoreHistoryChartProps) {
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);
  const containerRef = React.useRef<SVGSVGElement | null>(null);

  if (history.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-12 text-center font-sans text-sm text-foreground-muted">
        No score history available for this fighter.
      </div>
    );
  }

  const values = history.map((p) =>
    mode === "current" ? p.currentScore : p.runningPeak,
  );
  const yMin = 0;
  const yMax = 100;

  const n = history.length;
  // When n === 1 we still want a single visible dot at x-center.
  const xOf = (i: number): number => {
    if (n === 1) return PAD_L + PLOT_W / 2;
    return PAD_L + (PLOT_W * i) / (n - 1);
  };
  const yOf = (v: number): number =>
    PAD_T + PLOT_H * (1 - (v - yMin) / (yMax - yMin));

  const pathLine = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`)
    .join(" ");
  const pathArea =
    pathLine +
    ` L${xOf(n - 1).toFixed(2)},${yOf(0).toFixed(2)}` +
    ` L${xOf(0).toFixed(2)},${yOf(0).toFixed(2)} Z`;

  const lineColor =
    mode === "current" ? "var(--color-primary)" : "var(--color-foreground)";
  const fillColor =
    mode === "current"
      ? "color-mix(in oklch, var(--color-primary) 18%, transparent)"
      : "color-mix(in oklch, var(--color-foreground) 10%, transparent)";

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = containerRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (n === 1) {
      setHoverIdx(0);
      return;
    }
    // nearest-point hit (snap to bout x)
    const t = Math.round(((x - PAD_L) / PLOT_W) * (n - 1));
    if (Number.isFinite(t)) setHoverIdx(Math.max(0, Math.min(n - 1, t)));
  }

  const hoverPoint = hoverIdx != null ? history[hoverIdx] : null;
  const hoverValue = hoverPoint
    ? mode === "current"
      ? hoverPoint.currentScore
      : hoverPoint.runningPeak
    : null;

  return (
    <div className="relative">
      <svg
        ref={containerRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-auto cursor-crosshair"
        role="img"
        aria-label={
          mode === "current"
            ? "Current Vertex score per bout"
            : "All-time peak Vertex score per bout"
        }
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {/* y-axis grid + labels */}
        {Y_GRID.map((g) => (
          <g key={g}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yOf(g)}
              y2={yOf(g)}
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray={g === 0 || g === 100 ? "0" : "2 4"}
              opacity={g === 0 || g === 100 ? 0.55 : 0.35}
            />
            <text
              x={PAD_L - 8}
              y={yOf(g) + 3}
              textAnchor="end"
              fill="var(--color-foreground-subtle)"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {g}
            </text>
          </g>
        ))}

        {/* area fill */}
        <path d={pathArea} fill={fillColor} />

        {/* main line */}
        <path
          d={pathLine}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* per-bout dots, color-coded by result */}
        {history.map((p, i) => {
          const isHover = i === hoverIdx;
          return (
            <circle
              key={p.boutId}
              cx={xOf(i)}
              cy={yOf(mode === "current" ? p.currentScore : p.runningPeak)}
              r={isHover ? 5 : 3}
              fill="var(--color-background-base)"
              stroke={resultColor(p.result)}
              strokeWidth={isHover ? 2.5 : 1.6}
            />
          );
        })}

        {/* hover crosshair */}
        {hoverIdx != null ? (
          <line
            x1={xOf(hoverIdx)}
            x2={xOf(hoverIdx)}
            y1={PAD_T}
            y2={H - PAD_B}
            stroke="var(--color-foreground-subtle)"
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.5}
          />
        ) : null}

        {/* first/last x labels so the timeline reads even without hover */}
        <text
          x={xOf(0)}
          y={H - PAD_B + 18}
          textAnchor="start"
          fill="var(--color-foreground-subtle)"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          {formatDate(history[0].eventDate)}
        </text>
        {n > 1 ? (
          <text
            x={xOf(n - 1)}
            y={H - PAD_B + 18}
            textAnchor="end"
            fill="var(--color-foreground-subtle)"
            fontSize={10}
            fontFamily="var(--font-mono)"
          >
            {formatDate(history[n - 1].eventDate)}
          </text>
        ) : null}
      </svg>

      {hoverPoint && hoverValue != null ? (
        <div
          className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md border border-foreground/15 bg-background-elevated/95 px-3 py-2 font-sans text-xs text-foreground shadow-elevation-2 backdrop-blur"
          aria-hidden
        >
          <div className="flex items-baseline gap-2">
            <span className="font-display tabular text-xl leading-none text-foreground">
              {hoverValue}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {hoverPoint.eventDate}
            </span>
          </div>
          <div className="mt-1 text-foreground-muted">
            <span style={{ color: resultColor(hoverPoint.result) }}>
              {hoverPoint.result}
            </span>{" "}
            vs <span className="text-foreground">{hoverPoint.opponentName}</span>
            <span className="text-foreground-subtle">
              {" · "}
              {methodLabel(hoverPoint.method)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
