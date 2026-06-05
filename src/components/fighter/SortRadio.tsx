"use client";

import { useTranslations } from "next-intl";

import { FilterRadioGroup } from "@/components/fighter/FilterRadioGroup";
import { SORT_IDS } from "@/components/fighter/SortDropdown";
import type { CatalogSort } from "@/lib/fighter-search";

interface SortRadioProps {
  value: CatalogSort;
  onChange: (sort: CatalogSort) => void;
}

/**
 * Vertical, touch-friendly sort picker for the mobile filter drawer — the
 * SortDropdown popover only renders at `lg`+, so without this the result
 * ordering was unreachable on phones/tablets. Same option set and labels as
 * SortDropdown so the two stay in lockstep.
 */
export function SortRadio({ value, onChange }: SortRadioProps) {
  const t = useTranslations("catalog");
  return (
    <FilterRadioGroup
      value={value}
      onChange={onChange}
      ariaLabel={t("sortAria")}
      className="grid grid-cols-1 gap-1"
      itemClassName="h-auto justify-start px-3 py-2 text-left text-xs whitespace-normal leading-snug"
      options={SORT_IDS.map((id) => ({
        id,
        label: t(`sort_${id}` as "sort_fights"),
      }))}
    />
  );
}
