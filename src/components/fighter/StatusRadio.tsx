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
      className="grid grid-cols-2 gap-1.5"
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
              "inline-flex h-8 items-center justify-center rounded-md border px-2 text-xs transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-transparent text-foreground-muted hover:border-border-strong hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
