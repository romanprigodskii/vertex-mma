import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  type AttributeKey,
  type FighterAttributes,
} from "@/lib/fighter-attributes";
import { cn } from "@/lib/utils";

interface RadarChartProps {
  attributes: FighterAttributes;
  size?: number;
  className?: string;
}

const RING_PERCENTS = [20, 40, 60, 80, 100] as const;

function angleFor(i: number): number {
  // 6 axes, top first, going clockwise.
  return -Math.PI / 2 + (i * Math.PI) / 3;
}

function pointAt(
  cx: number,
  cy: number,
  angle: number,
  distance: number,
): [number, number] {
  return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
}

function polygonString(points: ReadonlyArray<[number, number]>): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function textAnchorFor(angle: number): "start" | "middle" | "end" {
  // Wraps to (-π, π]
  const a = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (Math.abs(Math.cos(a)) < 0.15) return "middle"; // very near top/bottom
  return Math.cos(a) > 0 ? "start" : "end";
}

function baselineFor(angle: number): "alphabetic" | "central" | "hanging" {
  const a = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (a < -Math.PI / 3) return "alphabetic"; // upper half (sits above the point)
  if (a > Math.PI / 3) return "hanging"; // lower half (hangs below the point)
  return "central";
}

/** Pure-SVG hex radar. No JS, no interaction — server-renderable. */
export function RadarChart({
  attributes,
  size = 380,
  className,
}: RadarChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size / 2 - 70; // leave room for value + label rings

  // Grid hexagons (5 concentric)
  const gridPolys = RING_PERCENTS.map((p) => {
    const pts = ATTRIBUTE_KEYS.map((_, i) =>
      pointAt(cx, cy, angleFor(i), (outerRadius * p) / 100),
    );
    return polygonString(pts);
  });

  // Spokes from center to outer ring
  const spokes = ATTRIBUTE_KEYS.map((_, i) => {
    const [x, y] = pointAt(cx, cy, angleFor(i), outerRadius);
    return { x1: cx, y1: cy, x2: x, y2: y };
  });

  // Data polygon
  const dataPoints = ATTRIBUTE_KEYS.map((k, i) =>
    pointAt(cx, cy, angleFor(i), (outerRadius * attributes[k]) / 100),
  );

  // Values sit just outside the outer ring; labels sit further out. Putting
  // numbers closer to the chart (and labels in a second ring) keeps them
  // from colliding even on long words like "GRAPPLING" — which the previous
  // tight stacking did overlap with the value beneath.
  const valueOffset = 16;
  const labelOffset = 38;
  const labels = ATTRIBUTE_KEYS.map((k, i) => {
    const a = angleFor(i);
    const [vx, vy] = pointAt(cx, cy, a, outerRadius + valueOffset);
    const [lx, ly] = pointAt(cx, cy, a, outerRadius + labelOffset);
    return {
      key: k as AttributeKey,
      label: ATTRIBUTE_LABELS[k],
      value: attributes[k],
      x: lx,
      y: ly,
      vx,
      vy,
      anchor: textAnchorFor(a),
      baseline: baselineFor(a),
    };
  });

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={cn("h-auto w-full max-w-[380px]", className)}
      role="img"
      aria-label="Fighter attribute radar"
    >
      {/* Concentric hex grid */}
      {gridPolys.map((poly, idx) => (
        <polygon
          key={`grid-${idx}`}
          points={poly}
          fill="none"
          stroke="oklch(0.45 0.01 240)"
          strokeWidth={idx === gridPolys.length - 1 ? 1 : 0.5}
          strokeOpacity={0.35}
        />
      ))}

      {/* Spokes */}
      {spokes.map((s, i) => (
        <line
          key={`spoke-${i}`}
          {...s}
          stroke="oklch(0.45 0.01 240)"
          strokeOpacity={0.25}
          strokeWidth={0.5}
        />
      ))}

      {/* Data polygon */}
      <polygon
        points={polygonString(dataPoints)}
        fill="oklch(0.78 0.15 70 / 0.35)"
        stroke="oklch(0.78 0.15 70)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />

      {/* Data point dots */}
      {dataPoints.map(([x, y], i) => (
        <circle
          key={`pt-${i}`}
          cx={x}
          cy={y}
          r={2.5}
          fill="oklch(0.78 0.15 70)"
        />
      ))}

      {/* Labels */}
      {labels.map((l) => (
        <g key={l.key}>
          <text
            x={l.x}
            y={l.y}
            fill="oklch(0.65 0.01 240)"
            textAnchor={l.anchor}
            dominantBaseline={l.baseline}
            className="font-sans"
            style={{
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            {l.label}
          </text>
          <text
            x={l.vx}
            y={l.vy}
            fill="oklch(0.98 0 0)"
            textAnchor={l.anchor}
            dominantBaseline={l.baseline}
            className="font-display"
            style={{ fontSize: 16, letterSpacing: "0.04em" }}
          >
            {l.value}
          </text>
        </g>
      ))}
    </svg>
  );
}
