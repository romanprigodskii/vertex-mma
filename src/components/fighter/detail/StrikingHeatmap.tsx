import { getTranslations } from "next-intl/server";

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

interface SilhouetteLabels {
  head: string;
  body: string;
  legs: string;
  ariaLabel: string;
}

function Silhouette({
  title,
  totals,
  side,
  labels,
}: {
  title: string;
  totals: ZoneTotals;
  side: "landed" | "absorbed";
  labels: SilhouetteLabels;
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
        aria-label={labels.ariaLabel}
      >
        {/* Head — circle. */}
        <circle
          cx={100}
          cy={56}
          r={36}
          fill={zoneFill(headPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Body — single rounded path with slightly wider shoulders so the
            torso reads as a body, not a floating brick. No arms; we only
            have head/body/legs data, and detached arm shapes were
            visually noisy. */}
        <path
          d="M62 110
             Q50 116 50 134
             L50 252
             Q50 264 62 264
             L138 264
             Q150 264 150 252
             L150 134
             Q150 116 138 110
             Z"
          fill={zoneFill(bodyPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Legs — two long rounded rectangles. */}
        <rect
          x={60}
          y={268}
          width={36}
          height={120}
          rx={14}
          fill={zoneFill(legsPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        <rect
          x={104}
          y={268}
          width={36}
          height={120}
          rx={14}
          fill={zoneFill(legsPct, side)}
          stroke="oklch(0.30 0.01 240)"
          strokeWidth={1}
        />
        {/* Zone labels in-SVG so they stay aligned at small sizes. */}
        <text
          x={100}
          y={60}
          textAnchor="middle"
          dominantBaseline="central"
          fill="oklch(0.98 0 0)"
          style={{ fontSize: 9, letterSpacing: "0.16em" }}
        >
          {labels.head.toUpperCase()}
        </text>
        <text
          x={100}
          y={188}
          textAnchor="middle"
          dominantBaseline="central"
          fill="oklch(0.98 0 0)"
          style={{ fontSize: 9, letterSpacing: "0.16em" }}
        >
          {labels.body.toUpperCase()}
        </text>
        <text
          x={100}
          y={332}
          textAnchor="middle"
          dominantBaseline="central"
          fill="oklch(0.98 0 0)"
          style={{ fontSize: 9, letterSpacing: "0.16em" }}
        >
          {labels.legs.toUpperCase()}
        </text>
      </svg>

      <ul className="w-full max-w-[220px] text-xs">
        {[
          { name: labels.head, count: totals.head, pct: headPct },
          { name: labels.body, count: totals.body, pct: bodyPct },
          { name: labels.legs, count: totals.legs, pct: legsPct },
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
export async function StrikingHeatmap({ boutRounds }: StrikingHeatmapProps) {
  const tFighter = await getTranslations("fighter");
  const tBout = await getTranslations("bout");

  if (boutRounds.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          {tFighter("noStrikeData")}
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
          {tFighter("noZoneBreakdown")}
        </p>
      </div>
    );
  }

  const landedTitle = tFighter("strikesLanded");
  const absorbedTitle = tFighter("strikesAbsorbed");
  const zoneLabels = {
    head: tBout("head"),
    body: tBout("body"),
    legs: tBout("legs"),
  };

  return (
    <div className={cn("grid grid-cols-2 gap-6 sm:gap-10")}>
      <Silhouette
        title={landedTitle}
        totals={landed}
        side="landed"
        labels={{
          ...zoneLabels,
          ariaLabel: tFighter("heatmapAriaLabel", { title: landedTitle }),
        }}
      />
      <Silhouette
        title={absorbedTitle}
        totals={absorbed}
        side="absorbed"
        labels={{
          ...zoneLabels,
          ariaLabel: tFighter("heatmapAriaLabel", { title: absorbedTitle }),
        }}
      />
    </div>
  );
}
