"use client";

import { cn } from "@/lib/utils";

// roster.watch keeps three roster_status values (active 614, retired 132,
// released 1951). "Inactive" is the UI bucket that covers retired +
// released so legends like Jon Jones (released, not formally retired)
// surface immediately on a single click instead of hiding under the
// "All" archive view.
type StatusValue = "all" | "active" | "inactive" | "retired";

const STATUSES: Array<{ id: StatusValue; label: string }> = [
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
  { id: "all", label: "All" },
];

interface StatusRadioProps {
  value: StatusValue;
  onChange: (value: StatusValue) => void;
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
