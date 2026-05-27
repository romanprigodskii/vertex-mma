"use client";

import { useTranslations } from "next-intl";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  onReset?: () => void;
  hint?: string;
}

export function EmptyState({
  onReset,
  hint,
}: EmptyStateProps) {
  const t = useTranslations("catalog");
  const effectiveHint = hint ?? t("emptyHint");
  return (
    <div className="flex flex-col items-center justify-center gap-4 border-y border-dashed border-foreground/10 px-6 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-foreground/10 bg-background-elevated/60 text-foreground-subtle">
        <SearchX className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="font-display text-2xl uppercase tracking-wide text-foreground">
          {t("nothingHere")}
        </p>
        <p className="max-w-sm text-sm text-foreground-muted">{effectiveHint}</p>
      </div>
      {onReset ? (
        <Button variant="outline" size="sm" onClick={onReset}>
          {t("clearFilters")}
        </Button>
      ) : null}
    </div>
  );
}
