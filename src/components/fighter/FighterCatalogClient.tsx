"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { CatalogSkeleton } from "@/components/fighter/CatalogSkeleton";
import { EmptyState } from "@/components/fighter/EmptyState";
import { FighterCard } from "@/components/fighter/FighterCard";
import { FilterDrawer } from "@/components/fighter/FilterDrawer";
import {
  type CatalogFilterState,
  FilterSidebar,
  activeFilterCount,
} from "@/components/fighter/FilterSidebar";
import { SearchBar } from "@/components/fighter/SearchBar";
import { SortDropdown } from "@/components/fighter/SortDropdown";
import { Button } from "@/components/ui/button";
import type {
  CatalogSort,
  CountryAggregate,
  FighterCatalogResponse,
  FighterCatalogRow,
} from "@/lib/fighter-search";

const PAGE_SIZE = 48;

const DEFAULT_FILTERS: CatalogFilterState = {
  q: "",
  weight: [],
  country: [],
  stance: [],
  status: "all",
  hasPhoto: false,
  hallOfFame: false,
  sort: "fights",
};

function serializeFilters(filters: CatalogFilterState): URLSearchParams {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set("q", q);
  if (filters.weight.length) params.set("weight", filters.weight.join(","));
  if (filters.country.length) params.set("country", filters.country.join(","));
  if (filters.stance.length) params.set("stance", filters.stance.join(","));
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.hasPhoto) params.set("has_photo", "1");
  if (filters.hallOfFame) params.set("hof", "1");
  if (filters.sort !== "fights") params.set("sort", filters.sort);
  return params;
}

function filtersKey(filters: CatalogFilterState): string {
  return serializeFilters(filters).toString();
}

interface FighterCatalogClientProps {
  initialFighters: FighterCatalogRow[];
  initialTotal: number;
  initialHasMore: boolean;
  initialFilters: CatalogFilterState;
  countries: CountryAggregate[];
  totalAll: number;
}

