"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { submitPicksAction } from "@/app/[locale]/predictions/actions";
import type { PredictionBoutRow } from "@/lib/predictions";
import { cn } from "@/lib/utils";

interface Props {
  predictionEventId: string;
  bouts: PredictionBoutRow[];
  readOnly?: boolean;
}

export function PredictionForm({
  predictionEventId,
  bouts,
  readOnly,
}: Props) {
  const t = useTranslations("predictions");
  const tWeight = useTranslations("weight");
  const router = useRouter();
  const [picks, setPicks] = React.useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const b of bouts) {
      if (b.picked_fighter_id) m.set(b.bout_id, b.picked_fighter_id);
    }
    return m;
  });
  const [pending, setPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function pick(boutId: string, fighterId: string) {
    if (readOnly) return;
    setPicks((curr) => {
      const next = new Map(curr);
      if (next.get(boutId) === fighterId) next.delete(boutId);
      else next.set(boutId, fighterId);
      return next;
    });
  }

  async function onSubmit() {
    setPending(true);
    setError(null);
    setFeedback(null);
    const payload = Array.from(picks.entries()).map(
      ([bout_id, picked_fighter_id]) => ({ bout_id, picked_fighter_id }),
    );
    const res = await submitPicksAction(
      predictionEventId,
      JSON.stringify(payload),
    );
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setFeedback(t("savedPicks", { count: res.saved ?? 0 }));
    router.refresh();
  }

  return (
    <div>
      <ul className="flex flex-col gap-3">
        {bouts.map((b) => {
          const picked = picks.get(b.bout_id);
          const tag =
            b.is_main_event
              ? t("mainEventTag")
              : b.is_co_main_event
                ? t("coMainTag")
                : "";
          return (
            <li
              key={b.bout_id}
              className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4"
            >
              {tag || b.is_title_fight ? (
                <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-primary">
                  {tag}
                  {tag && b.is_title_fight ? " · " : ""}
                  {b.is_title_fight ? t("titleTag") : ""}
                </p>
              ) : null}
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                {(() => {
                  const key = b.weight_class.replace(/-/g, "_");
                  return tWeight.has(key)
                    ? tWeight(key as "lightweight")
                    : b.weight_class.replace(/_/g, " ");
                })()}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <FighterPickButton
                  fighter={{
                    id: b.fighter_a_id,
                    name: b.fighter_a_name,
                    photo: b.fighter_a_photo_thumbnail_url,
                  }}
                  isPicked={picked === b.fighter_a_id}
                  isWinner={
                    b.bout_status === "completed" &&
                    b.bout_winner_id === b.fighter_a_id
                  }
                  isLoser={
                    b.bout_status === "completed" &&
                    b.bout_winner_id !== null &&
                    b.bout_winner_id !== b.fighter_a_id
                  }
                  onClick={() => pick(b.bout_id, b.fighter_a_id)}
                  disabled={readOnly}
                />
                <FighterPickButton
                  fighter={{
                    id: b.fighter_b_id,
                    name: b.fighter_b_name,
                    photo: b.fighter_b_photo_thumbnail_url,
                  }}
                  isPicked={picked === b.fighter_b_id}
                  isWinner={
                    b.bout_status === "completed" &&
                    b.bout_winner_id === b.fighter_b_id
                  }
                  isLoser={
                    b.bout_status === "completed" &&
                    b.bout_winner_id !== null &&
                    b.bout_winner_id !== b.fighter_b_id
                  }
                  onClick={() => pick(b.bout_id, b.fighter_b_id)}
                  disabled={readOnly}
                />
              </div>
              {b.bout_status === "completed" && b.is_correct !== null ? (
                <p
                  className={cn(
                    "mt-3 font-mono text-[11px] tabular",
                    b.is_correct ? "text-streak-win" : "text-streak-loss",
                  )}
                >
                  {b.is_correct
                    ? t("correctCall")
                    : picked
                      ? t("missedCall")
                      : t("noPick")}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {!readOnly ? (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSubmit}
            disabled={pending || picks.size === 0}
            className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
          >
            {pending
              ? t("submitting")
              : t("savePicks", { count: picks.size })}
          </button>
          {error ? (
            <p className="font-sans text-sm text-streak-loss">{error}</p>
          ) : null}
          {feedback ? (
            <p className="font-sans text-sm text-streak-win">{feedback}</p>
          ) : null}
          <p className="font-sans text-[11px] text-foreground-subtle">
            {t("tapToClear")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function FighterPickButton({
  fighter,
  isPicked,
  isWinner,
  isLoser,
  onClick,
  disabled,
}: {
  fighter: { id: string; name: string; photo: string | null };
  isPicked: boolean;
  isWinner?: boolean;
  isLoser?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isPicked}
      className={cn(
        "flex items-center gap-3 rounded-sm border px-3 py-2.5 text-left transition-colors",
        isPicked
          ? "border-primary bg-primary/10"
          : "border-foreground/10 bg-foreground/[0.02] hover:bg-foreground/[0.04]",
        // After resolution, layer subtle win/loss highlight on top.
        isWinner && "border-streak-win/60",
        isLoser && "opacity-70",
        disabled && "cursor-default",
      )}
    >
      {fighter.photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fighter.photo}
          alt={fighter.name}
          className="h-10 w-10 shrink-0 rounded-sm border border-foreground/15 object-cover"
        />
      ) : (
        <div
          className="h-10 w-10 shrink-0 rounded-sm bg-foreground/[0.05]"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "truncate font-sans text-sm text-foreground",
          isPicked && "font-medium",
        )}
      >
        {fighter.name}
      </span>
      {isWinner ? (
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-streak-win">
          W
        </span>
      ) : null}
    </button>
  );
}
