"use client";

import { ChevronDown } from "lucide-react";

import type { CatalogSort } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const SORT_OPTIONS: Array<{ id: CatalogSort; label: string }> = [
  { id: "vertex_current", label: "Vertex Score (current form)" },
  { id: "vertex_all_time", label: "Vertex Score (all-time)" },
  { id: "elite_first", label: "Top fighters now (legacy)" },
  { id: "all_time", label: "All-time greats (legacy)" },
  { id: "fights", label: "Most fights" },
  { id: "recent", label: "Recently active" },
  { id: "wins", label: "Most wins" },
  { id: "winrate", label: "Highest win rate" },
  { id: "champions_first", label: "Champions first" },
  { id: "name_asc", label: "Name A–Z" },
  { id: "name_desc", label: "Name Z–A" },
];

interface SortDropdownProps {
  value: CatalogSort;
  onChange: (sort: CatalogSort) => void;
  className?: string;
}

export function SortDropdown({ value, onChange, className }: SortDropdownProps) {
  return (
    <div className={cn("relative inline-flex w-full", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CatalogSort)}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-border bg-background-base pl-3 pr-8 text-xs text-foreground",
          "focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30",
          "transition-colors",
        )}
        aria-label="Sort fighters"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle"
      />
    </div>
  );
}
