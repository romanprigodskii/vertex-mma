import type {
  BoutDetailFighter,
  FighterPositionMap,
} from "@/lib/bout-detail";

interface BoutPositionBreakdownProps {
  fighterA: BoutDetailFighter;
  fighterB: BoutDetailFighter;
  mapA: FighterPositionMap;
  mapB: FighterPositionMap;
}

export function BoutPositionBreakdown({
  fighterA,
  fighterB,
  mapA,
  mapB,
}: BoutPositionBreakdownProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <FighterPositionBar name={fighterA.name_en} map={mapA} />
      <FighterPositionBar name={fighterB.name_en} map={mapB} />
    </div>
  );
}

function FighterPositionBar({
  name,
  map,
}: {
  name: string;
  map: FighterPositionMap;
}) {
  const total = map.distance + map.clinch + map.ground;
  if (total === 0) {
    return (
      <article>
        <p className="mb-1.5 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {name}
        </p>
        <p className="font-mono text-xs text-foreground-subtle">
          No significant strikes recorded
        </p>
      </article>
    );
  }
  const pct = (n: number) => (n / total) * 100;
  // Floor non-zero segments at 4% so tiny counts stay visible.
  const widthOf = (n: number) => (n > 0 ? Math.max(4, pct(n)) : 0);

  return (
    <article>
      <p className="mb-1.5 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
        {name}
      </p>
      <div className="flex h-7 w-full overflow-hidden rounded-sm border border-foreground/10">
        {map.distance > 0 ? (
          <div
            className="flex items-center justify-center bg-primary font-mono text-[10px] tabular text-background-base"
            style={{ width: `${widthOf(map.distance)}%` }}
            title={`Distance: ${map.distance} (${pct(map.distance).toFixed(0)}%)`}
          >
            {pct(map.distance) >= 12 ? map.distance : ""}
          </div>
        ) : null}
        {map.clinch > 0 ? (
          <div
            className="flex items-center justify-center bg-foreground/40 font-mono text-[10px] tabular text-background-base"
            style={{ width: `${widthOf(map.clinch)}%` }}
            title={`Clinch: ${map.clinch} (${pct(map.clinch).toFixed(0)}%)`}
          >
            {pct(map.clinch) >= 12 ? map.clinch : ""}
          </div>
        ) : null}
        {map.ground > 0 ? (
          <div
            className="flex items-center justify-center bg-streak-loss/60 font-mono text-[10px] tabular text-background-base"
            style={{ width: `${widthOf(map.ground)}%` }}
            title={`Ground: ${map.ground} (${pct(map.ground).toFixed(0)}%)`}
          >
            {pct(map.ground) >= 12 ? map.ground : ""}
          </div>
        ) : null}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] tabular">
        <div>
          <dt className="text-[9px] uppercase tracking-widest text-foreground-subtle">
            Distance
          </dt>
          <dd className="text-foreground">
            {map.distance} ({pct(map.distance).toFixed(0)}%)
          </dd>
        </div>
        <div>
          <dt className="text-[9px] uppercase tracking-widest text-foreground-subtle">
            Clinch
          </dt>
          <dd className="text-foreground">
            {map.clinch} ({pct(map.clinch).toFixed(0)}%)
          </dd>
        </div>
        <div>
          <dt className="text-[9px] uppercase tracking-widest text-foreground-subtle">
            Ground
          </dt>
          <dd className="text-foreground">
            {map.ground} ({pct(map.ground).toFixed(0)}%)
          </dd>
        </div>
      </dl>
    </article>
  );
}
