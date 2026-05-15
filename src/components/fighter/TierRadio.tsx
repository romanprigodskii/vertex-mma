"use client";

import type { CatalogTierFilter } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const TIERS: Array<{ id: CatalogTierFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "apex", label: "Apex" },
  { id: "elite", label: "Elite" },
  { id: "veteran", label: "Veteran" },
  { id: "roster", label: "Roster" },
];

interface TierRadioProps {
  value: CatalogTierFilter;
  onChange: (value: CatalogTierFilter) => void;
}

export function TierRadio({ value, onChange }: TierRadioProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Vertex Score tier"
      className="grid grid-cols-2 gap-1"
    >
      {TIERS.map((t) => {
        const isActive = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
