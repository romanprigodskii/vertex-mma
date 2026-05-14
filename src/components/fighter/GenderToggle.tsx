"use client";

import type { CatalogGenderFilter } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{ id: CatalogGenderFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "male", label: "Men" },
  { id: "female", label: "Women" },
];

interface GenderToggleProps {
  value: CatalogGenderFilter;
  onChange: (value: CatalogGenderFilter) => void;
}

export function GenderToggle({ value, onChange }: GenderToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Gender"
      className="grid grid-cols-3 gap-1"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.id)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
