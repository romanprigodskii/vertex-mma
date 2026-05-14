"use client";

import * as React from "react";
import { ChevronDown, X } from "lucide-react";

import { CountrySelect } from "@/components/fighter/CountrySelect";
import { SortDropdown } from "@/components/fighter/SortDropdown";
import { StanceChips } from "@/components/fighter/StanceChips";
import { StatusRadio } from "@/components/fighter/StatusRadio";
import { WeightClassChips } from "@/components/fighter/WeightClassChips";
import { Button } from "@/components/ui/button";
import type {
  CatalogSort,
  CountryAggregate,
  FighterCatalogFilters,
} from "@/lib/fighter-search";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export type CatalogFilterState = Required<
  Pick<
    FighterCatalogFilters,
    | "weight"
    | "country"
    | "stance"
    | "status"
    | "hasPhoto"
    | "hallOfFame"
    | "sort"
    | "tier"
  >
> & {
  q: string;
};

interface FilterSidebarProps {
  filters: CatalogFilterState;
  onChange: (next: Partial<CatalogFilterState>) => void;
  onClear: () => void;
  countries: CountryAggregate[];
  /** When non-null, rendered above the filters as "Showing X of Y". */
  resultCount?: { shown: number; total: number };
  /**
   * Compact spacing/typography for the desktop 220px rail. The drawer
   * intentionally stays a touch roomier.
   */
  dense?: boolean;
  className?: string;
}

export function activeFilterCount(filters: CatalogFilterState): number {
  let n = 0;
  if (filters.q.trim()) n += 1;
  if (filters.weight.length) n += 1;
  if (filters.country.length) n += 1;
  if (filters.stance.length) n += 1;
  if (filters.status !== "all") n += 1;
  if (filters.hasPhoto) n += 1;
  if (filters.hallOfFame) n += 1;
  if (filters.sort !== "vertex_current") n += 1;
  if (filters.tier !== "all") n += 1;
  return n;
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border-b border-foreground/[0.06] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
      >
        <span className="font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-foreground-muted">
          {title}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-foreground-subtle transition-transform duration-150",
            open ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr] pb-4" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors">
      <span>{label}</span>
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-primary" : "bg-background-overlay border border-border",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-foreground shadow transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-[3px]",
          )}
        />
      </span>
    </label>
  );
}

export function FilterSidebar({
  filters,
  onChange,
  onClear,
  countries,
  resultCount,
  dense = false,
  className,
}: FilterSidebarProps) {
  const toggleInArray = React.useCallback(
    (key: "weight" | "country" | "stance", id: string) => {
      const current = filters[key];
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id];
      onChange({ [key]: next } as Partial<CatalogFilterState>);
    },
    [filters, onChange],
  );

  const activeCount = activeFilterCount(filters);

  return (
    <aside
      className={cn(
        "flex flex-col text-foreground",
        dense ? "text-xs" : "text-sm",
        className,
      )}
    >
      {resultCount ? (
        <div
          className={cn(
            "flex items-baseline justify-between gap-2 border-b border-foreground/10",
            dense ? "mb-1 pb-2.5" : "mb-2 pb-3",
          )}
        >
          <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
            <span className="font-mono tabular text-foreground">
              {formatNumber(resultCount.shown)}
            </span>
            <span className="mx-1 text-foreground-subtle/50">/</span>
            <span className="font-mono tabular">
              {formatNumber(resultCount.total)}
            </span>
          </p>
          {activeCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="h-6 px-1.5 text-[11px] uppercase tracking-wider"
            >
              <X className="h-3 w-3" />
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}

      <Section title="Weight class">
        <WeightClassChips
          selected={filters.weight}
          onToggle={(id) => toggleInArray("weight", id)}
        />
      </Section>

      <Section title="Status">
        <StatusRadio
          value={filters.status}
          onChange={(status) => onChange({ status })}
        />
      </Section>

      <Section title="Country">
        <CountrySelect
          countries={countries}
          selected={filters.country}
          onToggle={(code) => toggleInArray("country", code)}
        />
      </Section>

      <Section title="Stance">
        <StanceChips
          selected={filters.stance}
          onToggle={(id) => toggleInArray("stance", id)}
        />
      </Section>

      <Section title="Special">
        <div className="space-y-1">
          <ToggleRow
            label="Has photo"
            checked={filters.hasPhoto}
            onChange={(hasPhoto) => onChange({ hasPhoto })}
          />
          <ToggleRow
            label="Hall of Fame"
            checked={filters.hallOfFame}
            onChange={(hallOfFame) => onChange({ hallOfFame })}
          />
        </div>
      </Section>

      <Section title="Sort">
        <SortDropdown
          value={filters.sort}
          onChange={(sort: CatalogSort) => onChange({ sort })}
        />
      </Section>
    </aside>
  );
}
