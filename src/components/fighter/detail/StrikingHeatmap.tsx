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

function zoneFill(
  pct: number,
  side: "landed" | "absorbed",
): string {
  // Tint scales with relative share within the silhouette. Landed → gold ramp,
  // absorbed → muted-red ramp.
  if (pct === 0)
    return side === "landed"
      ? "oklch(0.20 0.02 240 / 0.9)"
      : "oklch(0.20 0.02 240 / 0.9)";
  if (side === "landed") {
    if (pct < 0.15) return "oklch(0.40 0.04 70 / 0.6)";
    if (pct < 0.30) return "oklch(0.55 0.10 70 / 0.7)";
    if (pct < 0.50) return "oklch(0.68 0.14 70 / 0.85)";
    return "oklch(0.78 0.15 70)"; // gold full
  }
  if (pct < 0.15) return "oklch(0.32 0.04 27 / 0.55)";
  if (pct < 0.30) return "oklch(0.40 0.10 27 / 0.7)";
  if (pct < 0.50) return "oklch(0.48 0.14 27 / 0.85)";
  return "oklch(0.55 0.18 27)"; // muted-red full
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

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        {title}
      </p>
      <svg
        viewBox="0 0 200 400"
        className="h-auto w-full max-w-[200px]"
        role="img"
        aria-label={`${title} per-zone heatmap`}
      >
        {/* Head — circle. */}
        <circle
          cx={100}
          cy={60}
          r={36}
          fill={zoneFill(headPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Body — torso rect (rounded). */}
        <rect
          x={50}
          y={108}
          width={100}
          height={150}
          rx={18}
          fill={zoneFill(bodyPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Shoulders accent so the torso doesn't read as a floating box. */}
        <path
          d="M50 124 Q40 116 30 110 L36 120 Q44 124 50 130 Z M150 124 Q160 116 170 110 L164 120 Q156 124 150 130 Z"
          fill={zoneFill(bodyPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Legs — two long rounded rectangles. */}
        <rect
          x={56}
          y={264}
          width={36}
          height={120}
          rx={12}
          fill={zoneFill(legsPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        <rect
          x={108}
          y={264}
          width={36}
          height={120}
          rx={12}
          fill={zoneFill(legsPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Zone labels in-SVG so they stay aligned at small sizes. */}
        <text
          x={100}
          y={64}
          textAnchor="middle"
          dominantBaseline="central"
          fill="oklch(0.98 0 0)"
          style={{ fontSize: 9, letterSpacing: "0.16em" }}
        >
          HEAD
        </text>
        <text
          x={100}
          y={188}
          textAnchor="middle"
          dominantBaseline="central"
          fill="oklch(0.98 0 0)"
          style={{ fontSize: 9, letterSpacing: "0.16em" }}
        >
          BODY
        </text>
        <text
          x={100}
          y={328}
          textAnchor="middle"
          dominantBaseline="central"
          fill="oklch(0.98 0 0)"
          style={{ fontSize: 9, letterSpacing: "0.16em" }}
        >
          LEGS
        </text>
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
 * Two silhouettes side-by-side: where the fighter lands strikes (gold ramp)
 * and where opponents land strikes on them (red ramp). Pure SVG, no client JS.
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
