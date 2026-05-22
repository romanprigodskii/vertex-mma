import type { FighterBoutRound } from "@/lib/fighter-detail";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface StrikingHeatmapProps {
  boutRounds: FighterBoutRound[];
}

interface ZoneTotals {
  head: number;
  body: number;
  legs: number;
  total: number;
}

function aggregate(
  rounds: FighterBoutRound[],
  side: "landed" | "absorbed",
): ZoneTotals {
  let head = 0;
  let body = 0;
  let legs = 0;
  for (const r of rounds) {
    if (side === "landed") {
      head += r.sig_str_head_landed ?? 0;
      body += r.sig_str_body_landed ?? 0;
      legs += r.sig_str_legs_landed ?? 0;
    } else {
      head += r.sig_str_head_absorbed ?? 0;
      body += r.sig_str_body_absorbed ?? 0;
      legs += r.sig_str_legs_absorbed ?? 0;
    }
  }
  return { head, body, legs, total: head + body + legs };
}

/**
 * Zone fill — one clean hue per side (gold for landed, red for absorbed)
 * at an opacity that scales with the zone's share of the total, normalised
 * so the most-struck zone reads at full intensity. An opacity ramp on a
 * single hue avoids the muddy mid-tones a lightness ramp produced.
 */
function zoneFill(
  share: number,
  maxShare: number,
  side: "landed" | "absorbed",
): string {
  if (maxShare <= 0) return "oklch(0.26 0.015 250 / 0.85)";
  const base = side === "landed" ? "0.82 0.16 75" : "0.62 0.21 25";
  const intensity = Math.max(0, Math.min(1, share / maxShare));
  const opacity = 0.28 + 0.72 * intensity;
  return `oklch(${base} / ${opacity.toFixed(3)})`;
}

const FIGURE_STROKE = "oklch(0.44 0.015 250)";

/** One bold, halo-outlined strike count, centred on a zone. */
function ZoneNumber({
  cx,
  cy,
  value,
}: {
  cx: number;
  cy: number;
  value: number;
}) {
  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="central"
      fill="oklch(0.99 0 0)"
      stroke="oklch(0.14 0.01 240)"
      strokeWidth={3.5}
      strokeLinejoin="round"
      style={{ paintOrder: "stroke", fontSize: 19, fontWeight: 700 }}
    >
      {formatNumber(value)}
    </text>
  );
}

function Silhouette({
  title,
  totals,
  side,
}: {
  title: string;
  totals: ZoneTotals;
  side: "landed" | "absorbed";
}) {
  const headPct = totals.total ? totals.head / totals.total : 0;
  const bodyPct = totals.total ? totals.body / totals.total : 0;
  const legsPct = totals.total ? totals.legs / totals.total : 0;
  const maxPct = Math.max(headPct, bodyPct, legsPct);

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        {title}
      </p>
      <svg
        viewBox="0 0 200 470"
        className="h-auto w-full max-w-[190px]"
        role="img"
        aria-label={`${title} per-zone heatmap`}
      >
        {/* One connected figure: legs first, the torso overlapping their
            tops at the hip, the head + neck on top — so the silhouette
            reads as a single person, not stacked primitives. */}
        <g stroke={FIGURE_STROKE} strokeWidth={1.5} strokeLinejoin="round">
          <g fill={zoneFill(legsPct, maxPct, side)}>
            <path d="M 72 314 L 100 314 L 96 442 Q 96 454 85 454 Q 74 454 74 442 Z" />
            <path d="M 102 314 L 130 314 L 128 442 Q 128 454 117 454 Q 106 454 106 442 Z" />
          </g>
          <path
            d="M 70 110 C 55 112 47 125 47 147 C 51 210 64 270 73 300 L 69 323 L 131 323 L 127 300 C 136 270 149 210 153 147 C 153 125 145 112 130 110 Z"
            fill={zoneFill(bodyPct, maxPct, side)}
          />
          <g fill={zoneFill(headPct, maxPct, side)}>
            <rect x={86} y={80} width={28} height={36} rx={9} />
            <circle cx={100} cy={54} r={36} />
          </g>
        </g>
        <ZoneNumber cx={100} cy={54} value={totals.head} />
        <ZoneNumber cx={100} cy={212} value={totals.body} />
        <ZoneNumber cx={100} cy={384} value={totals.legs} />
      </svg>

      <ul className="w-full max-w-[220px] text-xs">
        {[
          { name: "Head", count: totals.head, pct: headPct },
          { name: "Body", count: totals.body, pct: bodyPct },
          { name: "Legs", count: totals.legs, pct: legsPct },
        ].map((row) => (
          <li
            key={row.name}
            className="flex items-baseline justify-between border-b border-foreground/[0.06] py-1.5 last:border-b-0"
          >
            <span className="font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
              {row.name}
            </span>
            <span className="font-mono tabular text-foreground">
              {formatNumber(row.count)}
              <span className="ml-2 text-[10px] text-foreground-subtle">
                {totals.total > 0 ? `${Math.round(row.pct * 100)}%` : "—"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Two silhouettes side-by-side: where the fighter lands strikes (gold) and
 * where opponents land strikes on them (red). Pure SVG, no client JS.
 */
export function StrikingHeatmap({ boutRounds }: StrikingHeatmapProps) {
  if (boutRounds.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          Detailed strike-location data not available for this fighter.
        </p>
      </div>
    );
  }

  const landed = aggregate(boutRounds, "landed");
  const absorbed = aggregate(boutRounds, "absorbed");

  if (landed.total === 0 && absorbed.total === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          No head/body/legs breakdown recorded in this fighter&rsquo;s bout
          round stats.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("grid grid-cols-2 gap-6 sm:gap-10")}>
      <Silhouette title="Strikes landed" totals={landed} side="landed" />
      <Silhouette title="Strikes absorbed" totals={absorbed} side="absorbed" />
    </div>
  );
}
