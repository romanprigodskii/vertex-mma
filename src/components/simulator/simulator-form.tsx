"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  type PickerFighter,
  searchFightersForPicker,
} from "@/app/rankings/actions";
import { runSimulationAction } from "@/app/simulator/actions";
import { cn } from "@/lib/utils";

interface PickedFighter {
  id: string;
  name: string;
  photo_thumbnail_url: string | null;
  weight_class: string | null;
}

export function SimulatorForm() {
  const router = useRouter();
  const [a, setA] = React.useState<PickedFighter | null>(null);
  const [b, setB] = React.useState<PickedFighter | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onRun() {
    if (!a || !b) {
      setError("Pick both fighters.");
      return;
    }
    if (a.id === b.id) {
      setError("Pick two different fighters.");
      return;
    }
    setError(null);
    setPending(true);
    const res = await runSimulationAction(a.id, b.id);
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.simulationId) router.push(`/simulator/${res.simulationId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
        <PickerSlot
          label="Fighter A"
          picked={a}
          onPick={setA}
          excludeId={b?.id ?? null}
        />
        <p className="text-center font-display text-2xl uppercase tracking-widest text-foreground-subtle">
          vs
        </p>
        <PickerSlot
          label="Fighter B"
          picked={b}
          onPick={setB}
          excludeId={a?.id ?? null}
        />
      </div>
      {error ? (
        <p className="text-center font-sans text-sm text-streak-loss">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRun}
        disabled={pending || !a || !b}
        className="self-center rounded-sm bg-primary px-6 py-3 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Simulating…" : "Run simulation"}
      </button>
    </div>
  );
}

function PickerSlot({
  label,
  picked,
  onPick,
  excludeId,
}: {
  label: string;
  picked: PickedFighter | null;
  onPick: (f: PickedFighter | null) => void;
  excludeId: string | null;
}) {
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
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  if (picked) {
    return (
      <div
        className={cn(
          "rounded-md border border-primary/40 bg-background-elevated/30 p-4",
        )}
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {label}
        </p>
        <div className="mt-2 flex items-center gap-3">
          {picked.photo_thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={picked.photo_thumbnail_url}
              alt={picked.name}
              className="h-12 w-12 shrink-0 rounded-sm border border-foreground/15 object-cover"
            />
          ) : (
            <div
              className="h-12 w-12 shrink-0 rounded-sm bg-foreground/[0.05]"
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-lg uppercase tracking-tight text-foreground">
              {picked.name}
            </p>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {picked.weight_class?.replace(/_/g, " ") ?? "—"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onPick(null)}
          className="mt-3 font-sans text-xs text-streak-loss hover:underline"
        >
          Clear
        </button>
      </div>
    );
  }

  const visible = results.filter((r) => r.id !== excludeId);

  return (
    <div className="rounded-md border border-foreground/15 bg-background-elevated/30 p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search fighter…"
        className="w-full rounded-sm border border-foreground/15 bg-foreground/[0.04] px-2 py-1.5 font-sans text-sm text-foreground focus:border-primary focus:outline-none"
      />
      {pending ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          Searching…
        </p>
      ) : null}
      {visible.length > 0 ? (
        <ul className="mt-2 flex max-h-56 flex-col overflow-y-auto">
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick({
                    id: r.id,
                    name: r.name,
                    photo_thumbnail_url: r.photo_thumbnail_url,
                    weight_class: r.weight_class,
                  });
                  setQuery("");
                  setResults([]);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-foreground/[0.05]"
              >
                {r.photo_thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.photo_thumbnail_url}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <div
                    className="h-8 w-8 shrink-0 rounded-sm bg-foreground/[0.05]"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <p className="truncate font-sans text-sm text-foreground">
                    {r.name}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                    {r.weight_class ?? "—"}
                  </p>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
