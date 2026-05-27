"use client";

import { useTranslations } from "next-intl";

import type { CatalogGenderFilter } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const OPTIONS: ReadonlyArray<{
  id: CatalogGenderFilter;
  key: "anyGender" | "men" | "women";
}> = [
  { id: "all", key: "anyGender" },
  { id: "male", key: "men" },
  { id: "female", key: "women" },
];

interface GenderToggleProps {
  value: CatalogGenderFilter;
  onChange: (value: CatalogGenderFilter) => void;
}

export function GenderToggle({ value, onChange }: GenderToggleProps) {
  const t = useTranslations("catalog");
  return (
    <div
      role="radiogroup"
      aria-label={t("filterGender")}
      className="grid grid-cols-3 gap-1"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.id)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {t(opt.key)}
          </button>
        );
      })}
    </div>
  );
}
