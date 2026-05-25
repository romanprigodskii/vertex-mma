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
    <div className="flex flex-wrap gap-1">
      {STANCES.map((s) => {
        const isActive = selected.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onToggle(s.id)}
            aria-pressed={isActive}
            className={cn(
              "type-label inline-flex h-6 items-center rounded-sm border px-2 text-[11px] transition-colors duration-(--motion-fast) ease-out-soft",
              isActive
                ? "border-fg/40 bg-fg/[0.08] text-fg"
                : "border-edge bg-transparent text-fg-muted hover:border-edge-strong hover:text-fg",
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
