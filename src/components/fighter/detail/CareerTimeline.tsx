"use client";

import * as React from "react";

import type { TimelineBout } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface CareerTimelineProps {
  bouts: TimelineBout[];
}

const DOT_R = 6;
const TITLE_DOT_R = 8;
const HEIGHT = 100;
const PADDING_X = 16;
const TOOLTIP_W = 240;
const TOOLTIP_GAP = 14;

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

function methodLabel(method: string | null): string | null {
  if (!method) return null;
  return METHOD_SHORT[method] ?? method;
}

function formatRoundTime(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatControl(sec: number): string {
  return formatRoundTime(sec);
}

function colorFor(result: TimelineBout["result"]): string {
  switch (result) {
    case "W":
      return "oklch(0.65 0.15 145)";
    case "L":
      return "oklch(0.55 0.15 27)";
    default:
      return "oklch(0.50 0.01 240)";
  }
}

function strokeFor(result: TimelineBout["result"]): string {
  if (result === "W") return "oklch(0.65 0.15 145 / 0.4)";
  if (result === "L") return "oklch(0.55 0.15 27 / 0.4)";
  return "oklch(0.50 0.01 240 / 0.3)";
}

const RESULT_LABEL: Record<TimelineBout["result"], string> = {
  W: "Win",
  L: "Loss",
  D: "Draw",
  NC: "No contest",
};

type TooltipState = {
  bout: TimelineBout;
  cx: number;
  cy: number;
  placement: "above" | "below";
};

function Tooltip({ state }: { state: TooltipState }) {
  // Defer viewport-aware positioning to first browser paint; the parent
  // re-renders this on every hover so initial value uses event-time window.
  const viewport =
    typeof window !== "undefined" ? window.innerWidth : TOOLTIP_W + 64;
  const left = Math.max(
    16,
    Math.min(viewport - TOOLTIP_W - 16, state.cx - TOOLTIP_W / 2),
  );
  // Tooltip height varies with content but ~190 covers all rows.
  const tooltipHeight = 200;
  const top =
    state.placement === "above"
      ? state.cy - TOOLTIP_GAP - tooltipHeight
      : state.cy + TOOLTIP_GAP + DOT_R;

  const m = methodLabel(state.bout.method);
  const t = formatRoundTime(state.bout.time_finished_seconds);
  const finishDetail = state.bout.round_finished
    ? `R${state.bout.round_finished}${t ? ` · ${t}` : ""}`
    : null;

  const tdAcc =
    state.bout.td_attempted > 0
      ? Math.round((state.bout.td_landed / state.bout.td_attempted) * 100)
      : null;

  return (
    <div
      role="tooltip"
      style={{ left, top, width: TOOLTIP_W }}
      className={cn(
        "pointer-events-none fixed z-50 rounded-md border border-foreground/15 bg-background-elevated/95 px-3 py-2.5 shadow-elevation-2 backdrop-blur-sm",
        "animate-in fade-in-0 duration-100",
      )}
    >
      <p className="truncate font-sans text-[13px] text-foreground">
        {state.bout.event_name}
      </p>
      <p className="font-mono text-[10px] tabular text-foreground-muted">
        {state.bout.event_date.slice(0, 10)}
      </p>

      <div className="my-2 h-px bg-foreground/10" aria-hidden />

      <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
        vs
      </p>
      <p className="truncate font-display text-base uppercase tracking-tight text-foreground">
        {state.bout.opponent_name}
      </p>
      <p
        className={cn(
          "font-sans text-xs",
          state.bout.result === "W"
            ? "text-streak-win"
            : state.bout.result === "L"
              ? "text-streak-loss"
              : "text-foreground-muted",
        )}
      >
        {RESULT_LABEL[state.bout.result]}
        {m ? (
          <>
            <span className="mx-1 text-foreground-subtle/40">·</span>
            <span className="text-foreground-muted">{m}</span>
          </>
        ) : null}
        {finishDetail ? (
          <>
            <span className="mx-1 text-foreground-subtle/40">·</span>
            <span className="text-foreground-subtle">{finishDetail}</span>
          </>
        ) : null}
      </p>

      {state.bout.has_stats ? (
        <>
          <div className="my-2 h-px bg-foreground/10" aria-hidden />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-sans text-[11px]">
            <dt className="text-foreground-subtle">Sig Str</dt>
            <dd className="font-mono tabular text-foreground">
              {state.bout.sig_str_landed}-{state.bout.sig_str_absorbed}
            </dd>
            <dt className="text-foreground-subtle">Takedowns</dt>
            <dd className="font-mono tabular text-foreground">
              {state.bout.td_landed}/{state.bout.td_attempted}
              {tdAcc != null ? (
                <span className="ml-1 text-foreground-muted">· {tdAcc}%</span>
              ) : null}
            </dd>
            <dt className="text-foreground-subtle">Control</dt>
            <dd className="font-mono tabular text-foreground">
              {formatControl(state.bout.control_seconds)}
            </dd>
          </dl>
        </>
      ) : (
        <p className="mt-2 font-sans text-[10px] text-foreground-subtle">
          Per-round stats not recorded for this bout.
        </p>
      )}
    </div>
  );
}

export function CareerTimeline({ bouts }: CareerTimelineProps) {
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);
  const hideTimer = React.useRef<number | null>(null);

  const onEnter = (bout: TimelineBout, el: SVGCircleElement) => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Flip below the dot if the timeline sits near the top of the viewport.
    const placement: "above" | "below" = cy < 240 ? "below" : "above";
    setTooltip({ bout, cx, cy, placement });
  };

  const onLeave = () => {
    // tiny defer so a fast cursor sweep doesn't ping-pong show/hide
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setTooltip(null), 80);
  };

  React.useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  if (bouts.length === 0) return null;

  const sorted = [...bouts].sort((a, b) =>
    a.event_date.localeCompare(b.event_date),
  );
  const startMs = new Date(sorted[0].event_date).getTime();
  const endMs = new Date(sorted[sorted.length - 1].event_date).getTime();
  const span = Math.max(1, endMs - startMs);

  const width = 720;
  const innerWidth = width - PADDING_X * 2;
  const yCenter = 42;
  const yYearLabel = HEIGHT - 12;

  const startYear = new Date(sorted[0].event_date).getUTCFullYear();
  const endYear = new Date(
    sorted[sorted.length - 1].event_date,
  ).getUTCFullYear();
  const ticks: Array<{ year: number; x: number }> = [];
  const yearSpan = endYear - startYear;
  const step = yearSpan > 16 ? 3 : yearSpan > 8 ? 2 : 1;
  for (let y = startYear; y <= endYear; y += step) {
    const t = new Date(Date.UTC(y, 0, 1)).getTime();
    const x = PADDING_X + ((t - startMs) / span) * innerWidth;
    ticks.push({ year: y, x });
  }

  const wins = bouts.filter((b) => b.result === "W").length;
  const losses = bouts.filter((b) => b.result === "L").length;
  const draws = bouts.filter((b) => b.result === "D").length;
  const ncs = bouts.filter((b) => b.result === "NC").length;
  const lastFiveLabel = bouts
    .slice(0, 5)
    .map((b) => b.result)
    .join(" ");

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="h-auto w-full min-w-[600px]"
          role="img"
          aria-label="Career timeline of completed bouts"
        >
          {/* Axis line */}
          <line
            x1={PADDING_X}
            y1={yCenter}
            x2={width - PADDING_X}
            y2={yCenter}
            stroke="oklch(0.30 0.01 240)"
            strokeWidth={1}
          />

          {/* Year ticks — labels sit BELOW the dot line so they never overlap. */}
          {ticks.map((t) => (
            <g key={t.year}>
              <line
                x1={t.x}
                y1={yCenter + DOT_R + 6}
                x2={t.x}
                y2={yCenter + DOT_R + 14}
                stroke="oklch(0.30 0.01 240)"
                strokeWidth={1}
              />
              <text
                x={t.x}
                y={yYearLabel}
                textAnchor="middle"
                fill="oklch(0.45 0.01 240)"
                style={{ fontSize: 10, letterSpacing: "0.16em" }}
                className="font-mono"
              >
                {t.year}
              </text>
            </g>
          ))}

          {sorted.map((b) => {
            const t = new Date(b.event_date).getTime();
            const x = PADDING_X + ((t - startMs) / span) * innerWidth;
            const r = b.is_title_fight ? TITLE_DOT_R : DOT_R;
            return (
              <a
                key={b.bout_id}
                href={`/events/${b.event_slug}#bout-${b.bout_id}`}
                onMouseEnter={(e) =>
                  onEnter(b, e.currentTarget.querySelector("circle.dot") as SVGCircleElement)
                }
                onMouseLeave={onLeave}
                onFocus={(e) =>
                  onEnter(b, e.currentTarget.querySelector("circle.dot") as SVGCircleElement)
                }
                onBlur={onLeave}
                aria-label={`${b.event_date.slice(0, 10)} ${RESULT_LABEL[b.result]} vs ${b.opponent_name}`}
                style={{ outline: "none" }}
              >
                <circle
                  cx={x}
                  cy={yCenter}
                  r={r + 5}
                  fill={strokeFor(b.result)}
                  opacity={0.25}
                  pointerEvents="none"
                />
                <circle
                  className="dot transition-transform duration-150 hover:scale-110"
                  cx={x}
                  cy={yCenter}
                  r={r}
                  fill={colorFor(b.result)}
                  stroke="oklch(0.08 0.005 240)"
                  strokeWidth={1.5}
                />
              </a>
            );
          })}
        </svg>
      </div>

      <p
        className={cn(
          "font-sans text-[11px] uppercase tracking-widest text-foreground-muted",
          "flex flex-wrap items-baseline gap-x-2.5 gap-y-1",
        )}
      >
        <span>
          <span className="font-mono tabular text-foreground">{wins}</span>{" "}
          wins
        </span>
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span>
          <span className="font-mono tabular text-foreground">{losses}</span>{" "}
          losses
        </span>
        {draws > 0 ? (
          <>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>
              <span className="font-mono tabular text-foreground">{draws}</span>{" "}
              draws
            </span>
          </>
        ) : null}
        {ncs > 0 ? (
          <>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>
              <span className="font-mono tabular text-foreground">{ncs}</span>{" "}
              NC
            </span>
          </>
        ) : null}
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span>
          last 5:{" "}
          <span className="font-mono tabular text-foreground">
            {lastFiveLabel}
          </span>
        </span>
      </p>

      {tooltip ? <Tooltip state={tooltip} /> : null}
    </div>
  );
}
