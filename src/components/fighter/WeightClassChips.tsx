"use client";

import { WEIGHT_CLASSES } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface WeightClassChipsProps {
  selected: string[];
  onToggle: (id: string) => void;
}

export function WeightClassChips({ selected, onToggle }: WeightClassChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEIGHT_CLASSES.map((wc) => {
        const isActive = selected.includes(wc.id);
        return (
          <button
            key={wc.id}
            type="button"
            onClick={() => onToggle(wc.id)}
            aria-pressed={isActive}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-transparent text-foreground-muted hover:border-border-strong hover:text-foreground",
            )}
          >
            <span className="truncate">{wc.label}</span>
            <span
              className={cn(
                "font-mono text-[10px]",
                isActive ? "opacity-80" : "text-foreground-subtle",
              )}
            >
              {wc.limitLb}
            </span>
          </button>
        );
      })}
    </div>
  );
}
