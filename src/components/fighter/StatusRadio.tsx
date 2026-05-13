"use client";

import { cn } from "@/lib/utils";

const STATUSES: Array<{
  id: "all" | "active" | "retired" | "inactive";
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "retired", label: "Retired" },
  { id: "inactive", label: "Inactive" },
];

interface StatusRadioProps {
  value: "all" | "active" | "retired" | "inactive";
  onChange: (value: "all" | "active" | "retired" | "inactive") => void;
}

export function StatusRadio({ value, onChange }: StatusRadioProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Fighter status"
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
