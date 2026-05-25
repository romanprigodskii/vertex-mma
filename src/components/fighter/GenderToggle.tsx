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
              "type-label inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors duration-(--motion-fast) ease-out-soft",
              isActive
                ? "border-fg/40 bg-fg/[0.08] text-fg"
                : "border-edge bg-transparent text-fg-muted hover:border-edge-strong hover:text-fg",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
