"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import {
  createRankingAction,
  deleteRankingAction,
  type PickerFighter,
  searchFightersForPicker,
  updateRankingAction,
} from "@/app/[locale]/rankings/actions";
import {
  RANKING_LIMITS,
  RankingError,
} from "@/app/[locale]/rankings/ranking-constants";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRouter } from "@/i18n/navigation";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

const { TITLE_MIN, TITLE_MAX, DESC_MAX, NOTE_MAX, MAX_ENTRIES } = RANKING_LIMITS;

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

/** Subtle live character counter; turns to the loss colour near the limit. */
function CharCount({ value, max }: { value: number; max: number }) {
  const near = value >= max * 0.8;
  return (
    <span
      className={`font-mono text-[10px] tabular normal-case tracking-normal ${
        near ? "text-streak-loss" : "text-foreground-subtle"
      }`}
      aria-hidden
    >
      {value}/{max}
    </span>
  );
}

export function RankingForm({
  mode,
  rankingId,
  initialTitle = "",
  initialDescription = "",
  initialEntries = [],
}: Props) {
  const t = useTranslations("rankings");
  const tWeight = useTranslations("weight");
  const router = useRouter();
  const [title, setTitle] = React.useState(initialTitle);
  const [description, setDescription] = React.useState(initialDescription);
  const [entries, setEntries] =
    React.useState<RankingFormEntry[]>(initialEntries);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  // Map a stable server error code to a localized message so a RU user never
  // sees an English sentence (unknown codes fall back to a generic message).
  function errorMessage(code: string): string {
    switch (code) {
      case RankingError.NOT_SIGNED_IN:
        return t("errorNotSignedIn");
      case RankingError.RANKING_NOT_FOUND:
        return t("errorRankingNotFound");
      case RankingError.NOT_OWNER:
        return t("errorNotOwner");
      case RankingError.TITLE_LENGTH:
        return t("errorTitleLength", { min: TITLE_MIN, max: TITLE_MAX });
      case RankingError.DESCRIPTION_LENGTH:
        return t("errorDescriptionLength", { max: DESC_MAX });
      case RankingError.NO_FIGHTERS:
        return t("errorNoFighters");
      case RankingError.TOO_MANY_FIGHTERS:
        return t("errorTooManyFighters", { max: MAX_ENTRIES });
      case RankingError.DUPLICATE_FIGHTER:
        return t("errorDuplicateFighter");
      case RankingError.NOTE_LENGTH:
        return t("errorNoteLength", { max: NOTE_MAX });
      case RankingError.INVALID_FIGHTER:
        return t("errorInvalidFighter");
      case RankingError.FIGHTER_MISSING:
        return t("errorFighterMissing");
      default:
        return t("errorGeneric");
    }
  }

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
      setError(errorMessage(res.error));
      return;
    }

    const targetId =
      mode === "create" && "rankingId" in res ? res.rankingId : rankingId;
    if (!targetId) {
      setError(t("noResolvedUrl"));
      return;
    }
    router.push(`/rankings/${targetId}`);
    router.refresh();
  }

  async function performDelete() {
    if (!rankingId) return;
    setConfirmingDelete(false);
    setPending(true);
    setError(null);
    const res = await deleteRankingAction(rankingId);
    setPending(false);
    if (res?.error) {
      setError(errorMessage(res.error));
      return;
    }
    router.push("/rankings");
    router.refresh();
  }

  const titleTooShort = title.trim().length < TITLE_MIN;
  const noEntries = entries.length === 0;
  const submitDisabled = pending || noEntries || titleTooShort;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          <span>{t("titleLabel")}</span>
          <CharCount value={title.length} max={TITLE_MAX} />
        </span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={TITLE_MIN}
          maxLength={TITLE_MAX}
          className={INPUT_CLASS}
          placeholder={t("titlePlaceholder")}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          <span>{t("descriptionLabel")}</span>
          <CharCount value={description.length} max={DESC_MAX} />
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={DESC_MAX}
          rows={3}
          className={`${INPUT_CLASS} resize-y`}
          placeholder={t("descriptionPlaceholder")}
        />
      </label>

      <div className="flex flex-col gap-3">
        <h2 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("fightersCount", { n: entries.length, max: MAX_ENTRIES })}
        </h2>
        <FighterPickerInline
          onPick={addEntry}
          excludedIds={entries.map((e) => e.fighter_id)}
          disabled={entries.length >= MAX_ENTRIES}
        />

        {entries.length === 0 ? (
          <p className="py-6 text-center font-sans text-sm text-foreground-subtle">
            {t("addFightersHint")}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {entries.map((e, idx) => (
              <li
                key={e.fighter_id}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
              >
                <div className="flex items-start gap-3">
                  <span className="min-w-[2rem] pt-1 text-center font-display text-xl tabular text-foreground-subtle">
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
                      {(() => {
                        if (!e.fighter_weight_class) return "—";
                        const key = e.fighter_weight_class.replace(/-/g, "_");
                        return tWeight.has(key)
                          ? tWeight(key as "lightweight")
                          : e.fighter_weight_class;
                      })()}
                    </p>
                    <input
                      type="text"
                      value={e.note}
                      onChange={(evt) =>
                        updateNote(e.fighter_id, evt.target.value)
                      }
                      placeholder={t("notePlaceholder")}
                      maxLength={NOTE_MAX}
                      className="mt-2 w-full rounded-sm border border-foreground/10 bg-background-elevated/20 px-2 py-1 font-sans text-xs text-foreground focus:border-primary focus:outline-none"
                    />
                    {e.note.length > NOTE_MAX * 0.75 ? (
                      <span className="mt-1 flex justify-end">
                        <CharCount value={e.note.length} max={NOTE_MAX} />
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => moveEntry(idx, -1)}
                      disabled={idx === 0}
                      className="rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-30"
                      aria-label={t("moveUp")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveEntry(idx, 1)}
                      disabled={idx === entries.length - 1}
                      className="rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-30"
                      aria-label={t("moveDown")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeEntry(e.fighter_id)}
                      className="rounded-sm border border-streak-loss/30 px-2 py-0.5 font-mono text-xs text-streak-loss hover:bg-streak-loss/10"
                      aria-label={t("remove")}
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

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={submitDisabled}
            className="rounded-sm bg-primary px-4 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
          >
            {pending
              ? t("saving")
              : mode === "create"
                ? t("publish")
                : t("saveChanges")}
          </button>
          {mode === "edit" ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={pending}
              className="rounded-sm border border-streak-loss/30 px-4 py-2 font-sans text-sm text-streak-loss hover:bg-streak-loss/10 disabled:opacity-50"
            >
              {t("deleteRanking")}
            </button>
          ) : null}
        </div>
        {!pending && (noEntries || titleTooShort) ? (
          <p className="font-sans text-xs text-foreground-subtle">
            {t("publishHint", { min: TITLE_MIN })}
          </p>
        ) : null}
      </div>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-tight">
              {t("deleteRanking")}
            </DialogTitle>
            <DialogDescription>{t("deleteConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05]"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={performDelete}
              className="rounded-sm bg-streak-loss px-4 py-2 font-sans text-sm text-background-base hover:opacity-90"
            >
              {t("confirmDelete")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const t = useTranslations("rankings");
  const tSearch = useTranslations("search");
  const tWeight = useTranslations("weight");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PickerFighter[]>([]);
  // Trimmed query that `results` actually correspond to, so the "no results"
  // message only shows after a completed search for the current query (not
  // during the debounce window, which would flash it on every keystroke).
  const [resultsQuery, setResultsQuery] = React.useState("");
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
        if (queryRef.current === snapshot) {
          setResults(r);
          setResultsQuery(snapshot.trim());
        }
      } finally {
        if (queryRef.current === snapshot) setPending(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const excludedSet = new Set(excludedIds);
  const visible = results.filter((r) => !excludedSet.has(r.id));
  const trimmedQuery = query.trim();
  // A search has settled for the CURRENT query — used to avoid flashing an
  // empty-state during the 200ms debounce window before results arrive.
  const searchSettled =
    !pending && trimmedQuery !== "" && resultsQuery === trimmedQuery;
  const showNoResults = searchSettled && results.length === 0;
  // Matches existed but every one is already in the ranking — distinct from a
  // genuine zero-match search so the copy isn't misleading.
  const showAllAdded =
    searchSettled && results.length > 0 && visible.length === 0;

  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          disabled
            ? t("limitPlaceholder", { max: MAX_ENTRIES })
            : t("searchByName")
        }
        disabled={disabled}
        className="w-full rounded-sm border border-foreground/15 bg-background-elevated/20 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
      />
      {pending ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {tSearch("searching")}
        </p>
      ) : showNoResults ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {t("noFightersFound")}
        </p>
      ) : showAllAdded ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {t("allFightersAdded")}
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
                    {(() => {
                      if (!r.weight_class) return "—";
                      const key = r.weight_class.replace(/-/g, "_");
                      return tWeight.has(key)
                        ? tWeight(key as "lightweight")
                        : r.weight_class;
                    })()}
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
