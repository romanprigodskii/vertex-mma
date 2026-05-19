"use client";

import * as React from "react";

import type { TimelineBout } from "@/lib/fighter-detail";
import { isCuratedTitleFight } from "@/lib/title-fights";
import { cn } from "@/lib/utils";

interface CareerTimelineProps {
  bouts: TimelineBout[];
}

const DOT_R = 8;
const TITLE_DOT_R = 11;
// Wave 51 — unified scale: every fighter's timeline uses the same UFC-era
// axis (1993 → current year + 1), so two generations can be visually
// compared on the same horizontal coordinate. The SVG is intentionally
// wider than the viewport; the container scrolls horizontally and the
// view auto-centers on the fighter's career midpoint on mount.
const FIRST_YEAR = 1993;
const YEAR_WIDTH = 180; // px per year
const TIMELINE_HEIGHT = 100;
const PADDING_X = 24;
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

function xForDateMs(ms: number): number {
  const d = new Date(ms);
  const year =
    d.getUTCFullYear() + d.getUTCMonth() / 12 + d.getUTCDate() / 365;
  return PADDING_X + (year - FIRST_YEAR) * YEAR_WIDTH;
}

type TooltipState = {
  bout: TimelineBout;
  cx: number;
  cy: number;
  placement: "above" | "below";
};

function Tooltip({ state }: { state: TooltipState }) {
  const viewport =
    typeof window !== "undefined" ? window.innerWidth : TOOLTIP_W + 64;
  const left = Math.max(
    16,
    Math.min(viewport - TOOLTIP_W - 16, state.cx - TOOLTIP_W / 2),
  );
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
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const dragState = React.useRef<{
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);

  const onEnter = (bout: TimelineBout, el: SVGCircleElement) => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const placement: "above" | "below" = cy < 240 ? "below" : "above";
    setTooltip({ bout, cx, cy, placement });
  };

  const onLeave = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setTooltip(null), 80);
  };

  React.useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  // After mount, scroll horizontally so the fighter's career midpoint
  // lands roughly in the centre of the visible area. Without this, every
  // modern fighter would open with the camera on 1993 and look empty.
  React.useEffect(() => {
    if (!scrollRef.current || bouts.length === 0) return;
    const dates = bouts
      .map((b) => new Date(b.event_date).getTime())
      .filter((t) => Number.isFinite(t));
    if (dates.length === 0) return;
    const midMs = (Math.min(...dates) + Math.max(...dates)) / 2;
    const midX = xForDateMs(midMs);
    const viewport = scrollRef.current.clientWidth;
    scrollRef.current.scrollLeft = Math.max(0, midX - viewport / 2);
    // Run once after the first paint — subsequent re-renders should
    // preserve whatever the user has scrolled to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (bouts.length === 0) return null;

  const sorted = [...bouts].sort((a, b) =>
    a.event_date.localeCompare(b.event_date),
  );

  const currentYear = new Date().getFullYear();
  const lastYear = currentYear + 1;
  const totalYears = lastYear - FIRST_YEAR;
  const svgWidth = totalYears * YEAR_WIDTH + PADDING_X * 2;

  const yCenter = 42;
  const yYearLabel = TIMELINE_HEIGHT - 12;

  // Year tick marks. Label every 2 years so the bar reads cleanly even
  // at full zoom; minor ticks on the others keep the rhythm.
  const ticks: Array<{ year: number; x: number; label: boolean }> = [];
  for (let y = FIRST_YEAR; y < lastYear; y += 1) {
    ticks.push({
      year: y,
      x: PADDING_X + (y - FIRST_YEAR) * YEAR_WIDTH,
      label: y % 2 === 0,
    });
  }

  const wins = bouts.filter((b) => b.result === "W").length;
  const losses = bouts.filter((b) => b.result === "L").length;
  const draws = bouts.filter((b) => b.result === "D").length;
  const ncs = bouts.filter((b) => b.result === "NC").length;
  const lastFiveLabel = bouts
    .slice(0, 5)
    .map((b) => b.result)
    .join(" ");

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrollRef.current) return;
    // Only react to primary mouse / touch / pen. Ignore right-click.
    if (e.button !== 0) return;
    dragState.current = {
      startX: e.clientX,
      startScrollLeft: scrollRef.current.scrollLeft,
      moved: false,
    };
    e.currentTarget.style.cursor = "grabbing";
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragState.current || !scrollRef.current) return;
    const dx = e.clientX - dragState.current.startX;
    if (Math.abs(dx) > 3) {
      dragState.current.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (dragState.current.moved) {
      scrollRef.current.scrollLeft = dragState.current.startScrollLeft - dx;
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const moved = dragState.current?.moved;
    dragState.current = null;
    e.currentTarget.style.cursor = "grab";
    // If the pointer never moved past the threshold, let the click through
    // to the bout anchor underneath. If it did move, swallow the click so
    // a drag-release doesn't accidentally navigate.
    if (moved) {
      e.preventDefault();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="cursor-grab overflow-x-auto select-none"
        style={{ touchAction: "pan-x", overscrollBehaviorX: "contain" }}
      >
        <svg
          width={svgWidth}
          height={TIMELINE_HEIGHT}
          style={{ display: "block" }}
          role="img"
          aria-label="Career timeline of completed bouts across UFC history"
        >
          <line
            x1={PADDING_X}
            y1={yCenter}
            x2={svgWidth - PADDING_X}
            y2={yCenter}
            stroke="oklch(0.30 0.01 240)"
            strokeWidth={1}
          />

          {ticks.map((t) => (
            <g key={t.year}>
              <line
                x1={t.x}
                y1={yCenter + DOT_R + 6}
                x2={t.x}
                y2={yCenter + DOT_R + (t.label ? 14 : 10)}
                stroke="oklch(0.30 0.01 240)"
                strokeWidth={1}
              />
              {t.label ? (
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
              ) : null}
            </g>
          ))}

          {sorted.map((b) => {
            const x = xForDateMs(new Date(b.event_date).getTime());
            const isTitle = isCuratedTitleFight(b.bout_id);
            const r = isTitle ? TITLE_DOT_R : DOT_R;
            const isHovered = tooltip?.bout.bout_id === b.bout_id;
            return (
              <a
                key={b.bout_id}
                href={`/events/${b.event_slug}#bout-${b.bout_id}`}
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
                  className="dot"
                  cx={x}
                  cy={yCenter}
                  r={r}
                  fill={colorFor(b.result)}
                  stroke="oklch(0.08 0.005 240)"
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
                {isHovered ? (
                  <circle
                    cx={x}
                    cy={yCenter}
                    r={r + 4}
                    fill="none"
                    stroke={colorFor(b.result)}
                    strokeWidth={1.5}
                    opacity={0.55}
                    pointerEvents="none"
                  />
                ) : null}
                <circle
                  cx={x}
                  cy={yCenter}
                  r={18}
                  fill="transparent"
                  onMouseEnter={(e) => onEnter(b, e.currentTarget)}
                  onMouseLeave={onLeave}
                  onFocus={(e) => onEnter(b, e.currentTarget)}
                  onBlur={onLeave}
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
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span className="text-foreground-subtle">
          drag to scroll · {FIRST_YEAR}–{lastYear}
        </span>
      </p>

      {tooltip ? <Tooltip state={tooltip} /> : null}
    </div>
  );
}
