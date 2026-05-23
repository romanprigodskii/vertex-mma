"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";

import {
  type PickerFighter,
  searchFightersForPicker,
} from "@/app/rankings/actions";
import { FighterResultCard } from "@/components/fighter/fighter-result-card";

/**
 * Site-wide fighter search reachable from the navbar. Opens a Radix dialog
 * with a debounced search input + rich result cards (photo, weight class,
 * record, all-time Vertex score). Results are ordered by all-time score
 * server-side so the most-canonical fighter for the query lands first.
 */
export function NavbarSearch() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PickerFighter[]>([]);
  const [pending, setPending] = React.useState(false);
  const queryRef = React.useRef(query);
  queryRef.current = query;

  React.useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const snap = query;
    const t = setTimeout(async () => {
      setPending(true);
      try {
        const r = await searchFightersForPicker(snap);
        if (queryRef.current === snap) setResults(r);
      } finally {
        if (queryRef.current === snap) setPending(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [query]);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="Find a fighter"
          className="hidden h-9 items-center gap-1.5 rounded-md border border-foreground/15 bg-background-elevated px-3 transition-colors hover:border-foreground/30 sm:inline-flex"
        >
          <Search className="h-4 w-4 text-foreground-subtle" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-widest text-foreground-muted">
            Find
          </span>
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[12%] z-50 w-[92vw] max-w-2xl -translate-x-1/2">
          <DialogPrimitive.Title className="sr-only">
            Find a fighter
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search the UFC roster by name, nickname, or alias.
          </DialogPrimitive.Description>
          <div className="overflow-hidden rounded-md border border-foreground/15 bg-background-base shadow-2xl">
            <div className="flex items-center gap-2 border-b border-foreground/[0.08] px-4 py-3">
              <Search
                className="h-4 w-4 text-foreground-subtle"
                aria-hidden
              />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a fighter…"
                className="flex-1 bg-transparent font-sans text-base text-foreground placeholder:text-foreground-subtle focus:outline-none"
              />
              <DialogPrimitive.Close
                aria-label="Close search"
                className="text-foreground-subtle hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {pending ? (
                <p className="px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                  Searching…
                </p>
              ) : results.length > 0 ? (
                <ul className="flex flex-col gap-1.5 p-2">
                  {results.map((r) => (
                    <li key={r.id}>
                      <FighterResultCard
                        fighter={r}
                        href={`/fighters/${r.slug}`}
                        onClick={() => setOpen(false)}
                      />
                    </li>
                  ))}
                </ul>
              ) : query.trim() ? (
                <p className="px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                  No fighters found.
                </p>
              ) : (
                <p className="px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                  Type a name, nickname, or alias to search the UFC roster.
                </p>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
