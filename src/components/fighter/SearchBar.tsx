"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  /** Total matches for the current query. When a search settles this is
   *  announced once via a polite live region (instead of re-announcing
   *  "Searching" on every keystroke). */
  resultsCount?: number;
  placeholder?: string;
  className?: string;
}

export function SearchBar({
  value,
  onChange,
  loading = false,
  resultsCount,
  placeholder,
  className,
}: SearchBarProps) {
  const t = useTranslations("catalog");
  const tSearch = useTranslations("search");
  const effectivePlaceholder = placeholder ?? t("searchPlaceholder");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Announce only the SETTLED result count, derived purely from props so no
  // effect/state is needed: while a fetch is in flight (or the box is empty)
  // the region is blank, and it fills with the count once the search resolves.
  // Polite live regions announce on content *change*, so this fires once per
  // completed search rather than on each character typed.
  const announcement =
    value.trim() !== "" && !loading && resultsCount != null
      ? tSearch("resultsFound", { n: resultsCount })
      : "";

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && value) {
      event.preventDefault();
      onChange("");
    }
  };

  const handleClear = () => {
    onChange("");
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn(
        "relative flex h-11 w-full items-center rounded-md border border-border bg-background-base",
        "focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30",
        "transition-colors duration-150",
        className,
      )}
    >
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 h-4 w-4 text-foreground-subtle"
      />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={effectivePlaceholder}
        className={cn(
          "h-full w-full bg-transparent pl-10 pr-12 text-sm text-foreground",
          "placeholder:text-foreground-subtle",
          "focus:outline-none",
          "[&::-webkit-search-cancel-button]:hidden",
          "[&::-webkit-search-decoration]:hidden",
        )}
        aria-label={t("searchAria")}
        autoComplete="off"
        spellCheck={false}
      />
      {/* Single, stable polite live region — announces the settled result
          count, never the transient "Searching" state. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <div className="absolute right-2 flex items-center gap-1.5">
        {loading ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
          />
        ) : null}
        {value ? (
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle hover:bg-background-elevated hover:text-foreground transition-colors"
            aria-label={t("clearSearch")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
