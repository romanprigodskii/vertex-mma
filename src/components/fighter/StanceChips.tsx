"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

const STANCES: ReadonlyArray<{
  id: string;
  key: "stanceOrthodox" | "stanceSouthpaw" | "stanceSwitch" | "stanceUnknownLabel";
}> = [
  { id: "orthodox", key: "stanceOrthodox" },
  { id: "southpaw", key: "stanceSouthpaw" },
  { id: "switch", key: "stanceSwitch" },
  { id: "unknown", key: "stanceUnknownLabel" },
];

interface StanceChipsProps {
  selected: string[];
  onToggle: (id: string) => void;
}

export function StanceChips({ selected, onToggle }: StanceChipsProps) {
  const t = useTranslations("catalog");
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
              "inline-flex h-6 items-center rounded-sm border px-2 text-[11px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {t(s.key)}
          </button>
        );
      })}
    </div>
  );
}
