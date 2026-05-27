import { useTranslations } from "next-intl";

import {
  StatCompareRow,
  StatTextRow,
} from "@/components/compare/StatCompareRow";
import type { FighterDetail } from "@/lib/fighter-detail";

const STANCE_KEY: Record<string, string> = {
  orthodox: "stanceOrthodox",
  southpaw: "stanceSouthpaw",
  switch: "stanceSwitch",
  sideways: "stanceUnknownLabel",
  unknown: "stanceUnknownLabel",
};

const STATUS_KEY: Record<string, string> = {
  active: "statusActive",
  retired: "statusRetired",
  inactive: "statusInactive",
  suspended: "statusInactive",
};

function ageOf(dob: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

export function TaleOfTheTape({
  a,
  b,
}: {
  a: FighterDetail;
  b: FighterDetail;
}) {
  const t = useTranslations("compare");
  const tCatalog = useTranslations("catalog");

  function stanceLabel(stance: string | null): string | null {
    if (!stance) return null;
    const key = STANCE_KEY[stance];
    if (key) return tCatalog(key as "stanceOrthodox");
    return stance;
  }

  function streakLabel(
    f: FighterDetail,
  ): { value: string; note: string | null } {
    if (!f.current_streak_type || f.current_streak_count === 0) {
      return { value: "—", note: null };
    }
    const statusKey = f.status ? STATUS_KEY[f.status] : null;
    return {
      value: `${f.current_streak_type}${f.current_streak_count}`,
      note: statusKey ? tCatalog(statusKey as "statusActive") : null,
    };
  }

  const ageA = ageOf(a.dob);
  const ageB = ageOf(b.dob);
  const stanceA = stanceLabel(a.stance);
  const stanceB = stanceLabel(b.stance);
  const streakA = streakLabel(a);
  const streakB = streakLabel(b);

  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label={t("row_height")}
        valueA={a.height_cm}
        valueB={b.height_cm}
        format="integer"
        unit=" cm"
        higherIsBetter
      />
      <StatCompareRow
        label={t("row_reach")}
        valueA={a.reach_cm}
        valueB={b.reach_cm}
        format="integer"
        unit=" cm"
        higherIsBetter
      />
      <StatTextRow
        label={t("row_stance")}
        valueA={stanceA}
        valueB={stanceB}
      />
      <StatCompareRow
        label={t("row_age")}
        valueA={ageA}
        valueB={ageB}
        format="integer"
      />
      <StatCompareRow
        label={t("row_ufcBouts")}
        valueA={a.ufc_total}
        valueB={b.ufc_total}
        format="integer"
        higherIsBetter
      />
      <StatCompareRow
        label={t("row_careerWins")}
        valueA={a.wins_total}
        valueB={b.wins_total}
        format="integer"
        higherIsBetter
      />
      <StatTextRow
        label={t("row_currentStreak")}
        valueA={streakA.value}
        valueB={streakB.value}
        noteA={streakA.note}
        noteB={streakB.note}
      />
    </div>
  );
}
