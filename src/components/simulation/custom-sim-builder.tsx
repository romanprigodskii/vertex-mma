"use client";

import { Check, ChevronDown, Loader2, Swords, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { createCustomSimulationAction } from "@/app/[locale]/simulation/actions";
import { Link, useRouter } from "@/i18n/navigation";
import type { FormPickerBout } from "@/lib/custom-simulation";
import { cn } from "@/lib/utils";

type PickedFighter = {
  id: string;
  slug: string;
  name_en: string;
  photo_thumbnail_url: string | null;
};

const ERROR_KEYS: Record<string, string> = {
  NOT_SIGNED_IN: "errNotSignedIn",
  RATE_LIMITED: "errRateLimited",
  INVALID_FIGHTER: "errInvalidFighter",
  SAME_FIGHTER: "errSameFighter",
  INVALID_BOUT: "errInvalidBout",
  MIXED_GENDER: "errMixedGender",
  NO_HISTORY: "errNoHistory",
  TOO_MANY_PENDING: "errTooManyPending",
};

interface CustomSimBuilderProps {
  isSignedIn: boolean;
}

/** Two-sided dream-fight builder: fighter autocomplete + a per-fighter
 *  "take form from this bout" picker (default = current form). Submits to
 *  createCustomSimulationAction and navigates to the result page. */
export function CustomSimBuilder({ isSignedIn }: CustomSimBuilderProps) {
  const t = useTranslations("customSim");
  const router = useRouter();
  const [a, setA] = useState<PickedFighter | null>(null);
  const [b, setB] = useState<PickedFighter | null>(null);
  const [boutA, setBoutA] = useState<string>("");
  const [boutB, setBoutB] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canSubmit =
    isSignedIn && a !== null && b !== null && a.id !== b.id && !pending;

  const submit = () => {
    if (!a || !b) return;
    setError(null);
    startTransition(async () => {
      const res = await createCustomSimulationAction(
        a.id,
        boutA || null,
        b.id,
        boutB || null,
      );
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.push(`/simulation/custom/${res.id}`);
    });
  };

  return (
    <div className="rounded-lg border border-foreground/10 bg-background-elevated/30 p-4 sm:p-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto_1fr] md:items-start">
        <SideColumn
          label={t("sideA")}
          picked={a}
          onPick={(f) => {
            setA(f);
            setBoutA("");
          }}
          boutId={boutA}
          onBout={setBoutA}
        />
        <div className="hidden select-none items-center justify-center pt-10 font-display text-3xl uppercase text-foreground-subtle md:flex">
          vs
        </div>
        <SideColumn
          label={t("sideB")}
          picked={b}
          onPick={(f) => {
            setB(f);
            setBoutB("");
          }}
          boutId={boutB}
          onBout={setBoutB}
        />
      </div>

      <div className="mt-6 flex flex-col items-center gap-3">
        {!isSignedIn && (
          <p className="text-center font-sans text-sm text-foreground-muted">
            <Link
              href="/signin?next=/simulation/custom"
              className="text-primary underline-offset-2 hover:underline"
            >
              {t("signInToRun")}
            </Link>
          </p>
        )}
        {a && b && a.id === b.id && (
          <p role="alert" className="font-sans text-sm text-danger">
            {t("errSameFighter")}
          </p>
        )}
        {error && (
          <p role="alert" className="font-sans text-sm text-danger">
            {t.has(ERROR_KEYS[error] as "errGeneric")
              ? t((ERROR_KEYS[error] ?? "errGeneric") as "errGeneric")
              : t("errGeneric")}
          </p>
        )}
        <button
          type="button"
          onClick={submit}
          data-umami-event="dream-fight-run"
          disabled={!canSubmit}
          className={cn(
            "inline-flex items-center gap-2 rounded-sm bg-primary px-6 py-2.5 font-display text-sm uppercase tracking-widest text-background-base transition-opacity",
            canSubmit ? "hover:opacity-90" : "cursor-not-allowed opacity-40",
          )}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Swords className="h-4 w-4" aria-hidden />
          )}
          {t("runSimulation")}
        </button>
      </div>
    </div>
  );
}

interface SideColumnProps {
  label: string;
  picked: PickedFighter | null;
  onPick: (f: PickedFighter | null) => void;
  boutId: string;
  onBout: (id: string) => void;
}

