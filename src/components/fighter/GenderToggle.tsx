"use client";

import { useTranslations } from "next-intl";

import { FilterRadioGroup } from "@/components/fighter/FilterRadioGroup";
import type { CatalogGenderFilter } from "@/lib/fighter-search";

const OPTIONS: ReadonlyArray<{
  id: CatalogGenderFilter;
  key: "anyGender" | "men" | "women";
}> = [
  { id: "all", key: "anyGender" },
  { id: "male", key: "men" },
  { id: "female", key: "women" },
];

interface GenderToggleProps {
  value: CatalogGenderFilter;
  onChange: (value: CatalogGenderFilter) => void;
}

export function GenderToggle({ value, onChange }: GenderToggleProps) {
  const t = useTranslations("catalog");
  return (
    <FilterRadioGroup
      value={value}
      onChange={onChange}
      ariaLabel={t("filterGender")}
      className="grid grid-cols-3 gap-1"
      options={OPTIONS.map((opt) => ({ id: opt.id, label: t(opt.key) }))}
    />
  );
}
