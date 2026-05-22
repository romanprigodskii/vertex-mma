"use client";

import { Select, type SelectOption } from "@/components/ui/select";
import type { CatalogSort } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const SORT_OPTIONS: SelectOption<CatalogSort>[] = [
  { value: "vertex_current", label: "Vertex Score (current form)" },
  { value: "vertex_all_time", label: "Vertex Score (all-time)" },
  { value: "elite_first", label: "Top fighters now (legacy)" },
  { value: "all_time", label: "All-time greats (legacy)" },
  { value: "fights", label: "Most fights" },
  { value: "recent", label: "Recently active" },
  { value: "wins", label: "Most wins" },
  { value: "winrate", label: "Highest win rate" },
  { value: "champions_first", label: "Champions first" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
];

interface SortDropdownProps {
  value: CatalogSort;
  onChange: (sort: CatalogSort) => void;
  className?: string;
}

export function SortDropdown({ value, onChange, className }: SortDropdownProps) {
  return (
    <Select
      value={value}
      onChange={onChange}
      options={SORT_OPTIONS}
      ariaLabel="Sort fighters"
      align="end"
      className={cn("min-w-[220px]", className)}
    />
  );
}
