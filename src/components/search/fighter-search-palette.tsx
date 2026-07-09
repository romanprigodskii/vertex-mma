"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";

import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { clampHeadline, headlineScore } from "@/lib/vertex-tier";

const OPEN_EVENT = "fighter-search:open";

/** Imperative trigger any client component can call to open the palette. */
export function openFighterSearch(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface SearchResult {
  id: string;
  slug: string;
  name_en: string;
  nickname: string | null;
  weight_class_primary: string | null;
  country_code: string | null;
  photo_thumbnail_url: string | null;
  roster_status: string | null;
  divisional_score: number | null;
  vertex_score: number | null;
  vertex_score_all_time: number | null;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

/** Avatar placeholder initials: first letter of the first + last name token,
 *  uppercased. Skips leading punctuation/quotes (common in nicknames), falls
 *  back to a single letter for one-word names, and to "?" when there's no
 *  usable glyph — so we never render a stray space, quote, or half a name. */
function getInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const firstLetter = (token: string | undefined): string =>
    token?.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const first = firstLetter(tokens[0]);
  const last = firstLetter(tokens[tokens.length - 1]);
  const initials = tokens.length > 1 ? first + last : first;
  return (initials || "?").toUpperCase();
}

const WEIGHT_KEYS = new Set([
  "strawweight",
  "flyweight",
  "bantamweight",
  "featherweight",
  "lightweight",
  "welterweight",
  "middleweight",
  "light_heavyweight",
  "heavyweight",
  "catchweight",
  "openweight",
]);

function useWeightLabel() {
  const tWeight = useTranslations("weight");
  return (wc: string | null): string => {
    if (!wc) return "";
    return WEIGHT_KEYS.has(wc)
      ? tWeight(wc as "strawweight")
      : wc;
  };
}

/** Locale-aware country label for the result subtitle (same idea as
 *  PhysicalInfo's countryName, memoized per locale for the results list).
 *  style: "short" keeps the CSS-uppercased line compact — "США"/"Британия"
 *  on ru, "US"/"UK" on en. Falls back to the raw ISO code whenever the
 *  runtime can't resolve it. */
function useCountryName() {
  const locale = useLocale();
  const displayNames = React.useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], {
        type: "region",
        style: "short",
      });
    } catch {
      return null;
    }
  }, [locale]);
  return React.useCallback(
    (code: string | null): string | null => {
      if (!code) return null;
      try {
        return displayNames?.of(code) || code;
      } catch {
        return code;
      }
    },
    [displayNames],
  );
}

