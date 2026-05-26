import { Crown } from "lucide-react";

import { classifyAndStyle } from "@/lib/vertex-tier";

interface ScoreShapeProps {
  /** 0-100 (or null for unranked/no-data). */
  score: number | null;
  /** "current" or "all_time" — drives tier classification mode. */
  scoreMode: "current" | "all_time";
  /** Pass through fighter context so classifyAndStyle picks the right tier. */
  fighter: {
    slug: string;
    vertexScore: number | null;
    vertexScoreAllTime: number | null;
    ufcBouts: number;
  };
  /** Aria label, e.g. "Current Vertex Score". */
  label: string;
}

const VIEWBOX = 200;
const STROKE = 4;
const PAD = 8;
const RADIUS = VIEWBOX / 2 - PAD;
const CENTER = VIEWBOX / 2;
const UNRANKED_STROKE = "oklch(0.5 0.02 240)";
const SUBLABEL: Record<"current" | "all_time", string> = {
  current: "CURRENT",
  all_time: "ALL-TIME",
};

function octagonPoints(): string {
  // 8 vertices on inscribed circle, rotated so flat sides are top/bottom
  // (points to left/right). offset = -π/2 + π/8 = -3π/8.
  const offset = -Math.PI * 3 / 8;
  const pts: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const angle = offset + (i * Math.PI) / 4;
    const x = CENTER + RADIUS * Math.cos(angle);
    const y = CENTER + RADIUS * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

const OCTAGON_POINTS = octagonPoints();

function displayScore(score: number | null): string {
  if (score == null) return "—";
  return String(Math.min(100, Math.max(0, Math.round(score))));
}

function ScoreShape({
  shape,
  score,
  scoreMode,
  fighter,
  label,
}: ScoreShapeProps & { shape: "octagon" | "circle" }) {
  const { tierStyle, championStyle, classification } = classifyAndStyle({
    slug: fighter.slug,
    vertexScore: fighter.vertexScore,
    vertexScoreAllTime: fighter.vertexScoreAllTime,
    ufcBouts: fighter.ufcBouts,
    scoreMode,
  });

  const isUnranked = classification.tier === "unranked" || score == null;
  const stroke = isUnranked ? UNRANKED_STROKE : tierStyle.scoreColor;
  const fill = isUnranked
    ? "transparent"
    : `color-mix(in oklch, ${tierStyle.scoreColor} 12%, transparent)`;
  const textColor = isUnranked ? UNRANKED_STROKE : tierStyle.scoreColor;
  const showCrown = championStyle.hasCrown && !isUnranked;
  const tooltip = isUnranked
    ? `Unranked · ${scoreMode === "all_time" ? "all-time" : "current"}`
    : `${tierStyle.label} tier · ${
        scoreMode === "all_time" ? "all-time" : "current"
      }`;

  return (
    <div
      className="relative w-[140px] sm:w-[200px]"
      title={tooltip}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        role="img"
        aria-label={label}
        className="block w-full h-auto"
      >
        {shape === "octagon" ? (
          <polygon
            points={OCTAGON_POINTS}
            fill={fill}
            stroke={stroke}
            strokeWidth={STROKE}
            strokeLinejoin="round"
          />
        ) : (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill={fill}
            stroke={stroke}
            strokeWidth={STROKE}
          />
        )}
        <text
          x={CENTER}
          y={CENTER + 4}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={textColor}
          fontSize={56}
          fontWeight={600}
          fontFamily="var(--font-sans)"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {displayScore(score)}
        </text>
        <text
          x={CENTER}
          y={CENTER + 38}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-foreground-muted, oklch(0.65 0.02 240))"
          fontSize={10}
          fontFamily="var(--font-mono)"
          letterSpacing="0.18em"
        >
          {SUBLABEL[scoreMode]}
        </text>
      </svg>
      {showCrown && championStyle.crownColor ? (
        <span
          aria-hidden
          style={{ color: championStyle.crownColor }}
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full border border-foreground/15 bg-background-base shadow-sm"
          title={championStyle.label}
        >
          <Crown className="h-6 w-6" />
        </span>
      ) : null}
    </div>
  );
}

export function OctagonScore(props: ScoreShapeProps) {
  return <ScoreShape {...props} shape="octagon" />;
}

export function CircleScore(props: ScoreShapeProps) {
  return <ScoreShape {...props} shape="circle" />;
}
