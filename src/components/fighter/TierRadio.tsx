"use client";

import { useTranslations } from "next-intl";

import { FilterRadioGroup } from "@/components/fighter/FilterRadioGroup";
import type { CatalogTierFilter } from "@/lib/fighter-search";

const TIERS: ReadonlyArray<{
  id: CatalogTierFilter;
  key:
    | "tierAll"
    | "tierApex"
    | "tierElite"
    | "tierEstablished"
    | "tierRoster";
}> = [
  { id: "all", key: "tierAll" },
  { id: "apex", key: "tierApex" },
  { id: "elite", key: "tierElite" },
  { id: "established", key: "tierEstablished" },
  { id: "roster", key: "tierRoster" },
];

interface TierRadioProps {
  value: CatalogTierFilter;
  onChange: (value: CatalogTierFilter) => void;
}

export function TierRadio({ value, onChange }: TierRadioProps) {
  const t = useTranslations("catalog");
  return (
    <FilterRadioGroup
      value={value}
      onChange={onChange}
      ariaLabel={t("filterTier")}
      className="grid grid-cols-2 gap-1"
      options={TIERS.map((tier) => ({ id: tier.id, label: t(tier.key) }))}
    />
  );
}
