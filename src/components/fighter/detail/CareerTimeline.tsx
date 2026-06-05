"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

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

// DB method string → `method` namespace key (localized short labels), so the
// timeline tooltip's method reads "Суб"/"ЕР" in RU instead of hardcoded English.
const METHOD_KEY: Record<string, string> = {
  ko: "ko",
  tko: "tko",
  submission: "sub",
  decision_unanimous: "udec",
  decision_split: "sdec",
  decision_majority: "mdec",
  draw: "draw",
  no_contest: "nc",
  dq: "dq",
};

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
};

function Tooltip({ state }: { state: TooltipState }) {
  const tr = useTranslations("fighter");
  const tMethod = useTranslations("method");
  const ref = React.useRef<HTMLDivElement>(null);
  // Measure the rendered tooltip and clamp it into the viewport. A full-stats
  // bout is much taller than a "no stats" note, so the old fixed 200px height
  // estimate either left a gap or pushed a tall card off the top of the screen.
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(
    null,
  );
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(
      margin,
      Math.min(
        window.innerWidth - rect.width - margin,
        state.cx - rect.width / 2,
      ),
    );
    // Prefer above the dot; flip below when there isn't room, then clamp to the
    // viewport so the card never escapes the top or bottom edge.
    let top = state.cy - TOOLTIP_GAP - rect.height;
    if (top < margin) top = state.cy + TOOLTIP_GAP + DOT_R;
    top = Math.max(
      margin,
      Math.min(window.innerHeight - rect.height - margin, top),
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos({ left, top });
  }, [state]);

  const methodKey = state.bout.method ? METHOD_KEY[state.bout.method] : null;
  const m = methodKey ? tMethod(methodKey) : state.bout.method;
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
      ref={ref}
      role="tooltip"
      style={{
        left: pos?.left ?? Math.max(12, state.cx - TOOLTIP_W / 2),
        top: pos?.top ?? state.cy + TOOLTIP_GAP + DOT_R,
        width: TOOLTIP_W,
        visibility: pos ? "visible" : "hidden",
      }}
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
        {tr(`result_${state.bout.result}`)}
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
            <dt className="text-foreground-subtle">{tr("tipSigStr")}</dt>
            <dd className="font-mono tabular text-foreground">
              {state.bout.sig_str_landed}-{state.bout.sig_str_absorbed}
            </dd>
            <dt className="text-foreground-subtle">{tr("tipTakedowns")}</dt>
            <dd className="font-mono tabular text-foreground">
              {state.bout.td_landed}/{state.bout.td_attempted}
              {tdAcc != null ? (
                <span className="ml-1 text-foreground-muted">· {tdAcc}%</span>
              ) : null}
            </dd>
            <dt className="text-foreground-subtle">{tr("tipControl")}</dt>
            <dd className="font-mono tabular text-foreground">
              {formatControl(state.bout.control_seconds)}
            </dd>
          </dl>
        </>
      ) : (
        <p className="mt-2 font-sans text-[10px] text-foreground-subtle">
          {tr("tipNoStats")}
        </p>
      )}
    </div>
  );
}

