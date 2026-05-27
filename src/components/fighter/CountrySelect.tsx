"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("catalog");
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
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("findCountry")}
          className={cn(
            "h-7 w-full rounded-sm border border-foreground/10 bg-background-base pl-7 pr-2 text-[11px] text-foreground",
            "placeholder:text-foreground-subtle",
            "focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/40",
            "transition-colors",
          )}
          aria-label={t("searchCountriesAria")}
        />
      </div>

      <ul className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
        {visibleCountries.length === 0 ? (
          <li className="px-1 py-2 text-xs text-foreground-subtle">{t("noMatch")}</li>
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
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                    isActive
                      ? "bg-primary/15 text-foreground"
                      : "text-foreground-muted hover:bg-background-elevated hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border-strong",
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
                  <span className="ml-auto font-mono text-[10px] text-foreground-subtle tabular">
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
          className="text-xs text-foreground-muted hover:text-foreground transition-colors"
        >
          {expanded
            ? t("showLess")
            : t("showAllN", { n: countries.length })}
        </button>
      ) : null}
    </div>
  );
}
