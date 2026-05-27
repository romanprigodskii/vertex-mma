import { useTranslations } from "next-intl";

import { StatCompareRow } from "@/components/compare/StatCompareRow";
import {
  ATTRIBUTE_KEYS,
  type FighterAttributes,
} from "@/lib/fighter-attributes";
import type { FighterDetail } from "@/lib/fighter-detail";

function finishRate(f: FighterDetail): number | null {
  const total = f.ufc_wins_ko + f.ufc_wins_sub + f.ufc_wins_dec;
  if (total === 0) return null;
  return (f.ufc_wins_ko + f.ufc_wins_sub) / total;
}

export function AttributesTable({
  attributesA,
  attributesB,
}: {
  attributesA: FighterAttributes;
  attributesB: FighterAttributes;
}) {
  const t = useTranslations("compare");
  return (
    <div className="mx-auto max-w-3xl">
      {ATTRIBUTE_KEYS.map((key) => (
        <StatCompareRow
          key={key}
          label={t(`attr_${key}` as "attr_striking")}
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
  const t = useTranslations("compare");
  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label={t("stat_slpm")}
        valueA={a.slpm}
        valueB={b.slpm}
        format="number"
        decimals={2}
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_strikeAcc")}
        valueA={a.str_acc}
        valueB={b.str_acc}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_strikeDef")}
        valueA={a.str_def}
        valueB={b.str_def}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_sapm")}
        valueA={a.sapm}
        valueB={b.sapm}
        format="number"
        decimals={2}
        higherIsBetter={false}
      />
    </div>
  );
}

export function GrapplingCompare({ a, b }: { a: FighterDetail; b: FighterDetail }) {
  const t = useTranslations("compare");
  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label={t("stat_tdAvg")}
        valueA={a.td_avg}
        valueB={b.td_avg}
        format="number"
        decimals={2}
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_tdAcc")}
        valueA={a.td_acc}
        valueB={b.td_acc}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_tdDef")}
        valueA={a.td_def}
        valueB={b.td_def}
        format="percent"
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_subAvg")}
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
  const t = useTranslations("compare");
  return (
    <div className="mx-auto max-w-3xl">
      <StatCompareRow
        label={t("stat_koWins")}
        valueA={a.ufc_wins_ko}
        valueB={b.ufc_wins_ko}
        format="integer"
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_subWins")}
        valueA={a.ufc_wins_sub}
        valueB={b.ufc_wins_sub}
        format="integer"
        higherIsBetter
      />
      <StatCompareRow
        label={t("stat_decWins")}
        valueA={a.ufc_wins_dec}
        valueB={b.ufc_wins_dec}
        format="integer"
      />
      <StatCompareRow
        label={t("stat_finishRate")}
        valueA={finishRate(a)}
        valueB={finishRate(b)}
        format="percent"
        higherIsBetter
      />
    </div>
  );
}
