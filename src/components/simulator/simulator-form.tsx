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
  slug: string;
  name: string;
  nickname: string | null;
  photo_thumbnail_url: string | null;
  weight_class: string | null;
  wins_total: number | null;
  losses_total: number | null;
  draws_total: number | null;
  vertex_score_all_time: number | null;
}

const GAMEPLAN_MAX = 500;

export function SimulatorForm() {
  const router = useRouter();
  const [a, setA] = React.useState<PickedFighter | null>(null);
  const [b, setB] = React.useState<PickedFighter | null>(null);
  const [gameplanA, setGameplanA] = React.useState("");
  const [gameplanB, setGameplanB] = React.useState("");
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
    const res = await runSimulationAction(
      a.id,
      b.id,
      gameplanA.trim() || undefined,
      gameplanB.trim() || undefined,
    );
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.simulationId) router.push(`/simulator/${res.simulationId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[1fr_auto_1fr]">
        <div className="flex flex-col gap-3">
          <PickerSlot
            label="Fighter A"
            picked={a}
            onPick={(f) => {
              setA(f);
              if (!f) setGameplanA("");
            }}
            excludeId={b?.id ?? null}
          />
          {a ? (
            <GameplanInput
              fighterName={a.name}
              value={gameplanA}
              onChange={setGameplanA}
            />
          ) : null}
        </div>
        <p className="pt-12 text-center font-display text-2xl uppercase tracking-widest text-foreground-subtle">
          vs
        </p>
        <div className="flex flex-col gap-3">
          <PickerSlot
            label="Fighter B"
            picked={b}
            onPick={(f) => {
              setB(f);
              if (!f) setGameplanB("");
            }}
            excludeId={a?.id ?? null}
          />
          {b ? (
            <GameplanInput
              fighterName={b.name}
              value={gameplanB}
              onChange={setGameplanB}
            />
          ) : null}
        </div>
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

function GameplanInput({
  fighterName,
  value,
  onChange,
}: {
  fighterName: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const lastName = fighterName.split(" ").pop() ?? fighterName;
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        Gameplan for {lastName}{" "}
        <span className="text-foreground-subtle/60">(optional)</span>
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={GAMEPLAN_MAX}
        rows={2}
        placeholder='e.g. "Pressure with leg kicks, avoid the clinch"'
        className="resize-y rounded-sm border border-foreground/15 bg-foreground/[0.04] px-2 py-1.5 font-sans text-xs text-foreground placeholder:text-foreground-subtle focus:border-primary focus:outline-none"
      />
    </label>
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
    const record =
      picked.wins_total != null && picked.losses_total != null
        ? `${picked.wins_total}-${picked.losses_total}-${picked.draws_total ?? 0}`
        : null;
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
              className="h-14 w-14 shrink-0 rounded-sm border border-foreground/15 object-cover"
            />
          ) : (
            <div
              className="h-14 w-14 shrink-0 rounded-sm bg-foreground/[0.05]"
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-lg uppercase tracking-tight text-foreground">
              {picked.name}
            </p>
            {picked.nickname ? (
              <p className="truncate font-sans text-xs italic text-foreground-muted">
                &ldquo;{picked.nickname}&rdquo;
              </p>
            ) : null}
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {picked.weight_class?.replace(/_/g, " ") ?? "—"}
              {record ? ` · ${record}` : ""}
            </p>
          </div>
          {picked.vertex_score_all_time != null ? (
            <div className="shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-center font-mono tabular text-foreground">
              <div className="text-[9px] uppercase tracking-widest text-foreground-subtle">
                All-time
              </div>
              <div className="text-sm font-semibold">
                {Math.round(picked.vertex_score_all_time)}
              </div>
            </div>
          ) : null}
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
        <ul className="mt-2 flex max-h-80 flex-col overflow-y-auto">
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick({
                    id: r.id,
                    slug: r.slug,
                    name: r.name,
                    nickname: r.nickname,
                    photo_thumbnail_url: r.photo_thumbnail_url,
                    weight_class: r.weight_class,
                    wins_total: r.wins_total,
                    losses_total: r.losses_total,
                    draws_total: r.draws_total,
                    vertex_score_all_time: r.vertex_score_all_time,
                  });
                  setQuery("");
                  setResults([]);
                }}
                className="flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
              >
                {r.photo_thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.photo_thumbnail_url}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-sm border border-foreground/10 object-cover"
                  />
                ) : (
                  <div
                    className="h-10 w-10 shrink-0 rounded-sm bg-foreground/[0.05]"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <p className="truncate font-sans text-sm font-medium text-foreground">
                    {r.name}
                  </p>
                  <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                    {r.weight_class?.replace(/_/g, " ") ?? "—"}
                    {r.wins_total != null && r.losses_total != null
                      ? ` · ${r.wins_total}-${r.losses_total}-${r.draws_total ?? 0}`
                      : ""}
                  </p>
                </span>
                {r.vertex_score_all_time != null ? (
                  <span className="shrink-0 rounded-sm border border-foreground/15 bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px] tabular text-foreground">
                    {Math.round(r.vertex_score_all_time)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
