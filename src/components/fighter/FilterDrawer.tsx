"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { SlidersHorizontal, X } from "lucide-react";

import {
  type CatalogFilterState,
  FilterSidebar,
  activeFilterCount,
} from "@/components/fighter/FilterSidebar";
import { Button } from "@/components/ui/button";
import type { CountryAggregate } from "@/lib/fighter-search";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface FilterDrawerProps {
  filters: CatalogFilterState;
  onChange: (next: Partial<CatalogFilterState>) => void;
  onClear: () => void;
  countries: CountryAggregate[];
  resultCount?: { shown: number; total: number };
  /** Visual style override for the trigger button. */
  triggerClassName?: string;
}

/**
 * Mobile-only filter affordance. Renders a sticky "Filters" button that opens
 * a right-side sheet built on Radix Dialog. The sheet is full-height and
 * scrolls internally; backdrop blurs the catalog beneath.
 *
 * Filter state is owned by the parent (FighterCatalogClient) — this component
 * is a pure presentational shell. "Apply" just closes the sheet; "Reset"
 * clears all filters and keeps the sheet open so the user can see the result.
 */
export function FilterDrawer({
  filters,
  onChange,
  onClear,
  countries,
  resultCount,
  triggerClassName,
}: FilterDrawerProps) {
  const t = useTranslations("catalog");
  const [open, setOpen] = React.useState(false);
  const count = activeFilterCount(filters);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background-elevated px-3 text-sm text-foreground",
            "hover:bg-background-overlay transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
            triggerClassName,
          )}
        >
          <SlidersHorizontal className="h-4 w-4 text-foreground-muted" />
          {t("filters")}
          {count > 0 ? (
            <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 font-mono text-[10px] text-primary-foreground">
              {count}
            </span>
          ) : null}
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background-base/70 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col",
            "border-l border-border bg-background-base shadow-elevation-2",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
            "duration-200",
          )}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="font-display text-xl uppercase tracking-wide text-foreground">
              {t("filters")}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-background-elevated hover:text-foreground transition-colors"
              aria-label={t("closeFilters")}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-2">
            <FilterSidebar
              filters={filters}
              onChange={onChange}
              onClear={onClear}
              countries={countries}
              resultCount={resultCount}
            />
          </div>

          <footer className="flex items-center gap-2 border-t border-border bg-background-base px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClear}
              disabled={count === 0}
              className="flex-1"
            >
              {t("reset")}
            </Button>
            <Button
              size="sm"
              onClick={() => setOpen(false)}
              className="flex-1"
            >
              {resultCount
                ? t("showN", { n: formatNumber(resultCount.shown) })
                : t("apply")}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
