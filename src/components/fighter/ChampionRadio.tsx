"use client";

import { useTranslations } from "next-intl";

import { FilterRadioGroup } from "@/components/fighter/FilterRadioGroup";
import type { CatalogChampionFilter } from "@/lib/fighter-search";

const CHAMPIONS: ReadonlyArray<{
  id: CatalogChampionFilter;
  key:
    | "championAll"
    | "championCurrent"
    | "championDominant"
    | "championFormer"
    | "championNever";
}> = [
  { id: "all", key: "championAll" },
  // "Current champs" — not the Status filter's "Active". A champion context
  // needs its own word so the option isn't ambiguous next to Former/None.
  { id: "active", key: "championCurrent" },
  { id: "dominant", key: "championDominant" },
  { id: "former", key: "championFormer" },
  { id: "none", key: "championNever" },
];

interface ChampionRadioProps {
  value: CatalogChampionFilter;
  onChange: (value: CatalogChampionFilter) => void;
}

export function ChampionRadio({ value, onChange }: ChampionRadioProps) {
  const t = useTranslations("catalog");
  return (
    <FilterRadioGroup
      value={value}
      onChange={onChange}
      ariaLabel={t("filterChampion")}
      className="grid grid-cols-2 gap-1"
      options={CHAMPIONS.map((c) => ({ id: c.id, label: t(c.key) }))}
    />
  );
}
