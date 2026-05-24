"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  type PickerFighter,
  searchFightersForPicker,
} from "@/app/rankings/actions";
import { runSimulationAction } from "@/app/simulator/actions";
import { Crown } from "lucide-react";

import {
  DualScore,
  FighterResultCard,
} from "@/components/fighter/fighter-result-card";
import { cn } from "@/lib/utils";
import {
  TIER_STYLES,
  type ChampionStatus,
  type VertexTier,
} from "@/lib/vertex-tier";

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
  vertex_score: number | null;
  vertex_score_all_time: number | null;
  ufc_bouts: number;
  tier: VertexTier;
  championStatus: ChampionStatus;
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
    const snap = query;
    // No debounce on the initial empty-query top-fighters load; a short
    // debounce while the user is typing.
    const delay = snap.trim() ? 200 : 0;
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
  }, [query]);

  if (picked) {
    const style = TIER_STYLES[picked.tier];
    const record =
      picked.wins_total != null && picked.losses_total != null
        ? `${picked.wins_total}-${picked.losses_total}${
            picked.draws_total ? `-${picked.draws_total}` : ""
          }`
        : null;
    const isChamp =
      picked.championStatus === "active" ||
      picked.championStatus === "dominant";
    const initials = picked.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    return (
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {label}
        </p>
        <div className="relative overflow-hidden rounded-md border-2 border-primary/45">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: `linear-gradient(135deg, ${style.gradientFrom}, ${style.gradientTo})`,
            }}
            aria-hidden
          />
          <div className="relative flex items-stretch gap-3 p-3 sm:gap-4 sm:p-4">
            <div className="relative h-28 w-24 shrink-0 overflow-hidden rounded-sm border border-foreground/20 sm:h-32 sm:w-28">
              {picked.photo_thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={picked.photo_thumbnail_url}
                  alt={picked.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center font-display text-2xl text-foreground-subtle">
                  {initials}
                </div>
              )}
              {isChamp ? (
                <div
                  className="absolute right-1 top-1 flex items-center gap-0.5 rounded-sm bg-background-base/75 px-1 py-0.5 backdrop-blur-sm"
                  style={{ color: "oklch(0.85 0.18 75)" }}
                  title="Champion"
                >
                  <Crown className="h-2.5 w-2.5" aria-hidden />
                </div>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="truncate font-display text-base uppercase tracking-tight text-foreground sm:text-lg">
                {picked.name}
              </p>
              {picked.nickname ? (
                <p className="truncate font-sans text-[10px] italic text-foreground-muted sm:text-xs">
                  &ldquo;{picked.nickname}&rdquo;
                </p>
              ) : null}
              <p className="font-display text-2xl leading-none tabular text-foreground sm:text-3xl">
                {record ?? "—"}
              </p>
              <p className="truncate font-mono text-[9px] uppercase tracking-widest text-foreground-subtle sm:text-[10px]">
                {picked.weight_class?.replace(/_/g, " ") ?? "—"}
                {picked.ufc_bouts > 0 ? ` · ${picked.ufc_bouts} UFC` : ""}
              </p>
              <div className="mt-auto pt-1">
                <DualScore
                  current={picked.vertex_score}
                  allTime={picked.vertex_score_all_time}
                  scoreColor={style.scoreColor}
                  borderColor={style.badgeBorder}
                  size="md"
                />
              </div>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onPick(null)}
          className="self-start font-sans text-xs text-streak-loss hover:underline"
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
        <div className="mt-2">
          {!query.trim() ? (
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              Top fighters · all-time
            </p>
          ) : null}
          <ul className="grid max-h-[34rem] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {visible.map((r) => (
              <li key={r.id}>
                <FighterResultCard
                  fighter={r}
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
                      vertex_score: r.vertex_score,
                      vertex_score_all_time: r.vertex_score_all_time,
                      ufc_bouts: r.ufc_bouts,
                      tier: r.tier,
                      championStatus: r.championStatus,
                    });
                    setQuery("");
                    setResults([]);
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : query.trim() && !pending ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          No fighters found.
        </p>
      ) : null}
    </div>
  );
}
