import { Container } from "@/components/layout/container";
import type { BoutDetail } from "@/lib/bout-detail";
import {
  computeJudgeAgreement,
  formatDecisionLabel,
  isDecisionMethod,
} from "@/lib/bout-detail";

interface BoutDecisionBannerProps {
  bout: BoutDetail;
}

export function BoutDecisionBanner({ bout }: BoutDecisionBannerProps) {
  if (!isDecisionMethod(bout.method)) return null;
  const label = formatDecisionLabel(bout.method);
  if (label == null) return null;

  let subline: string | null = null;
  if (bout.scorecards.length > 0) {
    const a = computeJudgeAgreement(bout.scorecards);
    const winnerIsA = bout.winner_id === bout.fighter_a.id;
    const winnerIsB = bout.winner_id === bout.fighter_b.id;
    const drawPart = a.judgesDraw > 0 ? `-${a.judgesDraw}` : "";
    if (winnerIsA) {
      subline = `${a.judgesForA}-${a.judgesForB}${drawPart} ${bout.fighter_a.name_en}`;
    } else if (winnerIsB) {
      subline = `${a.judgesForB}-${a.judgesForA}${drawPart} ${bout.fighter_b.name_en}`;
    } else {
      // Draw / no recorded winner — show raw counts.
      subline = `${a.judgesForA}-${a.judgesForB}${a.judgesDraw > 0 ? `-${a.judgesDraw} draw` : ""}`;
    }
  }

  return (
    <section
      aria-label="Decision summary"
      className="border-t border-foreground/[0.06] bg-background-elevated/20"
    >
      <Container size="xl" className="py-5 text-center">
        <p className="font-sans font-bold text-base uppercase tracking-widest text-primary">
          {label}
        </p>
        {subline ? (
          <p className="mt-1.5 font-sans text-[12px] uppercase tracking-widest text-foreground-muted">
            {subline}
          </p>
        ) : null}
      </Container>
    </section>
  );
}
