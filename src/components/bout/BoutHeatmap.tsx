import type {
  BoutDetailFighter,
  FighterStrikeMap,
} from "@/lib/bout-detail";
import { cn } from "@/lib/utils";

interface BoutHeatmapProps {
  fighterA: BoutDetailFighter;
  fighterB: BoutDetailFighter;
  mapA: FighterStrikeMap;
  mapB: FighterStrikeMap;
  /** Tailwind color class applied to the SVG silhouette via currentColor.
      Wave 32 uses red ("text-streak-loss") for landed and muted gray
      ("text-foreground-muted") for absorbed. */
  colorClass?: string;
}

export function BoutHeatmap({
  fighterA,
  fighterB,
  mapA,
  mapB,
  colorClass = "text-streak-loss",
}: BoutHeatmapProps) {
  const maxStrike = Math.max(
    mapA.head,
    mapA.body,
    mapA.legs,
    mapB.head,
    mapB.body,
    mapB.legs,
    1,
  );

  return (
    <div className="mx-auto grid max-w-2xl grid-cols-2 gap-4 sm:gap-8">
      <FighterSilhouette
        name={fighterA.name_en}
        map={mapA}
        max={maxStrike}
        colorClass={colorClass}
      />
      <FighterSilhouette
        name={fighterB.name_en}
        map={mapB}
        max={maxStrike}
        colorClass={colorClass}
      />
    </div>
  );
}

function FighterSilhouette({
  name,
  map,
  max,
  colorClass,
}: {
  name: string;
  map: FighterStrikeMap;
  max: number;
  colorClass: string;
}) {
  // Opacity ramp: zone with 0 strikes → 0.10 (barely visible outline),
  // zone with `max` strikes → 1.0. Min floor 0.10 keeps silhouette readable
  // even when fighter landed nothing in a zone.
  const opacityOf = (n: number) => 0.1 + (n / max) * 0.9;
  const headO = opacityOf(map.head);
  const bodyO = opacityOf(map.body);
  const legsO = opacityOf(map.legs);

  return (
    <article className="flex flex-col items-center gap-3">
      <p className="text-center font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
        {name}
      </p>
      <svg
        viewBox="0 0 80 200"
        className={cn("w-full max-w-[140px]", colorClass)}
        aria-hidden
      >
        <circle cx="40" cy="22" r="16" fill="currentColor" opacity={headO} />
        <path
          d="M 22 44 L 58 44 L 62 130 L 18 130 Z"
          fill="currentColor"
          opacity={bodyO}
        />
        <rect
          x="22"
          y="135"
          width="14"
          height="58"
          rx="2"
          fill="currentColor"
          opacity={legsO}
        />
        <rect
          x="44"
          y="135"
          width="14"
          height="58"
          rx="2"
          fill="currentColor"
          opacity={legsO}
        />
      </svg>
      <dl className="grid w-full max-w-[140px] grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs tabular">
        <dt className="text-foreground-subtle">Head</dt>
        <dd className="text-right tabular text-foreground">{map.head}</dd>
        <dt className="text-foreground-subtle">Body</dt>
        <dd className="text-right tabular text-foreground">{map.body}</dd>
        <dt className="text-foreground-subtle">Legs</dt>
        <dd className="text-right tabular text-foreground">{map.legs}</dd>
      </dl>
    </article>
  );
}
