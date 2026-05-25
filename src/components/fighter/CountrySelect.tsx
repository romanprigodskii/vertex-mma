"use client";

import * as React from "react";
import { Check, Search } from "lucide-react";

import { getCountryFlag } from "@/lib/fighter-helpers";
import type { CountryAggregate } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

interface CountrySelectProps {
  countries: CountryAggregate[];
  selected: string[];
  onToggle: (code: string) => void;
  /** Number of country chips shown collapsed before "Show more". */
  topN?: number;
}

export function CountrySelect({
  countries,
  selected,
  onToggle,
  topN = 12,
}: CountrySelectProps) {
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);

  const visibleCountries = React.useMemo(() => {
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return countries.filter((c) => c.code.toLowerCase().includes(q));
    }
    if (expanded) return countries;
    // Show topN + any currently-selected codes that aren't in topN.
    const top = countries.slice(0, topN);
    const topCodes = new Set(top.map((c) => c.code));
    const extras = countries.filter(
      (c) => selected.includes(c.code) && !topCodes.has(c.code),
    );
    return [...top, ...extras];
  }, [countries, query, expanded, selected, topN]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find country…"
          className={cn(
            "type-body h-7 w-full rounded-sm border border-edge bg-surface-base pl-7 pr-2 text-[11px] text-fg",
            "placeholder:text-fg-subtle",
            "focus:outline-none focus:border-edge-strong focus:ring-1 focus:ring-fg/20",
            "transition-colors duration-(--motion-fast) ease-out-soft",
          )}
          aria-label="Search countries"
        />
      </div>

      <ul className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
        {visibleCountries.length === 0 ? (
          <li className="type-body px-1 py-2 text-xs text-fg-subtle">
            No match
          </li>
        ) : (
          visibleCountries.map((c) => {
            const isActive = selected.includes(c.code);
            return (
              <li key={c.code}>
                <button
                  type="button"
                  onClick={() => onToggle(c.code)}
                  aria-pressed={isActive}
                  className={cn(
                    "type-body flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors duration-(--motion-fast) ease-out-soft",
                    isActive
                      ? "bg-fg/[0.08] text-fg"
                      : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                      isActive
                        ? "border-fg bg-fg text-surface-base"
                        : "border-edge-strong",
                    )}
                    aria-hidden
                  >
                    {isActive ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span aria-hidden className="text-sm">
                    {getCountryFlag(c.code)}
                  </span>
                  <span className="font-mono uppercase tracking-wider">
                    {c.code}
                  </span>
                  <span className="ml-auto font-mono text-[10px] tabular text-fg-subtle">
                    {c.count}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>

      {!query.trim() && countries.length > topN ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="type-body text-xs text-fg-muted transition-colors duration-(--motion-fast) ease-out-soft hover:text-fg"
        >
          {expanded
            ? "Show less"
            : `Show all ${countries.length} countries`}
        </button>
      ) : null}
    </div>
  );
}
