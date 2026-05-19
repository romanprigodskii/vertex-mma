import Link from "next/link";

import type { SimulationDetail, SimulationFighter } from "@/lib/simulations";
import { cn } from "@/lib/utils";

// Static bar colour map — Tailwind purges unknown `bg-${x}` so this needs
// to be enumerated.
const BAR_COLOR_CLASS: Record<"primary" | "win" | "loss" | "neutral", string> = {
  primary: "bg-primary",
  win: "bg-streak-win",
  loss: "bg-streak-loss",
  neutral: "bg-foreground/40",
};

export function SimulationResultView({ sim }: { sim: SimulationDetail }) {
  const { result } = sim;
  const winnerIsA = result.winProbabilityA >= result.winProbabilityB;

  // SimulationResult.methodDistribution is Record<string, number>; we know
  // the keys we wrote in simulate(), but read defensively.
  const ko = result.methodDistribution.ko_tko ?? 0;
  const sub = result.methodDistribution.submission ?? 0;
  const dec = result.methodDistribution.decision ?? 0;
  const r1 = result.roundDistribution.r1 ?? 0;
  const r2 = result.roundDistribution.r2 ?? 0;
  const r3 = result.roundDistribution.r3 ?? 0;
  const roundDec = result.roundDistribution.decision ?? dec;

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
        <FighterCol
          fighter={sim.fighter_a}
          prob={result.winProbabilityA}
          winner={winnerIsA}
          align="left"
        />
        <p className="text-center font-display text-2xl uppercase tracking-widest text-foreground-subtle">
          vs
        </p>
        <FighterCol
          fighter={sim.fighter_b}
          prob={result.winProbabilityB}
          winner={!winnerIsA}
          align="right"
        />
      </div>

      <section className="rounded-md border border-primary/30 bg-primary/[0.05] p-6 text-center">
        <p className="mb-2 font-sans text-[11px] uppercase tracking-widest text-primary">
          Predicted outcome
        </p>
        <p className="font-display text-2xl uppercase tracking-tight text-foreground">
          {result.mostLikelyScenario}
        </p>
      </section>

      <section>
        <h3 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Method probability
        </h3>
        <div className="space-y-2">
          <DistroBar label="KO / TKO" value={ko} variant="primary" />
          <DistroBar label="Submission" value={sub} variant="loss" />
          <DistroBar label="Decision" value={dec} variant="neutral" />
        </div>
      </section>

      <section>
        <h3 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Round probability
        </h3>
        <div className="space-y-2">
          <DistroBar label="Round 1" value={r1} variant="primary" />
          <DistroBar label="Round 2" value={r2} variant="primary" />
          <DistroBar label="Round 3" value={r3} variant="primary" />
          <DistroBar
            label="Goes to decision"
            value={roundDec}
            variant="neutral"
          />
        </div>
      </section>

      {result.gameplanA || result.gameplanB ? (
        <section>
          <h3 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            Gameplans
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {result.gameplanA ? (
              <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {sim.fighter_a.name_en}
                </p>
                <p className="mt-2 whitespace-pre-line font-sans text-sm text-foreground">
                  {result.gameplanA}
                </p>
              </div>
            ) : null}
            {result.gameplanB ? (
              <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {sim.fighter_b.name_en}
                </p>
                <p className="mt-2 whitespace-pre-line font-sans text-sm text-foreground">
                  {result.gameplanB}
                </p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {result.keyFactors && result.keyFactors.length > 0 ? (
        <section>
          <h3 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            Key factors (A − B)
          </h3>
          <ul className="space-y-0">
            {result.keyFactors.map((f) => (
              <li
                key={f.label}
                className="flex items-baseline justify-between gap-3 border-b border-foreground/[0.06] py-2"
              >
                <span className="font-sans text-sm text-foreground">
                  {f.label}
                </span>
                <span
                  className={cn(
                    "font-mono text-sm tabular",
                    f.delta > 0
                      ? "text-streak-win"
                      : f.delta < 0
                        ? "text-streak-loss"
                        : "text-foreground-muted",
                  )}
                >
                  {f.delta > 0 ? "+" : ""}
                  {f.delta}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-center font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        Model: {result.modelVersion}
      </p>
    </div>
  );
}

function FighterCol({
  fighter,
  prob,
  winner,
  align,
}: {
  fighter: SimulationFighter;
  prob: number;
  winner: boolean;
  align: "left" | "right";
}) {
  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      className={cn(
        "flex flex-col gap-2",
        align === "right" ? "items-end text-right" : "items-start",
      )}
    >
      {fighter.photo_thumbnail_url || fighter.photo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fighter.photo_thumbnail_url ?? fighter.photo_url ?? undefined}
          alt={fighter.name_en}
          className="h-24 w-24 rounded-sm border border-foreground/15 object-cover sm:h-28 sm:w-28"
        />
      ) : (
        <div
          className="h-24 w-24 rounded-sm border border-foreground/15 bg-foreground/[0.05] sm:h-28 sm:w-28"
          aria-hidden
        />
      )}
      <p
        className={cn(
          "font-display text-xl uppercase tracking-tight",
          winner ? "text-streak-win" : "text-foreground",
        )}
      >
        {fighter.name_en}
      </p>
      <p
        className={cn(
          "font-display text-4xl tabular",
          winner ? "text-streak-win" : "text-foreground-muted",
        )}
      >
        {prob.toFixed(1)}%
      </p>
    </Link>
  );
}

function DistroBar({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: "primary" | "win" | "loss" | "neutral";
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-sans text-sm text-foreground">{label}</span>
        <span className="font-mono text-sm tabular text-foreground">
          {value.toFixed(1)}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-sm bg-foreground/[0.06]">
        <div
          className={cn("h-full", BAR_COLOR_CLASS[variant])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
