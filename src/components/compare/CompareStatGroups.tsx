import { StatCompareRow } from "@/components/compare/StatCompareRow";
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  type FighterAttributes,
} from "@/lib/fighter-attributes";
import type { FighterDetail } from "@/lib/fighter-detail";

function finishRate(f: FighterDetail): number | null {
  const total = f.ufc_wins_ko + f.ufc_wins_sub + f.ufc_wins_dec;
  if (total === 0) return null;
  return (f.ufc_wins_ko + f.ufc_wins_sub) / total;
}

/**
 * Compact numeric companion to the OverlapRadar — same six attributes,
 * but as a table with leader arrows. Placed directly under the radar.
 */
export function AttributesTable({
  attributesA,
  attributesB,
}: {
  attributesA: FighterAttributes;
  attributesB: FighterAttributes;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      {ATTRIBUTE_KEYS.map((key) => (
        <StatCompareRow
          key={key}
          label={ATTRIBUTE_LABELS[key]}
          valueA={attributesA[key]}
          valueB={attributesB[key]}
          format="integer"
          higherIsBetter
        />
      ))}
    </div>
  );
}

export function StrikingCompare({ a, b }: { a: FighterDetail; b: FighterDetail }) {
  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label="Sig Str / min"
        valueA={a.slpm}
        valueB={b.slpm}
        format="number"
        decimals={2}
        higherIsBetter
      />
      <StatCompareRow
        label="Strike accuracy"
        valueA={a.str_acc}
        valueB={b.str_acc}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label="Strike defense"
        valueA={a.str_def}
        valueB={b.str_def}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label="Sig Str absorbed / min"
        valueA={a.sapm}
        valueB={b.sapm}
        format="number"
        decimals={2}
        // Lower is better — less damage taken per minute.
        higherIsBetter={false}
      />
    </div>
  );
}

export function GrapplingCompare({ a, b }: { a: FighterDetail; b: FighterDetail }) {
  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label="TD avg / 15min"
        valueA={a.td_avg}
        valueB={b.td_avg}
        format="number"
        decimals={2}
        higherIsBetter
      />
      <StatCompareRow
        label="TD accuracy"
        valueA={a.td_acc}
        valueB={b.td_acc}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label="TD defense"
        valueA={a.td_def}
        valueB={b.td_def}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label="Sub avg / 15min"
        valueA={a.sub_avg}
        valueB={b.sub_avg}
        format="number"
        decimals={2}
        higherIsBetter
      />
    </div>
  );
}

export function FinishingCompare({ a, b }: { a: FighterDetail; b: FighterDetail }) {
  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label="KO/TKO wins"
        valueA={a.ufc_wins_ko}
        valueB={b.ufc_wins_ko}
        format="integer"
        higherIsBetter
      />
      <StatCompareRow
        label="Submission wins"
        valueA={a.ufc_wins_sub}
        valueB={b.ufc_wins_sub}
        format="integer"
        higherIsBetter
      />
      <StatCompareRow
        label="Decision wins"
        valueA={a.ufc_wins_dec}
        valueB={b.ufc_wins_dec}
        format="integer"
      />
      <StatCompareRow
        label="Finish rate"
        valueA={finishRate(a)}
        valueB={finishRate(b)}
        format="percent"
        higherIsBetter
      />
    </div>
  );
}

