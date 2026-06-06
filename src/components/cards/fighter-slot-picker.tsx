"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import {
  type PickerFighter,
  searchFightersForPicker,
} from "@/app/[locale]/cards/actions";
import { formatWeightClass } from "@/lib/card-theme";
import { cn } from "@/lib/utils";

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
  /** Outline the empty slot in red — set when a submit was blocked because
   *  this slot has no fighter. */
  invalid?: boolean;
}

/** One fighter slot in a bout — a filled chip, or an inline fuzzy search. */
export function FighterSlotPicker({
  label,
  fighter,
  onPick,
  onClear,
  excludedIds,
  invalid = false,
}: Props) {
  const t = useTranslations("cards");
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
          aria-label={t("removeSlotAria", { label })}
        >
          ✕
        </button>
      </div>
    );
  }
  return (
    <SlotSearch
      label={label}
      onPick={onPick}
      excludedIds={excludedIds}
      invalid={invalid}
    />
  );
}

function SlotSearch({
  label,
  onPick,
  excludedIds,
  invalid,
}: {
  label: string;
  onPick: (f: PickerFighter) => void;
  excludedIds: string[];
  invalid: boolean;
}) {
  const t = useTranslations("cards");
  const tSearch = useTranslations("search");
  const tWeight = useTranslations("weight");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PickerFighter[]>([]);
  // The query that `results` currently reflect. Comparing it to the live query
  // tells us whether the search for what's typed has settled — so we never
  // flash "no results" mid-debounce, and a cancelled in-flight request can't
  // strand the "Searching…" indicator.
  const [resultsQuery, setResultsQuery] = React.useState("");

  React.useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    // The cleanup flips `cancelled` on the next keystroke / unmount, so a
    // slow request that resolves after the input moved on is discarded.
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await searchFightersForPicker(trimmed);
        if (!cancelled) {
          setResults(r);
          setResultsQuery(trimmed);
        }
      } catch {
        // Treat a failed lookup as "no matches" so the box settles to an
        // empty state instead of spinning forever.
        if (!cancelled) {
          setResults([]);
          setResultsQuery(trimmed);
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const trimmedQuery = query.trim();
  const excluded = new Set(excludedIds);
  const visible = trimmedQuery
    ? results.filter((r) => !excluded.has(r.id))
    : [];
  // A search has "settled" once `results` reflect exactly what's typed.
  const settled = resultsQuery === trimmedQuery;
  const searching = trimmedQuery.length > 0 && !settled;
  const showEmpty = trimmedQuery.length > 0 && settled && visible.length === 0;
  // Matches existed but every one is already booked elsewhere on the card.
  const allAlreadyAdded = showEmpty && results.length > 0;

  return (
    <div
      className={cn(
        "rounded-md border border-dashed bg-background-elevated/20 p-2",
        invalid ? "border-streak-loss/60" : "border-foreground/15",
      )}
    >
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("slotPlaceholder", { label })}
        className="w-full rounded-sm border border-foreground/15 bg-background-base px-2.5 py-1.5 font-sans text-sm text-foreground placeholder:text-foreground-subtle focus:border-primary focus:outline-none"
      />
      {searching ? (
        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {tSearch("searching")}
        </p>
      ) : null}
      {showEmpty ? (
        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {allAlreadyAdded ? t("slotAllAdded") : t("slotNoResults")}
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
                      {(() => {
                        const key = r.weight_class.replace(/-/g, "_");
                        return tWeight.has(key)
                          ? tWeight(key as "lightweight")
                          : formatWeightClass(r.weight_class);
                      })()}
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
