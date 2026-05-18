import type { BoutDetail } from "@/lib/bout-detail";
import { sumFighterRounds } from "@/lib/bout-detail";

import { BoutStatBlock } from "./BoutStatBlock";

interface BoutTotalsProps {
  bout: BoutDetail;
}

export function BoutTotals({ bout }: BoutTotalsProps) {
  if (bout.rounds.length === 0) return null;
  const a = sumFighterRounds(bout.rounds, bout.fighter_a.id);
  const b = sumFighterRounds(bout.rounds, bout.fighter_b.id);
  if (!a && !b) return null;

  return (
    <section>
      <div className="mb-2 grid grid-cols-[1fr_auto_1fr] items-baseline gap-3 px-4">
        <p className="text-right font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {bout.fighter_a.name_en}
        </p>
        <span />
        <p className="text-left font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {bout.fighter_b.name_en}
        </p>
      </div>
      <BoutStatBlock a={a} b={b} />
    </section>
  );
}
