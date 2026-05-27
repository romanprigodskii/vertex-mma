import { getTranslations } from "next-intl/server";

import { Container } from "@/components/layout/container";
import type { BoutDetail } from "@/lib/bout-detail";
import {
  computeJudgeAgreement,
  isDecisionMethod,
} from "@/lib/bout-detail";

interface BoutDecisionBannerProps {
  bout: BoutDetail;
}

// Pulls the localized decision label from `bout.*` — keys match the
// enum value, e.g. `decision_unanimous` → "Unanimous Decision" / "Единогласное решение".
const METHOD_LABEL_KEY: Record<string, string> = {
  decision_unanimous: "unanimousDecision",
  decision_split: "splitDecision",
  decision_majority: "majorityDecision",
};

export async function BoutDecisionBanner({ bout }: BoutDecisionBannerProps) {
  if (!isDecisionMethod(bout.method)) return null;
  const t = await getTranslations("bout");
  const key = bout.method ? METHOD_LABEL_KEY[bout.method] : null;
  const label = key ? t(key) : null;
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
      subline = `${a.judgesForA}-${a.judgesForB}${a.judgesDraw > 0 ? `-${a.judgesDraw} ${t("draw").toLowerCase()}` : ""}`;
    }
  }

  return (
    <section
      aria-label={t("decisionSummary")}
      className="border-t border-foreground/[0.06] bg-background-elevated/20"
    >
      <Container size="xl" className="py-5 text-center">
        <p className="font-display text-base uppercase tracking-widest text-primary">
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
