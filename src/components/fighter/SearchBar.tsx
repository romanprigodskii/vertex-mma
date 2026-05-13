"use client";

import * as React from "react";
import { Loader2, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  placeholder?: string;
  className?: string;
}

export function SearchBar({
  value,
  onChange,
  loading = false,
  placeholder = "Search by name, nickname…",
  className,
}: SearchBarProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);

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
        placeholder={placeholder}
        className={cn(
          "h-full w-full bg-transparent pl-10 pr-10 text-sm text-foreground",
          "placeholder:text-foreground-subtle",
          "focus:outline-none",
          "[&::-webkit-search-cancel-button]:hidden",
          "[&::-webkit-search-decoration]:hidden",
        )}
        aria-label="Search fighters"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="absolute right-2 flex items-center gap-1">
        {loading ? (
          <Loader2
            aria-hidden
            className="h-4 w-4 animate-spin text-foreground-subtle"
          />
        ) : null}
        {value && !loading ? (
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle hover:bg-background-elevated hover:text-foreground transition-colors"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
