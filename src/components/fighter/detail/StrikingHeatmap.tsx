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

/** Dark chip with the strike count — readable on any zone colour. */
function NumberChip({
  cx,
  cy,
  value,
}: {
  cx: number;
  cy: number;
  value: number;
}) {
  const label = formatNumber(value);
  const w = Math.max(38, 14 + label.length * 9);
  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <rect
        x={-w / 2}
        y={-12}
        width={w}
        height={24}
        rx={6}
        fill="oklch(0.14 0.01 240 / 0.94)"
        stroke="oklch(0.5 0.015 250 / 0.45)"
        strokeWidth={0.75}
      />
      <text
        x={0}
        y={1}
        textAnchor="middle"
        dominantBaseline="central"
        fill="oklch(0.99 0 0)"
        style={{ fontSize: 14, fontWeight: 700 }}
      >
        {label}
      </text>
    </g>
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
        {/* Three colored zones meeting at clean horizontal boundaries —
            head (with a tapered neck) flows into shoulders at y=110, the
            torso ends with a slight crotch dip where the legs begin at
            y=314. No strokes, so adjacent zones read as a continuous
            body instead of stacked primitives. */}
        <g fill={zoneFill(legsPct, maxPct, side)}>
          <path d="M 70 314 L 96 314 L 92 442 Q 92 454 81 454 Q 70 454 70 442 Z" />
          <path d="M 104 314 L 130 314 L 130 442 Q 130 454 119 454 Q 108 454 108 442 Z" />
        </g>
        <path
          d="M 70 110 C 55 112 47 125 47 147 C 51 210 64 270 73 300 L 72 314 C 82 316 92 316 100 316 C 108 316 118 316 128 314 L 127 300 C 136 270 149 210 153 147 C 153 125 145 112 130 110 Z"
          fill={zoneFill(bodyPct, maxPct, side)}
        />
        <g fill={zoneFill(headPct, maxPct, side)}>
          <path d="M 90 80 C 85 90 75 100 70 110 L 130 110 C 125 100 115 90 110 80 Z" />
          <circle cx={100} cy={50} r={32} />
        </g>
        <NumberChip cx={100} cy={50} value={totals.head} />
        <NumberChip cx={100} cy={210} value={totals.body} />
        <NumberChip cx={100} cy={385} value={totals.legs} />
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
