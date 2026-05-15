"use client";

import { cn } from "@/lib/utils";

// Wave 6C: now targets the roster_status column (populated from
// roster.watch by scripts/import_roster_watch.ts), not the legacy
// fighter.status enum. `inactive` (0 fighters post-import) and `unknown`
// (~104 old fighters) are reachable only via URL ?status=inactive /
// ?status=unknown — UI surfaces only the four states that map to
// actionable user intent.
const STATUSES: Array<{
  id: "all" | "active" | "released" | "retired";
  label: string;
}> = [
  { id: "active", label: "Active" },
  { id: "released", label: "Released" },
  { id: "retired", label: "Retired" },
  { id: "all", label: "All" },
];

interface StatusRadioProps {
  value: "all" | "active" | "released" | "retired";
  onChange: (value: "all" | "active" | "released" | "retired") => void;
}

export function StatusRadio({ value, onChange }: StatusRadioProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Roster status"
      className="grid grid-cols-2 gap-1"
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
