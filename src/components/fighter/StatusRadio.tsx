"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

type StatusValue = "all" | "active" | "inactive" | "retired";

const STATUSES: ReadonlyArray<{
  id: StatusValue;
  key: "statusActive" | "statusInactive" | "statusAll";
}> = [
  { id: "active", key: "statusActive" },
  { id: "inactive", key: "statusInactive" },
  { id: "all", key: "statusAll" },
];

interface StatusRadioProps {
  value: StatusValue;
  onChange: (value: StatusValue) => void;
}

export function StatusRadio({ value, onChange }: StatusRadioProps) {
  const t = useTranslations("catalog");
  return (
    <div
      role="radiogroup"
      aria-label={t("filterStatus")}
      className="grid grid-cols-3 gap-1"
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
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
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
