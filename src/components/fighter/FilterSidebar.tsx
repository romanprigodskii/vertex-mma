"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, X } from "lucide-react";

import { CountrySelect } from "@/components/fighter/CountrySelect";
import { StanceChips } from "@/components/fighter/StanceChips";
import { ChampionRadio } from "@/components/fighter/ChampionRadio";
import { GenderToggle } from "@/components/fighter/GenderToggle";
import { SortRadio } from "@/components/fighter/SortRadio";
import { StatusRadio } from "@/components/fighter/StatusRadio";
import { TierRadio } from "@/components/fighter/TierRadio";
import { WeightClassChips } from "@/components/fighter/WeightClassChips";
import { Button } from "@/components/ui/button";
import type {
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
    | "champion"
    | "gender"
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
  /**
   * Render an in-panel Sort section. The desktop layout has its own
   * SortDropdown beside the search box, but that control is `lg`-only, so the
   * mobile drawer passes this to expose sorting on phones/tablets.
   */
  showSort?: boolean;
  className?: string;
}

export function activeFilterCount(filters: CatalogFilterState): number {
  let n = 0;
  if (filters.q.trim()) n += 1;
  if (filters.weight.length) n += 1;
  if (filters.country.length) n += 1;
  if (filters.stance.length) n += 1;
  if (filters.status !== "active") n += 1;
  if (filters.hasPhoto) n += 1;
  if (filters.hallOfFame) n += 1;
  if (filters.sort !== "vertex_current") n += 1;
  if (filters.tier !== "all") n += 1;
  if (filters.champion !== "all") n += 1;
  if (filters.gender !== "all") n += 1;
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
        className="flex w-full items-center justify-between gap-2 rounded-sm py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
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
      {/* The checkbox is the peer; keeping it a sibling *before* the visible
          track lets peer-focus-visible drive the track's focus ring. */}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background-base",
          checked ? "bg-primary" : "bg-background-overlay border border-border",
        )}
      >
        <span
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
  showSort = false,
  className,
}: FilterSidebarProps) {
  const t = useTranslations("catalog");
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
              {t("clearShort")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showSort ? (
        <Section title={t("sortHeading")}>
          <SortRadio
            value={filters.sort}
            onChange={(sort) => onChange({ sort })}
          />
        </Section>
      ) : null}

      <Section title={t("weightClass")}>
        <WeightClassChips
          selected={filters.weight}
          onToggle={(id) => toggleInArray("weight", id)}
        />
      </Section>

      <Section title={t("filterGender")}>
        <GenderToggle
          value={filters.gender}
          onChange={(gender) => onChange({ gender })}
        />
      </Section>

      <Section title={t("filterStatus")}>
        <StatusRadio
          value={
            filters.status as "all" | "active" | "inactive" | "retired"
          }
          onChange={(status) => onChange({ status })}
        />
      </Section>

      <Section title={t("filterTier")}>
        <TierRadio
          value={filters.tier}
          onChange={(tier) => onChange({ tier })}
        />
      </Section>

      <Section title={t("filterChampion")}>
        <ChampionRadio
          value={filters.champion}
          onChange={(champion) => onChange({ champion })}
        />
      </Section>

      <Section title={t("country")}>
        <CountrySelect
          countries={countries}
          selected={filters.country}
          onToggle={(code) => toggleInArray("country", code)}
        />
      </Section>

      <Section title={t("stance")}>
        <StanceChips
          selected={filters.stance}
          onToggle={(id) => toggleInArray("stance", id)}
        />
      </Section>

      <Section title={t("filterSpecial")}>
        <div className="space-y-1">
          <ToggleRow
            label={t("hasPhoto")}
            checked={filters.hasPhoto}
            onChange={(hasPhoto) => onChange({ hasPhoto })}
          />
          <ToggleRow
            label={t("hallOfFame")}
            checked={filters.hallOfFame}
            onChange={(hallOfFame) => onChange({ hallOfFame })}
          />
        </div>
      </Section>

    </aside>
  );
}
