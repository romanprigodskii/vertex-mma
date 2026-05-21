"use client";

import * as React from "react";

import {
  type PickerFighter,
  searchFightersForPicker,
} from "@/app/cards/actions";
import { formatWeightClass } from "@/lib/card-theme";

export type BoutFighter = {
  id: string;
  name: string;
  photo_thumbnail_url: string | null;
};

interface Props {
  label: string;
  fighter: BoutFighter | null;
  onPick: (f: PickerFighter) => void;
  onClear: () => void;
  excludedIds: string[];
}

/** One fighter slot in a bout — a filled chip, or an inline fuzzy search. */
export function FighterSlotPicker({
  label,
  fighter,
  onPick,
  onClear,
  excludedIds,
}: Props) {
  if (fighter) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-foreground/15 bg-background-elevated/40 p-2">
        {fighter.photo_thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={fighter.photo_thumbnail_url}
            alt=""
            className="h-9 w-9 shrink-0 rounded-sm object-cover"
          />
        ) : (
          <div
            className="h-9 w-9 shrink-0 rounded-sm bg-foreground/[0.06]"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 truncate font-sans text-sm text-foreground">
          {fighter.name}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05]"
          aria-label={`Remove ${label}`}
        >
          ✕
        </button>
      </div>
    );
  }
  return (
    <SlotSearch label={label} onPick={onPick} excludedIds={excludedIds} />
  );
}

function SlotSearch({
  label,
  onPick,
  excludedIds,
}: {
  label: string;
  onPick: (f: PickerFighter) => void;
  excludedIds: string[];
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PickerFighter[]>([]);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    // The cleanup flips `cancelled` on the next keystroke / unmount, so a
    // slow request that resolves after the input moved on is discarded.
    let cancelled = false;
    const t = setTimeout(async () => {
      setPending(true);
      try {
        const r = await searchFightersForPicker(trimmed);
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setPending(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const excluded = new Set(excludedIds);
  const visible = query.trim()
    ? results.filter((r) => !excluded.has(r.id))
    : [];

  return (
    <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 p-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`${label} — search…`}
        className="w-full rounded-sm border border-foreground/15 bg-background-base px-2.5 py-1.5 font-sans text-sm text-foreground placeholder:text-foreground-subtle focus:border-primary focus:outline-none"
      />
      {pending && query.trim() ? (
        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          Searching…
        </p>
      ) : null}
      {visible.length > 0 ? (
        <ul className="mt-1.5 flex max-h-56 flex-col overflow-y-auto">
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setQuery("");
                  setResults([]);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left hover:bg-foreground/[0.06]"
              >
                {r.photo_thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.photo_thumbnail_url}
                    alt=""
                    className="h-7 w-7 rounded-sm object-cover"
                  />
                ) : (
                  <div
                    className="h-7 w-7 rounded-sm bg-foreground/[0.06]"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-sm text-foreground">
                    {r.name}
                  </span>
                  {r.weight_class ? (
                    <span className="block font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                      {formatWeightClass(r.weight_class)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
