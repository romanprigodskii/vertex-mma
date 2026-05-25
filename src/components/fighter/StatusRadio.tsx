"use client";

import { cn } from "@/lib/utils";

// Wave 6A.5b: roster.watch import emits only two roster_status values now
// (active for current UFC roster, retired for everyone else — released,
// HoF, and untracked-ancient all collapse). The granular enum stays in
// the DB schema for future use; the UI exposes just the binary view +
// "All" to escape the active default.
const STATUSES: Array<{
  id: "all" | "active" | "retired";
  label: string;
}> = [
  { id: "active", label: "Active" },
  { id: "retired", label: "Retired" },
  { id: "all", label: "All" },
];

interface StatusRadioProps {
  value: "all" | "active" | "retired";
  onChange: (value: "all" | "active" | "retired") => void;
}

export function StatusRadio({ value, onChange }: StatusRadioProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Roster status"
      className="grid grid-cols-3 gap-1"
    >
      {STATUSES.map((s) => {
        const isActive = value === s.id;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(s.id)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
