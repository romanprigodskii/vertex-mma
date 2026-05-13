import {
  StatCompareRow,
  StatTextRow,
} from "@/components/compare/StatCompareRow";
import type { FighterDetail } from "@/lib/fighter-detail";

const STANCE_LABEL: Record<string, string> = {
  orthodox: "Orthodox",
  southpaw: "Southpaw",
  switch: "Switch",
  sideways: "Sideways",
  unknown: "Unknown",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  retired: "Retired",
  inactive: "Inactive",
  suspended: "Suspended",
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

function streakLabel(f: FighterDetail): { value: string; note: string | null } {
  if (!f.current_streak_type || f.current_streak_count === 0) {
    return { value: "—", note: null };
  }
  return {
    value: `${f.current_streak_type}${f.current_streak_count}`,
    note: f.status ? STATUS_LABEL[f.status] ?? null : null,
  };
}

export function TaleOfTheTape({
  a,
  b,
}: {
  a: FighterDetail;
  b: FighterDetail;
}) {
  const ageA = ageOf(a.dob);
  const ageB = ageOf(b.dob);
  const stanceA = a.stance ? STANCE_LABEL[a.stance] ?? a.stance : null;
  const stanceB = b.stance ? STANCE_LABEL[b.stance] ?? b.stance : null;
  const streakA = streakLabel(a);
  const streakB = streakLabel(b);

  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label="Height"
        valueA={a.height_cm}
        valueB={b.height_cm}
        format="integer"
        unit=" cm"
        higherIsBetter
      />
      <StatCompareRow
        label="Reach"
        valueA={a.reach_cm}
        valueB={b.reach_cm}
        format="integer"
        unit=" cm"
        higherIsBetter
      />
      <StatTextRow
        label="Stance"
        valueA={stanceA}
        valueB={stanceB}
      />
      <StatCompareRow
        label="Age"
        valueA={ageA}
        valueB={ageB}
        format="integer"
      />
      <StatCompareRow
        label="UFC bouts"
        valueA={a.ufc_total}
        valueB={b.ufc_total}
        format="integer"
        higherIsBetter
      />
      <StatCompareRow
        label="Career wins"
        valueA={a.wins_total}
        valueB={b.wins_total}
        format="integer"
        higherIsBetter
      />
      <StatTextRow
        label="Current streak"
        valueA={streakA.value}
        valueB={streakB.value}
        noteA={streakA.note}
        noteB={streakB.note}
      />
    </div>
  );
}
