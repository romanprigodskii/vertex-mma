"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  createRankingAction,
  deleteRankingAction,
  type PickerFighter,
  searchFightersForPicker,
  updateRankingAction,
} from "@/app/rankings/actions";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

const MAX_ENTRIES = 25;

export interface RankingFormEntry {
  fighter_id: string;
  fighter_name: string;
  fighter_photo_thumbnail_url: string | null;
  fighter_weight_class: string | null;
  position: number;
  note: string;
}

interface Props {
  mode: "create" | "edit";
  rankingId?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialEntries?: RankingFormEntry[];
}

export function RankingForm({
  mode,
  rankingId,
  initialTitle = "",
  initialDescription = "",
  initialEntries = [],
}: Props) {
  const router = useRouter();
  const [title, setTitle] = React.useState(initialTitle);
  const [description, setDescription] = React.useState(initialDescription);
  const [entries, setEntries] =
    React.useState<RankingFormEntry[]>(initialEntries);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function addEntry(f: PickerFighter) {
    setEntries((curr) => {
      if (curr.some((e) => e.fighter_id === f.id)) return curr;
      if (curr.length >= MAX_ENTRIES) return curr;
      return [
        ...curr,
        {
          fighter_id: f.id,
          fighter_name: f.name,
          fighter_photo_thumbnail_url: f.photo_thumbnail_url,
          fighter_weight_class: f.weight_class,
          position: curr.length + 1,
          note: "",
        },
      ];
    });
  }

  function removeEntry(fighterId: string) {
    setEntries((curr) =>
      curr
        .filter((e) => e.fighter_id !== fighterId)
        .map((e, i) => ({ ...e, position: i + 1 })),
    );
  }

  function moveEntry(idx: number, dir: -1 | 1) {
    setEntries((curr) => {
      const target = idx + dir;
      if (target < 0 || target >= curr.length) return curr;
      const next = [...curr];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((e, i) => ({ ...e, position: i + 1 }));
    });
  }

  function updateNote(fighterId: string, note: string) {
    setEntries((curr) =>
      curr.map((e) => (e.fighter_id === fighterId ? { ...e, note } : e)),
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData();
    formData.append("title", title);
    formData.append("description", description);
    formData.append(
      "entries",
      JSON.stringify(
        entries.map((entry) => ({
          fighter_id: entry.fighter_id,
          position: entry.position,
          note: entry.note,
        })),
      ),
    );

    const res =
      mode === "create"
        ? await createRankingAction(formData)
        : await updateRankingAction(rankingId!, formData);
    setPending(false);

    if (res?.error) {
      setError(res.error);
      return;
    }

    const targetId =
      mode === "create" && "rankingId" in res ? res.rankingId : rankingId;
    if (!targetId) {
      setError("Could not determine the ranking URL after save.");
      return;
    }
    router.push(`/rankings/${targetId}`);
    router.refresh();
  }

  async function onDelete() {
    if (!rankingId) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete this ranking? This cannot be undone.")
    ) {
      return;
    }
    setPending(true);
    setError(null);
    const res = await deleteRankingAction(rankingId);
    setPending(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    router.push("/rankings");
    router.refresh();
  }

  const submitDisabled =
    pending || entries.length === 0 || title.trim().length < 3;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Title
        </span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={3}
          maxLength={100}
          className={INPUT_CLASS}
          placeholder='e.g. "Top 10 P4P 2026"'
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Description (optional)
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={3}
          className={`${INPUT_CLASS} resize-y`}
          placeholder="Short context — why this list?"
        />
      </label>

      <div className="flex flex-col gap-3">
        <h2 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Fighters · {entries.length}/{MAX_ENTRIES}
        </h2>
        <FighterPickerInline
          onPick={addEntry}
          excludedIds={entries.map((e) => e.fighter_id)}
          disabled={entries.length >= MAX_ENTRIES}
        />

        {entries.length === 0 ? (
          <p className="py-6 text-center font-sans text-sm text-foreground-subtle">
            No fighters added yet. Search above to add.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {entries.map((e, idx) => (
              <li
                key={e.fighter_id}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
              >
                <div className="flex items-start gap-3">
                  <span className="min-w-[2rem] pt-1 text-center font-sans font-bold text-xl tabular text-foreground-subtle">
                    #{e.position}
                  </span>
                  {e.fighter_photo_thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={e.fighter_photo_thumbnail_url}
                      alt={e.fighter_name}
                      className="h-10 w-10 shrink-0 rounded-sm border border-foreground/15 object-cover"
                    />
                  ) : (
                    <div
                      className="h-10 w-10 shrink-0 rounded-sm border border-foreground/15 bg-foreground/[0.05]"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-sans text-sm text-foreground">
                      {e.fighter_name}
                    </p>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                      {e.fighter_weight_class ?? "—"}
                    </p>
                    <input
                      type="text"
                      value={e.note}
                      onChange={(evt) =>
                        updateNote(e.fighter_id, evt.target.value)
                      }
                      placeholder="Optional note"
                      maxLength={200}
                      className="mt-2 w-full rounded-sm border border-foreground/10 bg-background-elevated/20 px-2 py-1 font-sans text-xs text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => moveEntry(idx, -1)}
                      disabled={idx === 0}
                      className="rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-30"
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveEntry(idx, 1)}
                      disabled={idx === entries.length - 1}
                      className="rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-30"
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeEntry(e.fighter_id)}
                      className="rounded-sm border border-streak-loss/30 px-2 py-0.5 font-mono text-xs text-streak-loss hover:bg-streak-loss/10"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {error ? (
        <p className="font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitDisabled}
          className="rounded-sm bg-primary px-4 py-2.5 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : mode === "create" ? "Publish" : "Save changes"}
        </button>
        {mode === "edit" ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="rounded-sm border border-streak-loss/30 px-4 py-2 font-sans text-sm text-streak-loss hover:bg-streak-loss/10 disabled:opacity-50"
          >
            Delete ranking
          </button>
        ) : null}
      </div>
    </form>
  );
}

function FighterPickerInline({
  onPick,
  excludedIds,
  disabled,
}: {
  onPick: (f: PickerFighter) => void;
  excludedIds: string[];
  disabled: boolean;
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
    const t = setTimeout(async () => {
      const snapshot = queryRef.current;
      setPending(true);
      try {
        const r = await searchFightersForPicker(snapshot);
        // If the input changed while we were waiting, drop the stale results.
        if (queryRef.current === snapshot) setResults(r);
      } finally {
        if (queryRef.current === snapshot) setPending(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const excludedSet = new Set(excludedIds);
  const visible = results.filter((r) => !excludedSet.has(r.id));

  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          disabled
            ? `Reached the ${MAX_ENTRIES}-fighter limit`
            : "Search fighter by name…"
        }
        disabled={disabled}
        className="w-full rounded-sm border border-foreground/15 bg-background-elevated/20 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
      />
      {pending ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          Searching…
        </p>
      ) : null}
      {visible.length > 0 ? (
        <ul className="mt-2 flex max-h-72 flex-col overflow-y-auto">
          {visible.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setQuery("");
                  setResults([]);
                }}
                className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left hover:bg-foreground/[0.05]"
              >
                {r.photo_thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.photo_thumbnail_url}
                    alt=""
                    className="h-8 w-8 rounded-sm object-cover"
                  />
                ) : (
                  <div
                    className="h-8 w-8 rounded-sm bg-foreground/[0.05]"
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
