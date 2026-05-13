"use client";

import { cn } from "@/lib/utils";

const STANCES: Array<{ id: string; label: string }> = [
  { id: "orthodox", label: "Orthodox" },
  { id: "southpaw", label: "Southpaw" },
  { id: "switch", label: "Switch" },
  { id: "unknown", label: "Unknown" },
];

interface StanceChipsProps {
  selected: string[];
  onToggle: (id: string) => void;
}

export function StanceChips({ selected, onToggle }: StanceChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {STANCES.map((s) => {
        const isActive = selected.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onToggle(s.id)}
            aria-pressed={isActive}
            className={cn(
              "inline-flex h-7 items-center rounded-md border px-2.5 text-xs transition-colors",
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
