"use client";

import type { CatalogChampionFilter } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

// `any` (the catch-all "any champion sub-tier") is intentionally absent —
// it's reachable only via URL ?champion=any. UI users hit Active /
// Dominant / Former separately so the displayed result count matches a
// single sub-tier instead of a union.
const CHAMPIONS: Array<{ id: CatalogChampionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "dominant", label: "Dominant" },
  { id: "former", label: "Former" },
  { id: "none", label: "None" },
];

interface ChampionRadioProps {
  value: CatalogChampionFilter;
  onChange: (value: CatalogChampionFilter) => void;
}

export function ChampionRadio({ value, onChange }: ChampionRadioProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Champion status"
      className="grid grid-cols-2 gap-1"
    >
      {CHAMPIONS.map((c) => {
        const isActive = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(c.id)}
            className={cn(
              "type-label inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors duration-(--motion-fast) ease-out-soft",
              isActive
                ? "border-fg/40 bg-fg/[0.08] text-fg"
                : "border-edge bg-transparent text-fg-muted hover:border-edge-strong hover:text-fg",
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
