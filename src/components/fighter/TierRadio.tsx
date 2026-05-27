"use client";

import { useTranslations } from "next-intl";

import type { CatalogTierFilter } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const TIERS: ReadonlyArray<{
  id: CatalogTierFilter;
  key:
    | "tierAll"
    | "tierApex"
    | "tierElite"
    | "tierEstablished"
    | "tierRoster";
}> = [
  { id: "all", key: "tierAll" },
  { id: "apex", key: "tierApex" },
  { id: "elite", key: "tierElite" },
  { id: "established", key: "tierEstablished" },
  { id: "roster", key: "tierRoster" },
];

interface TierRadioProps {
  value: CatalogTierFilter;
  onChange: (value: CatalogTierFilter) => void;
}

export function TierRadio({ value, onChange }: TierRadioProps) {
  const t = useTranslations("catalog");
  return (
    <div
      role="radiogroup"
      aria-label={t("filterTier")}
      className="grid grid-cols-2 gap-1"
    >
      {TIERS.map((tier) => {
        const isActive = value === tier.id;
        return (
          <button
            key={tier.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(tier.id)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {t(tier.key)}
          </button>
        );
      })}
    </div>
  );
}
