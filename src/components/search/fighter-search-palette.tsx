"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

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
  vertex_score: number | null;
  vertex_score_all_time: number | null;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

const WEIGHT_LABEL: Record<string, string> = {
  strawweight: "Strawweight",
  flyweight: "Flyweight",
  bantamweight: "Bantamweight",
  featherweight: "Featherweight",
  lightweight: "Lightweight",
  welterweight: "Welterweight",
  middleweight: "Middleweight",
  light_heavyweight: "Light Heavyweight",
  heavyweight: "Heavyweight",
  catchweight: "Catchweight",
  openweight: "Openweight",
};

function weightLabel(wc: string | null): string {
  if (!wc) return "";
  return WEIGHT_LABEL[wc] ?? wc;
}

export function FighterSearchPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
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
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/fighters?q=${encodeURIComponent(q)}&limit=10&status=all&sort=vertex_current`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          setResults([]);
          return;
        }
        const json = (await res.json()) as { fighters?: SearchResult[] };
        setResults(json.fighters ?? []);
        setActiveIdx(0);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, open]);

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
            "fixed left-1/2 top-[18%] z-50 w-full max-w-xl -translate-x-1/2",
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
            Find a fighter
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
              placeholder="Find a fighter…"
              className="w-full bg-transparent font-sans text-base text-foreground outline-none placeholder:text-foreground-subtle"
              autoComplete="off"
              spellCheck={false}
              aria-label="Find a fighter"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {query.trim().length === 0 ? (
              <EmptyHint />
            ) : loading && results.length === 0 ? (
              <p className="px-4 py-8 text-center font-sans text-sm text-foreground-subtle">
                Searching…
              </p>
            ) : results.length === 0 ? (
              <p className="px-4 py-8 text-center font-sans text-sm text-foreground-subtle">
                No fighter matches “{query.trim()}”.
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
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-full border border-foreground/15 object-cover"
                      />
                    ) : (
                      <div
                        aria-hidden
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-mono text-[11px] uppercase text-foreground-subtle"
                      >
                        {r.name_en.slice(0, 2)}
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
                        {r.country_code ? ` · ${r.country_code}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 font-display tabular text-lg leading-none text-foreground-muted">
                      {r.vertex_score ?? r.vertex_score_all_time ?? "—"}
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
  return (
    <div className="px-4 py-8 text-center">
      <p className="font-sans text-sm text-foreground-muted">
        Type a fighter name to search the roster.
      </p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        ↑ ↓ to navigate · enter to open · esc to close
      </p>
    </div>
  );
}

function Footer() {
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
        <span>opens this anywhere</span>
      </span>
      <span>Vertex search</span>
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
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(isMac()), []);
  return (
    <button
      type="button"
      onClick={() => openFighterSearch()}
      aria-label="Find a fighter"
      className={cn(
        "group inline-flex items-center gap-2 rounded-md border border-foreground/15 bg-background-elevated/40 px-3 py-1.5 font-sans text-sm text-foreground-muted transition-colors",
        "hover:border-foreground/30 hover:bg-foreground/[0.05] hover:text-foreground",
        className,
      )}
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      {iconOnly ? (
        <span className="sr-only">Find</span>
      ) : (
        <>
          <span>Find</span>
          <kbd className="hidden rounded-sm border border-foreground/15 bg-background-overlay px-1 py-px font-mono text-[10px] text-foreground-subtle md:inline-block">
            {mac ? "⌘" : "Ctrl"}K
          </kbd>
        </>
      )}
    </button>
  );
}
