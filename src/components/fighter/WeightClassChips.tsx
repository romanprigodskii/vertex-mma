"use client";

import { WEIGHT_CLASSES } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface WeightClassChipsProps {
  selected: string[];
  onToggle: (id: string) => void;
}

export function WeightClassChips({ selected, onToggle }: WeightClassChipsProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {WEIGHT_CLASSES.map((wc) => {
        const isActive = selected.includes(wc.id);
        return (
          <button
            key={wc.id}
            type="button"
            onClick={() => onToggle(wc.id)}
            aria-pressed={isActive}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            <span className="truncate">{wc.label}</span>
            <span
              className={cn(
                "font-mono text-[9px]",
                isActive ? "opacity-75" : "text-foreground-subtle",
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
