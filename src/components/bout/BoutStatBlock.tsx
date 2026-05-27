import { useTranslations } from "next-intl";

import type { BoutRoundStatsRow } from "@/lib/bout-detail";
import { StatRow, formatStrike, formatTakedowns, formatTime } from "./StatRow";

interface BoutStatBlockProps {
  a: BoutRoundStatsRow | null;
  b: BoutRoundStatsRow | null;
}

function pick<K extends keyof BoutRoundStatsRow>(
  row: BoutRoundStatsRow | null,
  key: K,
): number {
  if (!row) return 0;
  const v = row[key];
  return typeof v === "number" ? v : 0;
}

function gtMark(av: number, bv: number): { a: boolean; b: boolean } {
  if (av === bv) return { a: false, b: false };
  return { a: av > bv, b: bv > av };
}

export function BoutStatBlock({ a, b }: BoutStatBlockProps) {
  const t = useTranslations("bout");
  const sigA = pick(a, "sig_str_landed");
  const sigB = pick(b, "sig_str_landed");
  const sigAttA = pick(a, "sig_str_attempted");
  const sigAttB = pick(b, "sig_str_attempted");
  const sigMark = gtMark(sigA, sigB);

  const headA = pick(a, "sig_str_head_landed");
  const headB = pick(b, "sig_str_head_landed");
  const headAttA = pick(a, "sig_str_head_attempted");
  const headAttB = pick(b, "sig_str_head_attempted");
  const headMark = gtMark(headA, headB);

  const bodyA = pick(a, "sig_str_body_landed");
  const bodyB = pick(b, "sig_str_body_landed");
  const bodyAttA = pick(a, "sig_str_body_attempted");
  const bodyAttB = pick(b, "sig_str_body_attempted");
  const bodyMark = gtMark(bodyA, bodyB);

  const legsA = pick(a, "sig_str_legs_landed");
  const legsB = pick(b, "sig_str_legs_landed");
  const legsAttA = pick(a, "sig_str_legs_attempted");
  const legsAttB = pick(b, "sig_str_legs_attempted");
  const legsMark = gtMark(legsA, legsB);

  const distA = pick(a, "sig_str_distance_landed");
  const distB = pick(b, "sig_str_distance_landed");
  const distMark = gtMark(distA, distB);

  const clinA = pick(a, "sig_str_clinch_landed");
  const clinB = pick(b, "sig_str_clinch_landed");
  const clinMark = gtMark(clinA, clinB);

  const grndA = pick(a, "sig_str_ground_landed");
  const grndB = pick(b, "sig_str_ground_landed");
  const grndMark = gtMark(grndA, grndB);

  const totA = pick(a, "total_str_landed");
  const totB = pick(b, "total_str_landed");
  const totAttA = pick(a, "total_str_attempted");
  const totAttB = pick(b, "total_str_attempted");
  const totMark = gtMark(totA, totB);

  const tdA = pick(a, "takedowns_landed");
  const tdB = pick(b, "takedowns_landed");
  const tdAttA = pick(a, "takedowns_attempted");
  const tdAttB = pick(b, "takedowns_attempted");
  const tdMark = gtMark(tdA, tdB);

  const saA = pick(a, "sub_attempts");
  const saB = pick(b, "sub_attempts");
  const saMark = gtMark(saA, saB);

  const ctA = pick(a, "control_time_seconds");
  const ctB = pick(b, "control_time_seconds");
  const ctMark = gtMark(ctA, ctB);

  const revA = pick(a, "reversals");
  const revB = pick(b, "reversals");
  const showReversals = revA > 0 || revB > 0;
  const revMark = gtMark(revA, revB);

  const kdA = pick(a, "knockdowns");
  const kdB = pick(b, "knockdowns");
  const showKnockdowns = kdA > 0 || kdB > 0;
  const kdMark = gtMark(kdA, kdB);

  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3">
      <StatRow
        label={t("stat_sigStrikes")}
        valueA={formatStrike(sigA, sigAttA)}
        valueB={formatStrike(sigB, sigAttB)}
        highlightA={sigMark.a}
        highlightB={sigMark.b}
      />
      <StatRow
        label={t("head")}
        valueA={formatStrike(headA, headAttA)}
        valueB={formatStrike(headB, headAttB)}
        highlightA={headMark.a}
        highlightB={headMark.b}
      />
      <StatRow
        label={t("body")}
        valueA={formatStrike(bodyA, bodyAttA)}
        valueB={formatStrike(bodyB, bodyAttB)}
        highlightA={bodyMark.a}
        highlightB={bodyMark.b}
      />
      <StatRow
        label={t("legs")}
        valueA={formatStrike(legsA, legsAttA)}
        valueB={formatStrike(legsB, legsAttB)}
        highlightA={legsMark.a}
        highlightB={legsMark.b}
      />
      <StatRow
        label={t("distance")}
        valueA={distA}
        valueB={distB}
        highlightA={distMark.a}
        highlightB={distMark.b}
      />
      <StatRow
        label={t("clinch")}
        valueA={clinA}
        valueB={clinB}
        highlightA={clinMark.a}
        highlightB={clinMark.b}
      />
      <StatRow
        label={t("ground")}
        valueA={grndA}
        valueB={grndB}
        highlightA={grndMark.a}
        highlightB={grndMark.b}
      />
      <StatRow
        label={t("stat_totalStrikes")}
        valueA={formatStrike(totA, totAttA)}
        valueB={formatStrike(totB, totAttB)}
        highlightA={totMark.a}
        highlightB={totMark.b}
      />
      <StatRow
        label={t("stat_takedowns")}
        valueA={formatTakedowns(tdA, tdAttA)}
        valueB={formatTakedowns(tdB, tdAttB)}
        highlightA={tdMark.a}
        highlightB={tdMark.b}
      />
      <StatRow
        label={t("stat_subAttempts")}
        valueA={saA}
        valueB={saB}
        highlightA={saMark.a}
        highlightB={saMark.b}
      />
      <StatRow
        label={t("stat_controlTime")}
        valueA={formatTime(ctA)}
        valueB={formatTime(ctB)}
        highlightA={ctMark.a}
        highlightB={ctMark.b}
      />
      {showReversals ? (
        <StatRow
          label={t("stat_reversals")}
          valueA={revA}
          valueB={revB}
          highlightA={revMark.a}
          highlightB={revMark.b}
        />
      ) : null}
      {showKnockdowns ? (
        <StatRow
          label={t("stat_knockdowns")}
          valueA={kdA}
          valueB={kdB}
          highlightA={kdMark.a}
          highlightB={kdMark.b}
        />
      ) : null}
    </div>
  );
}
