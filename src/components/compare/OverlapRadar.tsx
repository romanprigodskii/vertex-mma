import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  type FighterAttributes,
} from "@/lib/fighter-attributes";
import { cn } from "@/lib/utils";

interface OverlapRadarProps {
  fighterA: { name: string; attributes: FighterAttributes };
  fighterB: { name: string; attributes: FighterAttributes };
  size?: number;
  className?: string;
}

const RING_PERCENTS = [20, 40, 60, 80, 100] as const;

const COLOR_A = "oklch(0.78 0.15 70)"; // gold (primary)
const COLOR_A_FILL = "oklch(0.78 0.15 70 / 0.30)";
const COLOR_B = "oklch(0.62 0.22 27)"; // red-accent
const COLOR_B_FILL = "oklch(0.62 0.22 27 / 0.30)";

function angleFor(i: number): number {
  return -Math.PI / 2 + (i * Math.PI) / 3;
}

function pointAt(cx: number, cy: number, angle: number, distance: number) {
  return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance] as const;
}

function polygonString(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function textAnchorFor(angle: number): "start" | "middle" | "end" {
  const a = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (Math.abs(Math.cos(a)) < 0.15) return "middle";
  return Math.cos(a) > 0 ? "start" : "end";
}

function baselineFor(angle: number): "alphabetic" | "central" | "hanging" {
  const a = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (a < -Math.PI / 3) return "alphabetic";
  if (a > Math.PI / 3) return "hanging";
  return "central";
}

export function OverlapRadar({
  fighterA,
  fighterB,
  size = 420,
  className,
}: OverlapRadarProps) {
  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size / 2 - 80;
  const viewBoxPad = 50;

  const gridPolys = RING_PERCENTS.map((p) => {
    const pts = ATTRIBUTE_KEYS.map((_, i) =>
      pointAt(cx, cy, angleFor(i), (outerRadius * p) / 100),
    );
    return polygonString(pts);
  });

  const spokes = ATTRIBUTE_KEYS.map((_, i) => {
    const [x, y] = pointAt(cx, cy, angleFor(i), outerRadius);
    return { x1: cx, y1: cy, x2: x, y2: y };
  });

  const polygonAPoints = ATTRIBUTE_KEYS.map((k, i) =>
    pointAt(cx, cy, angleFor(i), (outerRadius * fighterA.attributes[k]) / 100),
  );
  const polygonBPoints = ATTRIBUTE_KEYS.map((k, i) =>
    pointAt(cx, cy, angleFor(i), (outerRadius * fighterB.attributes[k]) / 100),
  );

  const labels = ATTRIBUTE_KEYS.map((k, i) => {
    const a = angleFor(i);
    const [lx, ly] = pointAt(cx, cy, a, outerRadius + 38);
    return {
      key: k,
      label: ATTRIBUTE_LABELS[k],
      x: lx,
      y: ly,
      anchor: textAnchorFor(a),
      baseline: baselineFor(a),
    };
  });

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1">
        <span className="flex items-center gap-2 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: COLOR_A }}
          />
          <span className="truncate text-foreground">{fighterA.name}</span>
        </span>
        <span className="flex items-center gap-2 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: COLOR_B }}
          />
          <span className="truncate text-foreground">{fighterB.name}</span>
        </span>
      </div>

      <svg
        viewBox={`${-viewBoxPad} 0 ${size + viewBoxPad * 2} ${size}`}
        preserveAspectRatio="xMidYMid meet"
        className={cn("h-auto w-full max-w-[460px]", className)}
        role="img"
        aria-label="Six-attribute radar comparison"
      >
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

        {spokes.map((s, i) => (
          <line
            key={`spoke-${i}`}
            {...s}
            stroke="oklch(0.45 0.01 240)"
            strokeOpacity={0.25}
            strokeWidth={0.5}
          />
        ))}

        {/* Polygon A (drawn first so B sits on top — both are translucent) */}
        <polygon
          points={polygonString(polygonAPoints)}
          fill={COLOR_A_FILL}
          stroke={COLOR_A}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {polygonAPoints.map(([x, y], i) => (
          <circle key={`a-pt-${i}`} cx={x} cy={y} r={2.5} fill={COLOR_A} />
        ))}

        {/* Polygon B */}
        <polygon
          points={polygonString(polygonBPoints)}
          fill={COLOR_B_FILL}
          stroke={COLOR_B}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {polygonBPoints.map(([x, y], i) => (
          <circle key={`b-pt-${i}`} cx={x} cy={y} r={2.5} fill={COLOR_B} />
        ))}

        {labels.map((l) => (
          <text
            key={l.key}
            x={l.x}
            y={l.y}
            fill="oklch(0.65 0.01 240)"
            textAnchor={l.anchor}
            dominantBaseline={l.baseline}
            className="font-sans"
            style={{
              fontSize: 10,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {l.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