export function FighterSearchPalette() {
  const t = useTranslations("search");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const weightLabel = useWeightLabel();
  const countryName = useCountryName();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  // Distinguish a failed request from a genuinely empty result set so we don't
  // tell the user "no matches" when the search itself is broken. `reloadKey`
  // lets the Retry button re-run the effect without changing the query.
  const [error, setError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);

  // Global open event + Cmd/Ctrl+K hotkey.
  React.useEffect(() => {
    function handleOpen() {
      setOpen(true);
    }
    function handleKey(e: KeyboardEvent) {
      const isCmdK =
        e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey;
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener(OPEN_EVENT, handleOpen);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, handleOpen);
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  // Reset state every time the palette opens — don't surprise the user
  // with stale results from the last session.
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setActiveIdx(0);
      setError(false);
    }
  }, [open]);

  // Debounced search against /api/fighters.
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setActiveIdx(0);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/fighters?q=${encodeURIComponent(q)}&limit=10&status=all&sort=vertex_current&locale=${locale}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          setResults([]);
          setError(true);
          return;
        }
        const json = (await res.json()) as { fighters?: SearchResult[] };
        setResults(json.fighters ?? []);
        setActiveIdx(0);
        setError(false);
      } catch (e) {
        // Abort = a newer keystroke superseded us; not a real failure.
        if ((e as Error).name !== "AbortError") {
          setResults([]);
          setError(true);
        }
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, open, reloadKey, locale]);

  function navigateTo(slug: string) {
    setOpen(false);
    router.push(`/fighters/${slug}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) navigateTo(r.slug);
    }
  }

  // Scroll active item into view as the user arrows.
  React.useEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const li = ul.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (li) li.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background-base/80 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[12%] z-50 w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 sm:top-[18%]",
            "overflow-hidden rounded-lg border border-foreground/15 bg-background-elevated/95 shadow-elevation-2 backdrop-blur",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("title")}
          </DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-foreground/10 px-4 py-3">
            <Search
              className="h-4 w-4 shrink-0 text-foreground-subtle"
              aria-hidden
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("placeholder")}
              className="w-full bg-transparent font-sans text-base text-foreground outline-none placeholder:text-foreground-subtle"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("triggerAria")}
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {query.trim().length === 0 ? (
              <EmptyHint />
            ) : loading && results.length === 0 ? (
              <p className="px-4 py-8 text-center font-sans text-sm text-foreground-subtle">
                {t("searching")}
              </p>
            ) : error ? (
              <div className="px-4 py-8 text-center">
                <p className="font-sans text-sm text-foreground-muted">
                  {t("unavailable")}
                </p>
                <button
                  type="button"
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="mt-3 inline-flex items-center rounded-sm border border-foreground/20 px-3 py-1.5 font-sans text-sm text-foreground-muted transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {tCommon("retry")}
                </button>
              </div>
            ) : results.length === 0 ? (
              <p className="px-4 py-8 text-center font-sans text-sm text-foreground-subtle">
                {t("noMatches", { query: query.trim() })}
              </p>
            ) : (
              <ul ref={listRef} className="py-1">
                {results.map((r, i) => (
                  <li
                    key={r.id}
                    data-idx={i}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors",
                      i === activeIdx
                        ? "bg-foreground/[0.06]"
                        : "hover:bg-foreground/[0.04]",
                    )}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => navigateTo(r.slug)}
                  >
                    {r.photo_thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.photo_thumbnail_url}
                        alt={r.name_en}
                        className="h-9 w-9 shrink-0 rounded-full border border-foreground/15 object-cover"
                      />
                    ) : (
                      <div
                        aria-hidden
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-mono text-[11px] uppercase text-foreground-subtle"
                      >
                        {getInitials(r.name_en)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-sans text-sm text-foreground">
                        {r.name_en}
                        {r.nickname ? (
                          <span className="ml-1 text-foreground-subtle">
                            “{r.nickname}”
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                        {weightLabel(r.weight_class_primary)}
                        {r.country_code
                          ? ` · ${countryName(r.country_code)}`
                          : ""}
                      </p>
                    </div>
                    <span className="shrink-0 font-display tabular text-lg leading-none text-foreground-muted">
                      {clampHeadline(
                        headlineScore({
                          rosterStatus: r.roster_status,
                          divisionalScore: r.divisional_score,
                          vertexScore: r.vertex_score,
                          vertexScoreAllTime: r.vertex_score_all_time,
                        }).value,
                      ) ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Footer />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function EmptyHint() {
  const t = useTranslations("search");
  return (
    <div className="px-4 py-8 text-center">
      <p className="font-sans text-sm text-foreground-muted">
        {t("emptyHint")}
      </p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {t("shortcuts")}
      </p>
    </div>
  );
}

function Footer() {
  const t = useTranslations("search");
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(isMac()), []);
  return (
    <div className="flex items-center justify-between border-t border-foreground/10 px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
      <span className="inline-flex items-center gap-1.5">
        <kbd className="rounded-sm border border-foreground/15 bg-background-overlay px-1.5 py-0.5 text-foreground-muted">
          {mac ? "⌘" : "Ctrl"}
        </kbd>
        <kbd className="rounded-sm border border-foreground/15 bg-background-overlay px-1.5 py-0.5 text-foreground-muted">
          K
        </kbd>
        <span>{t("opensAnywhere")}</span>
      </span>
      <span>{t("footerBrand")}</span>
    </div>
  );
}

interface TriggerProps {
  className?: string;
  /** Icon-only variant for tight nav slots. */
  iconOnly?: boolean;
}

export function FighterSearchTrigger({
  className,
  iconOnly = false,
}: TriggerProps) {
  const t = useTranslations("search");
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(isMac()), []);
  return (
    <button
      type="button"
      onClick={() => openFighterSearch()}
      aria-label={t("triggerAria")}
      className={cn(
        "group inline-flex items-center gap-2 rounded-md border border-foreground/15 bg-background-elevated/40 px-3 py-1.5 font-sans text-sm text-foreground-muted transition-colors",
        "hover:border-foreground/30 hover:bg-foreground/[0.05] hover:text-foreground",
        className,
      )}
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      {iconOnly ? (
        <span className="sr-only">{t("trigger")}</span>
      ) : (
        <>
          <span>{t("trigger")}</span>
          <kbd className="hidden rounded-sm border border-foreground/15 bg-background-overlay px-1 py-px font-mono text-[10px] text-foreground-subtle md:inline-block">
            {mac ? "⌘" : "Ctrl"}K
          </kbd>
        </>
      )}
    </button>
  );
}
