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
    if (!open) return;
    const snap = query;
    // Empty query (initial open) loads top-by-all-time suggestions
    // immediately; user typing gets a short debounce.
    const delay = snap.trim() ? 180 : 0;
    const t = setTimeout(async () => {
      setPending(true);
      try {
        const r = await searchFightersForPicker(snap);
        if (queryRef.current === snap) setResults(r);
      } finally {
        if (queryRef.current === snap) setPending(false);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [query, open]);

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
          className="hidden h-9 items-center gap-1.5 rounded-md border border-edge bg-surface-elevated px-3 transition-colors duration-(--motion-fast) ease-out-soft hover:border-edge-strong sm:inline-flex"
        >
          <Search className="h-4 w-4 text-fg-subtle" aria-hidden />
          <span className="type-meta text-[11px] text-fg-muted">Find</span>
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
          <div className="overflow-hidden rounded-md border border-edge-strong bg-surface-base shadow-2xl">
            <div className="flex items-center gap-2 border-b border-fg/[0.08] px-4 py-3">
              <Search
                className="h-4 w-4 text-fg-subtle"
                aria-hidden
              />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a fighter…"
                className="type-body flex-1 bg-transparent text-base text-fg placeholder:text-fg-subtle focus:outline-none"
              />
              <DialogPrimitive.Close
                aria-label="Close search"
                className="text-fg-subtle transition-colors duration-(--motion-fast) ease-out-soft hover:text-fg"
              >
                <X className="h-4 w-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {pending ? (
                <p className="type-meta px-2 py-1 text-[11px] text-fg-subtle">
                  Searching…
                </p>
              ) : results.length > 0 ? (
                <>
                  {!query.trim() ? (
                    <p className="type-meta mb-1.5 px-1 text-[10px] text-fg-subtle">
                      Top fighters · all-time
                    </p>
                  ) : null}
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
                </>
              ) : query.trim() ? (
                <p className="type-meta px-2 py-1 text-[11px] text-fg-subtle">
                  No fighters found.
                </p>
              ) : (
                <p className="type-meta px-2 py-1 text-[11px] text-fg-subtle">
                  Type to find any fighter on the UFC roster.
                </p>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
