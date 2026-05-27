"use client";

import { useTranslations } from "next-intl";

import type { CatalogChampionFilter } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const CHAMPIONS: ReadonlyArray<{
  id: CatalogChampionFilter;
  key:
    | "championAll"
    | "statusActive"
    | "championDominant"
    | "championFormer"
    | "championNone";
}> = [
  { id: "all", key: "championAll" },
  { id: "active", key: "statusActive" },
  { id: "dominant", key: "championDominant" },
  { id: "former", key: "championFormer" },
  { id: "none", key: "championNone" },
];

interface ChampionRadioProps {
  value: CatalogChampionFilter;
  onChange: (value: CatalogChampionFilter) => void;
}

export function ChampionRadio({ value, onChange }: ChampionRadioProps) {
  const t = useTranslations("catalog");
  return (
    <div
      role="radiogroup"
      aria-label={t("filterChampion")}
      className="grid grid-cols-2 gap-1"
    >
      {CHAMPIONS.map((c) => {
        const isActive = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(c.id)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {t(c.key)}
          </button>
        );
      })}
    </div>
  );
}