function SideColumn({ label, picked, onPick, boutId, onBout }: SideColumnProps) {
  const t = useTranslations("customSim");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedFighter[]>([]);
  const [open, setOpen] = useState(false);
  const [bouts, setBouts] = useState<FormPickerBout[]>([]);
  const [boutsLoading, setBoutsLoading] = useState(false);
  const queryRef = useRef(query);
  // Accepted project pattern (see lint memory): latest-value mirror so the
  // debounce closure can check staleness without re-subscribing.
  // eslint-disable-next-line react-hooks/refs
  queryRef.current = query;

  // Debounced fighter autocomplete (same /api/fighters contract as the
  // compare picker; status=all so retired legends surface).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- accepted pattern
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/fighters?q=${encodeURIComponent(q)}&limit=8&status=all&sort=vertex_all_time`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { fighters: PickedFighter[] };
        if (queryRef.current.trim() === q) {
          setResults(data.fighters);
          setOpen(true);
        }
      } catch {
        /* network hiccup — keep prior results */
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Load the form picker's bout list when a fighter is chosen.
  useEffect(() => {
    if (!picked) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- accepted pattern
      setBouts([]);
      return;
    }
    let cancelled = false;
    setBoutsLoading(true);
    fetch(`/api/fighters/bouts?fighter=${picked.id}`)
      .then((r) => (r.ok ? r.json() : { bouts: [] }))
      .then((data: { bouts: FormPickerBout[] }) => {
        if (!cancelled) setBouts(data.bouts);
      })
      .catch(() => {
        if (!cancelled) setBouts([]);
      })
      .finally(() => {
        if (!cancelled) setBoutsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  return (
    <div className="min-w-0">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle">
        {label}
      </p>

      {picked ? (
        <div className="flex items-center gap-3 rounded-md border border-foreground/15 bg-background-base/40 px-3 py-2.5">
          {picked.photo_thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={picked.photo_thumbnail_url}
              alt=""
              className="h-10 w-10 shrink-0 rounded object-cover object-top"
            />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-background-overlay font-display text-sm text-foreground-muted">
              {picked.name_en.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-display text-lg uppercase tracking-tight text-foreground">
            {picked.name_en}
          </span>
          <button
            type="button"
            aria-label={t("clearFighter")}
            onClick={() => {
              onPick(null);
              setQuery("");
            }}
            className="rounded p-1 text-foreground-subtle transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={t("searchPlaceholder")}
            className="w-full rounded-md border border-foreground/15 bg-background-base/40 px-3 py-2.5 font-sans text-sm text-foreground placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          {open && results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-foreground/15 bg-background-overlay shadow-elevation-2">
              {results.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onPick(f);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-sm text-foreground transition-colors hover:bg-foreground/[0.06]"
                  >
                    {f.photo_thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={f.photo_thumbnail_url}
                        alt=""
                        className="h-7 w-7 shrink-0 rounded object-cover object-top"
                      />
                    ) : (
                      <span className="h-7 w-7 shrink-0 rounded bg-background-elevated" />
                    )}
                    <span className="truncate">{f.name_en}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3">
        <span
          id={`form-label-${label}`}
          className="mb-1 block font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle"
        >
          {t("formLabel")}
        </span>
        <FormSelect
          labelId={`form-label-${label}`}
          boutId={boutId}
          onBout={onBout}
          bouts={bouts}
          disabled={!picked || boutsLoading}
          placeholder={boutsLoading ? t("loadingBouts") : t("currentForm")}
        />
      </div>
      <p className="mt-1.5 font-sans text-xs text-foreground-subtle">
        {t("formHint")}
      </p>
    </div>
  );
}

const RESULT_CLASS: Record<FormPickerBout["result"], string> = {
  W: "text-streak-win",
  L: "text-streak-loss",
  D: "text-foreground-muted",
};

/** Site-styled replacement for the native <select> (the OS dropdown looked
 *  alien next to the rest of the builder): button trigger + an absolute
 *  listbox matching the fighter-search dropdown above, with coloured W/L
 *  letters and a check on the active option. */
function FormSelect({
  labelId,
  boutId,
  onBout,
  bouts,
  disabled,
  placeholder,
}: {
  labelId: string;
  boutId: string;
  onBout: (id: string) => void;
  bouts: FormPickerBout[];
  disabled: boolean;
  placeholder: string;
}) {
  const t = useTranslations("customSim");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on any outside pointer press (same pattern as the navbar
  // notifications dropdown).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = bouts.find((b) => b.bout_id === boutId) ?? null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-foreground/15 bg-background-base/40 px-3 py-2.5 text-left font-sans text-sm text-foreground transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
      >
        <span className="min-w-0 truncate">
          {selected ? (
            <>
              <span className={cn("font-mono", RESULT_CLASS[selected.result])}>
                {selected.result}
              </span>
              {` · ${selected.opponent_name} `}
              <span className="text-foreground-subtle">
                · {selected.event_name} ({selected.date})
              </span>
            </>
          ) : (
            placeholder
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-foreground-subtle transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-labelledby={labelId}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-foreground/15 bg-background-overlay shadow-elevation-2"
        >
          <li role="option" aria-selected={boutId === ""}>
            <button
              type="button"
              onClick={() => {
                onBout("");
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-sm transition-colors hover:bg-foreground/[0.06]",
                boutId === "" ? "text-primary" : "text-foreground",
              )}
            >
              <Check
                className={cn("h-3.5 w-3.5 shrink-0", boutId !== "" && "invisible")}
                aria-hidden
              />
              {t("currentForm")}
            </button>
          </li>
          {bouts.map((bt) => {
            const active = bt.bout_id === boutId;
            return (
              <li key={bt.bout_id} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    onBout(bt.bout_id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-sm transition-colors hover:bg-foreground/[0.06]",
                    active ? "text-primary" : "text-foreground",
                  )}
                >
                  <Check
                    className={cn("h-3.5 w-3.5 shrink-0", !active && "invisible")}
                    aria-hidden
                  />
                  <span className={cn("w-4 shrink-0 font-mono", RESULT_CLASS[bt.result])}>
                    {bt.result}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {bt.opponent_name}
                    <span className="ml-1.5 text-xs text-foreground-subtle">
                      {bt.event_name} · {bt.date}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
