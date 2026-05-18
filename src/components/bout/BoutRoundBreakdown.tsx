import type { BoutDetail, RoundPair } from "@/lib/bout-detail";
import { groupRoundsByNumber } from "@/lib/bout-detail";

import { BoutStatBlock } from "./BoutStatBlock";

interface BoutRoundBreakdownProps {
  bout: BoutDetail;
}

export function BoutRoundBreakdown({ bout }: BoutRoundBreakdownProps) {
  const groups = groupRoundsByNumber(
    bout.rounds,
    bout.fighter_a.id,
    bout.fighter_b.id,
  );

  if (groups.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          No round-by-round data available for this bout.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <RoundSection
          key={g.round}
          group={g}
          fighterAName={bout.fighter_a.name_en}
          fighterBName={bout.fighter_b.name_en}
          isFinishingRound={bout.round_finished === g.round}
          roundFinishedTimeSeconds={
            bout.round_finished === g.round ? bout.time_finished_seconds : null
          }
        />
      ))}
    </div>
  );
}

function RoundSection({
  group,
  fighterAName,
  fighterBName,
  isFinishingRound,
  roundFinishedTimeSeconds,
}: {
  group: RoundPair;
  fighterAName: string;
  fighterBName: string;
  isFinishingRound: boolean;
  roundFinishedTimeSeconds: number | null;
}) {
  const finishLabel =
    isFinishingRound && roundFinishedTimeSeconds != null
      ? `Finish · ${Math.floor(roundFinishedTimeSeconds / 60)}:${(
          roundFinishedTimeSeconds % 60
        )
          .toString()
          .padStart(2, "0")}`
      : null;
  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h3 className="font-sans text-xs uppercase tracking-widest text-foreground">
          Round {group.round}
        </h3>
        {finishLabel ? (
          <span className="font-mono tabular text-[11px] text-streak-win">
            {finishLabel}
          </span>
        ) : null}
      </header>
      <div className="grid grid-cols-[1fr_auto_1fr] items-baseline gap-3 px-4 pb-2">
        <p className="text-right font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {fighterAName}
        </p>
        <span />
        <p className="text-left font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {fighterBName}
        </p>
      </div>
      <BoutStatBlock a={group.a} b={group.b} />
    </section>
  );
}
