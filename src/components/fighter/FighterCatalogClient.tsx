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
import { formatNumber } from "@/lib/format";

const PAGE_SIZE = 48;
const RANKED_SORTS: ReadonlySet<CatalogSort> = new Set([
  "vertex_current",
  "vertex_all_time",
  "elite_first",
  "all_time",
  "champions_first",
  "fights",
  "wins",
]);

const DEFAULT_FILTERS: CatalogFilterState = {
  q: "",
  weight: [],
  country: [],
  stance: [],
  // Wave 6C: catalog default is the live UFC roster (~611 fighters).
  // "Clear filters" returns here, not to the legacy "everyone" view.
  status: "active",
  hasPhoto: false,
  hallOfFame: false,
  sort: "vertex_current",
  tier: "all",
  champion: "all",
  gender: "all",
};

function serializeFilters(filters: CatalogFilterState): URLSearchParams {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set("q", q);
  if (filters.weight.length) params.set("weight", filters.weight.join(","));
  if (filters.country.length) params.set("country", filters.country.join(","));
  if (filters.stance.length) params.set("stance", filters.stance.join(","));
  // Status only enters the URL when it differs from the new default ("active").
  // ?status=all is now an explicit opt-in to the historical archive.
  if (filters.status !== "active") params.set("status", filters.status);
  if (filters.hasPhoto) params.set("has_photo", "1");
  if (filters.hallOfFame) params.set("hof", "1");
  if (filters.sort !== "vertex_current") params.set("sort", filters.sort);
  if (filters.tier !== "all") params.set("tier", filters.tier);
  if (filters.champion !== "all") params.set("champion", filters.champion);
  if (filters.gender !== "all") params.set("gender", filters.gender);
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

  const [fighters, setFighters] = React.useState<FighterCatalogRow[]>(initialFighters);
  const [total, setTotal] = React.useState(initialTotal);
  const [hasMore, setHasMore] = React.useState(initialHasMore);
  const [offset, setOffset] = React.useState(initialFighters.length);

  const [loading, setLoading] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const inflightKeyRef = React.useRef<string>(filtersKey(initialFilters));
  // Skip the filter-change effect on the very first render (SSR already
  // produced data for the initial filter set). On every subsequent
  // change — INCLUDING returning to the initial set, e.g. flipping sort
  // back to vertex_current after vertex_all_time — we must re-fetch so
  // the displayed order matches the active sort.
  const isFirstRender = React.useRef(true);

  // ---------- Search input → filters (debounced 250ms) ----------
  React.useEffect(() => {
    if (searchInput === filters.q) return;
    const timer = window.setTimeout(() => {
      setFilters((prev) => ({ ...prev, q: searchInput }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput, filters.q]);

  // ---------- URL sync ----------
  const urlFilterKey = filtersKey(filters);
  React.useEffect(() => {
    const next = urlFilterKey;
    const current = searchParams.toString();
    if (next === current) return;
    router.replace(next ? `/fighters?${next}` : "/fighters", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFilterKey]);

  // ---------- Filter-change fetch ----------
  React.useEffect(() => {
    const key = filtersKey(filters);
    if (isFirstRender.current) {
      isFirstRender.current = false;
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
        /* user can retry via the "Load more" button */
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
  const showRank = RANKED_SORTS.has(filters.sort);

  return (
    <div className="flex flex-col gap-6">
      {/* Sticky controls bar */}
      <div className="sticky top-16 z-30 -mx-4 border-b border-foreground/10 bg-background-base/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="min-w-0 flex-1 sm:max-w-[360px]">
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
          <p className="hidden sm:block whitespace-nowrap font-sans text-xs text-foreground-muted">
            Showing{" "}
            <span className="font-mono tabular text-foreground">
              {formatNumber(fighters.length)}
            </span>{" "}
            of{" "}
            <span className="font-mono tabular text-foreground">
              {formatNumber(total)}
            </span>
          </p>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden w-48 lg:block">
              <SortDropdown
                value={filters.sort}
                onChange={(sort) => onFiltersChange({ sort })}
              />
            </div>
            <div className="lg:hidden">
              <FilterDrawer
                filters={filters}
                onChange={onFiltersChange}
                onClear={onClear}
                countries={countries}
                resultCount={resultCount}
              />
            </div>
          </div>
        </div>
        {activeCount > 0 ? (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
            {activeCount} filter{activeCount === 1 ? "" : "s"} active ·{" "}
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
        {/* Desktop filter sidebar — tightened to 220px */}
        <div className="hidden lg:block w-[220px] shrink-0">
          <div className="sticky top-36 max-h-[calc(100vh-9rem)] overflow-y-auto pr-2">
            <FilterSidebar
              filters={filters}
              onChange={onFiltersChange}
              onClear={onClear}
              countries={countries}
              resultCount={resultCount}
              dense
            />
          </div>
        </div>

        {/* Roster column */}
        <div className="min-w-0 flex-1">
          {error ? (
            <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-foreground">
              {error}
            </div>
          ) : null}

          {/* Roster header above the catalog list. */}
          <div className="mb-3 mt-2 flex items-baseline justify-between gap-3 border-b border-foreground/10 px-1 pb-3 sm:mt-4 sm:px-2">
            <p className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Roster
            </p>
            <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
              <span className="font-mono tabular text-foreground">
                {formatNumber(total)}
              </span>{" "}
              of{" "}
              <span className="font-mono tabular">
                {formatNumber(totalAll)}
              </span>
            </p>
          </div>

          {showSkeleton ? (
            <CatalogSkeleton count={12} />
          ) : showEmpty ? (
            <EmptyState onReset={activeCount > 0 ? onClear : undefined} />
          ) : (
            <>
              <motion.ul
                key={urlFilterKey}
                variants={LIST_VARIANTS}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3"
              >
                <AnimatePresence initial={false}>
                  {fighters.map((f, i) => (
                    <motion.li
                      key={f.id}
                      variants={ROW_VARIANTS}
                      layout="position"
                      className="list-none"
                    >
                      <FighterCard
                        fighter={f}
                        rank={i + 1}
                        showRank={showRank}
                        priority={i < 4}
                        scoreMode={
                          filters.sort === "vertex_all_time"
                            ? "all_time"
                            : "current"
                        }
                      />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </motion.ul>

              <div className="mt-10 flex flex-col items-center gap-3 text-center">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle tabular">
                  Loaded {formatNumber(fighters.length)} of{" "}
                  {formatNumber(total)}
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
                <div ref={sentinelRef} aria-hidden className="h-1 w-full" />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const LIST_VARIANTS = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 },
  },
};

const ROW_VARIANTS = {
  hidden: { opacity: 0, y: 4 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeOut" as const },
  },
};
