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
              "type-label inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[11px] transition-colors duration-(--motion-fast) ease-out-soft",
              isActive
                ? "border-fg/40 bg-fg/[0.08] text-fg"
                : "border-edge bg-transparent text-fg-muted hover:border-edge-strong hover:text-fg",
            )}
          >
            <span className="truncate">{wc.label}</span>
            <span
              className={cn(
                "font-mono text-[9px]",
                isActive ? "opacity-75" : "text-fg-subtle",
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
