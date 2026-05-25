"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

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
        "relative flex h-11 w-full items-center rounded-md border border-edge bg-surface-base",
        "focus-within:border-edge-strong focus-within:ring-2 focus-within:ring-fg/20",
        "transition-colors duration-(--motion-fast) ease-out-soft",
        className,
      )}
    >
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 h-4 w-4 text-fg-subtle"
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
          "type-body h-full w-full bg-transparent pl-10 pr-12 text-sm text-fg",
          "placeholder:text-fg-subtle",
          "focus:outline-none",
          "[&::-webkit-search-cancel-button]:hidden",
          "[&::-webkit-search-decoration]:hidden",
        )}
        aria-label="Search fighters"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="absolute right-2 flex items-center gap-1.5">
        {loading ? (
          <span
            aria-label="Searching"
            role="status"
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg"
          />
        ) : null}
        {value ? (
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05] hover:text-fg"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
