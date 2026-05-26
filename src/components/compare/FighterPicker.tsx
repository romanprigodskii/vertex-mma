"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Search, X } from "lucide-react";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { Button } from "@/components/ui/button";
import type {
  FighterCatalogResponse,
  FighterCatalogRow,
} from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

interface PickerSlot {
  slug: string | null;
  name: string | null;
}

interface FighterPickerProps {
  initialA: PickerSlot;
  initialB: PickerSlot;
}

interface PickerInputProps {
  label: string;
  slot: PickerSlot;
  onSelect: (slot: PickerSlot) => void;
  onClear: () => void;
}

function PickerInput({ label, slot, onSelect, onClear }: PickerInputProps) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<FighterCatalogRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  // Debounced query → /api/fighters
  React.useEffect(() => {
    if (slot.slug) return; // already picked
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        // status=all so retired legends (Khabib, GSP…) show up; the API
        // otherwise defaults to active-roster only. sort=vertex_all_time
        // surfaces the greats at the top of fuzzy-matched results.
        const r = await fetch(
          `/api/fighters?q=${encodeURIComponent(trimmed)}&limit=8&status=all&sort=vertex_all_time`,
          { signal: ctrl.signal },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: FighterCatalogResponse = await r.json();
        setResults(data.fighters);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [query, slot.slug]);

  // Click outside closes dropdown
  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (slot.slug && slot.name) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          {label}
        </label>
        <div className="flex h-12 items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/[0.06] px-3">
          <span className="truncate font-sans font-bold text-base uppercase tracking-tight text-foreground">
            {slot.name}
          </span>
          <button
            type="button"
            onClick={() => {
              onClear();
              setQuery("");
              setResults([]);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle hover:bg-foreground/5 hover:text-foreground transition-colors"
            aria-label={`Clear ${label}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="flex flex-col gap-1.5">
      <label className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search fighter by name…"
          className={cn(
            "h-12 w-full rounded-md border border-border bg-background-base pl-10 pr-10 text-sm text-foreground",
            "placeholder:text-foreground-subtle",
            "focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30",
            "transition-colors",
            "[&::-webkit-search-cancel-button]:hidden",
            "[&::-webkit-search-decoration]:hidden",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        {loading ? (
          <Loader2
            aria-hidden
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-foreground-subtle"
          />
        ) : null}

        {open && results.length > 0 ? (
          <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-foreground/15 bg-background-overlay shadow-elevation-2">
            {results.map((f) => (
              <li key={f.slug}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect({ slug: f.slug, name: f.name_en });
                    setOpen(false);
                    setResults([]);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04]"
                >
                  <FighterAvatar
                    name={f.name_en}
                    photoUrl={f.photo_url}
                    size="sm"
                    imageSizes="48px"
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-sans text-sm text-foreground">
                      {f.name_en}
                    </span>
                    <span className="flex items-center gap-1.5 font-sans text-[11px] text-foreground-subtle">
                      <span className="font-mono tabular">
                        {f.wins_total}-{f.losses_total}
                      </span>
                      {f.weight_class_primary ? (
                        <>
                          <span aria-hidden className="text-foreground-subtle/40">
                            ·
                          </span>
                          <span className="uppercase tracking-widest">
                            {f.weight_class_primary.replace(/_/g, " ")}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function FighterPicker({ initialA, initialB }: FighterPickerProps) {
  const router = useRouter();
  const [a, setA] = React.useState<PickerSlot>(initialA);
  const [b, setB] = React.useState<PickerSlot>(initialB);

  const canCompare =
    a.slug != null && b.slug != null && a.slug !== b.slug;

  const onCompare = () => {
    if (!canCompare) return;
    router.push(`/fighters/compare?a=${a.slug}&b=${b.slug}`);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
        <PickerInput
          label="Fighter A"
          slot={a}
          onSelect={setA}
          onClear={() => setA({ slug: null, name: null })}
        />
        <PickerInput
          label="Fighter B"
          slot={b}
          onSelect={setB}
          onClear={() => setB({ slug: null, name: null })}
        />
      </div>
      <div className="flex flex-col items-center gap-2">
        <Button
          onClick={onCompare}
          disabled={!canCompare}
          size="lg"
          className="w-full max-w-xs"
        >
          Compare
          <ArrowRight className="h-4 w-4" />
        </Button>
        {a.slug && b.slug && a.slug === b.slug ? (
          <p className="font-sans text-xs text-foreground-muted">
            Pick two different fighters.
          </p>
        ) : null}
      </div>
    </div>
  );
}