export function CareerTimeline({ bouts }: CareerTimelineProps) {
  const t = useTranslations("fighter");
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);
  const hideTimer = React.useRef<number | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const dragState = React.useRef<{
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);

  const lastBoutMs = React.useMemo(
    () => bouts.reduce((mx, b) => Math.max(mx, Date.parse(b.event_date)), 0),
    [bouts],
  );
  // Snapshot the clock once after mount instead of reading Date.now() during
  // render: first paint (server + hydration) uses the last bout's date as a
  // deterministic right edge so the SVG width / today-tick can't mismatch
  // across a UTC-midnight render; the real "today" extends the axis on mount.
  const [clientNow, setClientNow] = React.useState<number | null>(null);
  const [shadow, setShadow] = React.useState({ left: false, right: false });
  const updateShadow = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 4;
    setShadow((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  const onEnter = (bout: TimelineBout, el: SVGCircleElement) => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    setTooltip({ bout, cx, cy });
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

  React.useEffect(() => {
    // One-time post-mount clock snapshot — same effect-on-mount pattern as
    // useMounted, not render-driven state sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClientNow(Date.now());
  }, []);

  // After mount, scroll fully to the end so the most recent fights and the
  // "today" marker are in view — a career reads newest-first. Re-runs when the
  // real clock extends the axis past the last bout, and refreshes the
  // scroll-shadow affordance. Setting scrollLeft past the maximum clamps.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    updateShadow();
  }, [clientNow, updateShadow]);

  if (bouts.length === 0) return null;

  const sorted = [...bouts].sort((a, b) =>
    a.event_date.localeCompare(b.event_date),
  );

  // The timeline's right edge is "today", placed proportionally by day-of-year
  // — not a padded future year. Before mount we fall back to the last bout's
  // date so the first paint is deterministic; `mounted` gates the dashed
  // "today" accent so it never points at the last fight during that frame.
  const mounted = clientNow != null;
  const nowMs = clientNow ?? lastBoutMs;
  const currentYear = new Date(nowMs).getUTCFullYear();
  const todayX = xForDateMs(nowMs);
  const svgWidth = todayX + PADDING_X;

  const yCenter = 42;
  const yYearLabel = TIMELINE_HEIGHT - 12;

  // Year tick marks. Whole years 1993..currentYear-1 sit at their Jan-1
  // boundary; the current year is marked at today's proportional
  // position (the axis end) and always labelled. Label every 2nd whole
  // year so the bar reads cleanly at full zoom.
  const ticks: Array<{
    year: number;
    x: number;
    label: boolean;
    isToday: boolean;
  }> = [];
  for (let y = FIRST_YEAR; y < currentYear; y += 1) {
    ticks.push({
      year: y,
      x: PADDING_X + (y - FIRST_YEAR) * YEAR_WIDTH,
      label: y % 2 === 0,
      isToday: false,
    });
  }
  ticks.push({ year: currentYear, x: todayX, label: true, isToday: mounted });

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
      <div className="relative">
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onScroll={updateShadow}
        className="cursor-grab overflow-x-auto select-none"
        style={{ touchAction: "pan-x", overscrollBehaviorX: "contain" }}
      >
        <svg
          width={svgWidth}
          height={TIMELINE_HEIGHT}
          style={{ display: "block" }}
          role="img"
          aria-label={t("timelineAriaLabel")}
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
              {t.isToday ? (
                // "Today" marker — a dashed gold accent line so the
                // current year reads as "now", positioned by day-of-year.
                <line
                  x1={t.x}
                  y1={yCenter - 22}
                  x2={t.x}
                  y2={yCenter + DOT_R + 14}
                  stroke="oklch(0.78 0.15 70 / 0.55)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
              ) : (
                <line
                  x1={t.x}
                  y1={yCenter + DOT_R + 6}
                  x2={t.x}
                  y2={yCenter + DOT_R + (t.label ? 14 : 10)}
                  stroke="oklch(0.30 0.01 240)"
                  strokeWidth={1}
                />
              )}
              {t.label ? (
                <text
                  x={t.x}
                  y={yYearLabel}
                  textAnchor="middle"
                  fill={
                    t.isToday ? "oklch(0.78 0.15 70)" : "oklch(0.45 0.01 240)"
                  }
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
                href={`/bouts/${b.bout_id}`}
                aria-label={t("timelineBoutAria", {
                  date: b.event_date.slice(0, 10),
                  result: t(`result_${b.result}`),
                  opponent: b.opponent_name,
                })}
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
        {/* Scroll-shadow affordance — fades in at whichever edge still has
            timeline hidden past it, the standard "there's more to scroll" cue. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-background-base to-transparent transition-opacity duration-200"
          style={{ opacity: shadow.left ? 1 : 0 }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background-base to-transparent transition-opacity duration-200"
          style={{ opacity: shadow.right ? 1 : 0 }}
        />
      </div>

      {/* Legend — dot colour/size key, including the grey draw/NC dot that the
          section explainer doesn't call out. */}
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
        <li className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: colorFor("W") }}
            aria-hidden
          />
          {t("result_W")}
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: colorFor("L") }}
            aria-hidden
          />
          {t("result_L")}
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: colorFor("D") }}
            aria-hidden
          />
          {t("legendDrawNc")}
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-full border border-foreground/40 bg-foreground/15"
            aria-hidden
          />
          {t("titleChip")}
        </li>
      </ul>

      <p
        className={cn(
          "font-sans text-[11px] uppercase tracking-widest text-foreground-muted",
          "flex flex-wrap items-baseline gap-x-2.5 gap-y-1",
        )}
      >
        <span>{t("tlWins", { n: wins })}</span>
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span>{t("tlLosses", { n: losses })}</span>
        {draws > 0 ? (
          <>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>{t("tlDraws", { n: draws })}</span>
          </>
        ) : null}
        {ncs > 0 ? (
          <>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>{t("tlNoContests", { n: ncs })}</span>
          </>
        ) : null}
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span>
          {t("lastFive")}:{" "}
          <span className="font-mono tabular text-foreground">
            {lastFiveLabel}
          </span>
        </span>
        <span aria-hidden className="text-foreground-subtle/40">·</span>
        <span className="text-foreground-subtle">
          {t("dragToScroll")} · {FIRST_YEAR}–{currentYear}
        </span>
      </p>

      {tooltip ? <Tooltip state={tooltip} /> : null}
    </div>
  );
}