export function FighterCatalogClient({
  initialFighters,
  initialTotal,
  initialHasMore,
  initialFilters,
  countries,
  totalAll,
}: FighterCatalogClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [filters, setFilters] = React.useState<CatalogFilterState>(initialFilters);
  const [searchInput, setSearchInput] = React.useState(initialFilters.q);

  // Result state — seeded from SSR so the first paint is instant.
  const [fighters, setFighters] = React.useState<FighterCatalogRow[]>(initialFighters);
  const [total, setTotal] = React.useState(initialTotal);
  const [hasMore, setHasMore] = React.useState(initialHasMore);
  const [offset, setOffset] = React.useState(initialFighters.length);

  const [loading, setLoading] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The most recent filter key we kicked a fetch for — used to discard
  // out-of-order responses if the user keeps typing.
  const inflightKeyRef = React.useRef<string>(filtersKey(initialFilters));

  // ---------- Search input → filters (debounced 250ms) ----------
  React.useEffect(() => {
    if (searchInput === filters.q) return;
    const timer = window.setTimeout(() => {
      setFilters((prev) => ({ ...prev, q: searchInput }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput, filters.q]);

  // ---------- URL sync (replace, no scroll) ----------
  const urlFilterKey = filtersKey(filters);
  React.useEffect(() => {
    const next = urlFilterKey;
    const current = searchParams.toString();
    if (next === current) return;
    router.replace(next ? `/fighters?${next}` : "/fighters", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFilterKey]);

  // ---------- Filter-change fetch ----------
  const initialKeyRef = React.useRef<string>(filtersKey(initialFilters));
  React.useEffect(() => {
    const key = filtersKey(filters);
    // Don't refetch on mount if filters still match SSR'd state.
    if (key === initialKeyRef.current) {
      inflightKeyRef.current = key;
      return;
    }

    inflightKeyRef.current = key;
    setSearching(filters.q.trim().length > 0);
    setLoading(true);
    setError(null);

    const params = serializeFilters(filters);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", "0");

    const controller = new AbortController();
    fetch(`/api/fighters?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: FighterCatalogResponse = await res.json();
        // Stale response check
        if (inflightKeyRef.current !== key) return;
        setFighters(data.fighters);
        setTotal(data.total);
        setHasMore(data.hasMore);
        setOffset(data.fighters.length);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setError("Could not load fighters. Try again.");
      })
      .finally(() => {
        if (inflightKeyRef.current === key) {
          setLoading(false);
          setSearching(false);
        }
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFilterKey]);

  // ---------- Infinite scroll ----------
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const loadMore = React.useCallback(() => {
    if (loadingMore || loading || !hasMore) return;
    const key = filtersKey(filters);
    setLoadingMore(true);

    const params = serializeFilters(filters);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));

    fetch(`/api/fighters?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: FighterCatalogResponse = await res.json();
        if (inflightKeyRef.current !== key) return;
        setFighters((prev) => [...prev, ...data.fighters]);
        setHasMore(data.hasMore);
        setOffset((prev) => prev + data.fighters.length);
      })
      .catch(() => {
        // Quiet failure for pagination — user can hit "Load more" again.
      })
      .finally(() => setLoadingMore(false));
  }, [filters, hasMore, loading, loadingMore, offset]);

  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  // ---------- Filter mutation helpers ----------
  const onFiltersChange = React.useCallback(
    (next: Partial<CatalogFilterState>) => {
      setFilters((prev) => ({ ...prev, ...next }));
      if ("q" in next && typeof next.q === "string") {
        setSearchInput(next.q);
      }
    },
    [],
  );

  const onClear = React.useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setSearchInput("");
  }, []);

  const activeCount = activeFilterCount(filters);
  const resultCount = { shown: fighters.length, total };
  const showSkeleton = loading && fighters.length === 0;
  const showEmpty = !loading && fighters.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Sticky controls bar */}
      <div className="sticky top-16 z-30 -mx-4 border-b border-border bg-background-base/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex-1">
            <SearchBar
              value={searchInput}
              onChange={(v) => {
                setSearchInput(v);
                if (v === "") {
                  setFilters((prev) => ({ ...prev, q: "" }));
                }
              }}
              loading={searching}
            />
          </div>
          {/* Sort visible inline on desktop */}
          <div className="hidden lg:block w-44">
            <FilterDrawerSortInline
              sort={filters.sort}
              onChange={(sort) => onFiltersChange({ sort })}
            />
          </div>
          {/* Mobile filter drawer */}
          <div className="lg:hidden">
            <FilterDrawer
              filters={filters}
              onChange={onFiltersChange}
              onClear={onClear}
              countries={countries}
              resultCount={resultCount}
            />
          </div>
          <p className="hidden sm:block text-xs text-foreground-muted tabular">
            <span className="font-mono text-foreground">
              {total.toLocaleString()}
            </span>{" "}
            / {totalAll.toLocaleString()}
          </p>
        </div>
        {activeCount > 0 ? (
          <p className="mt-2 text-[11px] text-foreground-subtle">
            {activeCount} filter{activeCount === 1 ? "" : "s"} active —{" "}
            <button
              type="button"
              onClick={onClear}
              className="text-primary hover:underline"
            >
              clear all
            </button>
          </p>
        ) : null}
      </div>

      <div className="flex gap-6 lg:gap-8">
        {/* Desktop filter sidebar */}
        <div className="hidden lg:block w-[260px] shrink-0">
          <div className="sticky top-36 max-h-[calc(100vh-9rem)] overflow-y-auto pr-2">
            <FilterSidebar
              filters={filters}
              onChange={onFiltersChange}
              onClear={onClear}
              countries={countries}
              resultCount={resultCount}
            />
          </div>
        </div>

        {/* Catalog grid */}
        <div className="min-w-0 flex-1">
          {error ? (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-foreground">
              {error}
            </div>
          ) : null}

          {showSkeleton ? (
            <CatalogSkeleton count={12} />
          ) : showEmpty ? (
            <EmptyState onReset={activeCount > 0 ? onClear : undefined} />
          ) : (
            <>
              <motion.div
                key={urlFilterKey}
                variants={GRID_VARIANTS}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              >
                <AnimatePresence initial={false}>
                  {fighters.map((f, i) => (
                    <motion.div
                      key={f.id}
                      variants={CARD_VARIANTS}
                      layout="position"
                    >
                      <FighterCard fighter={f} priority={i < 8} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>

              {/* Pagination footer */}
              <div className="mt-10 flex flex-col items-center gap-3 text-center">
                <p className="text-xs text-foreground-subtle tabular">
                  Loaded {fighters.length.toLocaleString()} of{" "}
                  {total.toLocaleString()}
                </p>
                {hasMore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadMore}
                    loading={loadingMore}
                  >
                    Load more
                  </Button>
                ) : fighters.length > 0 ? (
                  <p className="text-xs text-foreground-subtle">
                    End of results
                  </p>
                ) : null}
                {/* Sentinel — IntersectionObserver triggers loadMore when visible */}
                <div ref={sentinelRef} aria-hidden className="h-1 w-full" />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Animation variants                                                         */
/* -------------------------------------------------------------------------- */

const GRID_VARIANTS = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03, delayChildren: 0.04 },
  },
};

const CARD_VARIANTS = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: "easeOut" as const },
  },
};

/* -------------------------------------------------------------------------- */
/*  Inline sort dropdown (visible in desktop top-bar)                         */
/* -------------------------------------------------------------------------- */

function FilterDrawerSortInline({
  sort,
  onChange,
}: {
  sort: CatalogSort;
  onChange: (s: CatalogSort) => void;
}) {
  return <SortDropdown value={sort} onChange={onChange} />;
}
