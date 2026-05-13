import type { FightHistoryEntry } from "@/lib/fighter-detail";
import { cn } from "@/lib/utils";

interface CareerTimelineProps {
  history: FightHistoryEntry[];
}

const DOT_R = 6;
const TITLE_DOT_R = 8;
const HEIGHT = 80;
const PADDING_X = 16;

function colorFor(result: FightHistoryEntry["result"]): string {
  switch (result) {
    case "W":
      return "oklch(0.65 0.15 145)"; // streak-win
    case "L":
      return "oklch(0.55 0.15 27)"; // streak-loss
    default:
      return "oklch(0.50 0.01 240)"; // muted (draw / NC)
  }
}

function strokeFor(result: FightHistoryEntry["result"]): string {
  if (result === "W") return "oklch(0.65 0.15 145 / 0.4)";
  if (result === "L") return "oklch(0.55 0.15 27 / 0.4)";
  return "oklch(0.50 0.01 240 / 0.3)";
}

/** Compute approximate "last 5" string ("W W W W W" or "W L D W W"). */
function lastFiveLabel(history: FightHistoryEntry[]): string {
  return history
    .slice(0, 5)
    .map((h) => h.result)
    .join(" ");
}

export function CareerTimeline({ history }: CareerTimelineProps) {
  if (history.length === 0) return null;

  // Sort oldest → newest for plotting.
  const sorted = [...history].sort((a, b) =>
    a.event_date.localeCompare(b.event_date),
  );

  const startMs = new Date(sorted[0].event_date).getTime();
  const endMs = new Date(sorted[sorted.length - 1].event_date).getTime();
  const span = Math.max(1, endMs - startMs);
  const width = 720;
  const innerWidth = width - PADDING_X * 2;
  const yCenter = HEIGHT / 2 + 2;

  // Year tick marks — pick whole years between start and end.
  const startYear = new Date(sorted[0].event_date).getUTCFullYear();
  const endYear = new Date(
    sorted[sorted.length - 1].event_date,
  ).getUTCFullYear();
  const ticks: Array<{ year: number; x: number }> = [];
  // Step adaptively so the strip doesn't crowd on long careers.
  const yearSpan = endYear - startYear;
  const step = yearSpan > 16 ? 3 : yearSpan > 8 ? 2 : 1;
  for (let y = startYear; y <= endYear; y += step) {
    const t = new Date(Date.UTC(y, 0, 1)).getTime();
    const x = PADDING_X + ((t - startMs) / span) * innerWidth;
    ticks.push({ year: y, x });
  }

  const wins = history.filter((h) => h.result === "W").length;
  const losses = history.filter((h) => h.result === "L").length;
  const draws = history.filter((h) => h.result === "D").length;
  const ncs = history.filter((h) => h.result === "NC").length;

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

          {/* Year ticks */}
          {ticks.map((t) => (
            <g key={t.year}>
              <line
                x1={t.x}
                y1={yCenter - 6}
                x2={t.x}
                y2={yCenter + 6}
                stroke="oklch(0.35 0.01 240)"
                strokeWidth={1}
              />
              <text
                x={t.x}
                y={yCenter + 22}
                textAnchor="middle"
                fill="oklch(0.45 0.01 240)"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.16em",
                }}
                className="font-mono"
              >
                {t.year}
              </text>
            </g>
          ))}

          {/* Dots — newer ones overlay older ones (sorted ASC, painted in order) */}
          {sorted.map((h) => {
            const t = new Date(h.event_date).getTime();
            const x = PADDING_X + ((t - startMs) / span) * innerWidth;
            const r = h.is_title_fight ? TITLE_DOT_R : DOT_R;
            const fill = colorFor(h.result);
            const stroke = strokeFor(h.result);
            const tooltip = `${h.event_date.slice(0, 10)} · ${h.result} vs ${h.opponent_name}`;
            return (
              <a
                key={h.bout_id}
                href={`/fighters/${h.opponent_slug}`}
              >
                <title>{tooltip}</title>
                <circle
                  cx={x}
                  cy={yCenter}
                  r={r + 4}
                  fill={stroke}
                  opacity={0.25}
                />
                <circle
                  cx={x}
                  cy={yCenter}
                  r={r}
                  fill={fill}
                  stroke="oklch(0.08 0.005 240)"
                  strokeWidth={1.5}
                  className="transition-transform duration-150 hover:scale-110"
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
            {lastFiveLabel(history)}
          </span>
        </span>
      </p>
    </div>
  );
}
