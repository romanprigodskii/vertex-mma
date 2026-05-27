"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import {
  createFightCardAction,
  deleteFightCardAction,
  type PickerFighter,
  updateFightCardAction,
} from "@/app/[locale]/cards/actions";
import {
  FightCardPoster,
  type PosterDisplayBout,
} from "@/components/cards/fight-card-poster";
import {
  type BoutFighter,
  FighterSlotPicker,
} from "@/components/cards/fighter-slot-picker";
import { useRouter } from "@/i18n/navigation";
import {
  CARD_THEME_BACKGROUNDS,
  CARD_THEME_COLORS,
  CARD_THEME_FONTS,
  formatWeightClass,
  WEIGHT_CLASSES,
} from "@/lib/card-theme";
import { cn } from "@/lib/utils";

const MAX_BOUTS = 15;
const LABEL =
  "font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted";
const INPUT_CLASS =
  "w-full rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

export type FightCardFormBout = {
  fighterA: BoutFighter | null;
  fighterB: BoutFighter | null;
  weightClass: string;
  isMain: boolean;
};

type FormBout = FightCardFormBout & { key: string };

interface Props {
  mode: "create" | "edit";
  cardId?: string;
  initialTitle?: string;
  initialSubtitle?: string;
  initialThemeColor?: string;
  initialTitleFont?: string;
  initialBackgroundId?: string;
  initialIsPublic?: boolean;
  initialBouts?: FightCardFormBout[];
}

let boutKeySeq = 0;
function nextBoutKey(): string {
  boutKeySeq += 1;
  return `bout-${boutKeySeq}`;
}
function freshBout(): FormBout {
  return {
    key: nextBoutKey(),
    fighterA: null,
    fighterB: null,
    weightClass: "lightweight",
    isMain: false,
  };
}
function toBoutFighter(f: PickerFighter): BoutFighter {
  return {
    id: f.id,
    name: f.name,
    photo_thumbnail_url: f.photo_thumbnail_url,
  };
}

export function FightCardForm({
  mode,
  cardId,
  initialTitle = "",
  initialSubtitle = "",
  initialThemeColor = "primary",
  initialTitleFont = "display",
  initialBackgroundId = "default",
  initialIsPublic = true,
  initialBouts,
}: Props) {
  const t = useTranslations("cards");
  const tWeight = useTranslations("weight");
  const router = useRouter();
  const [title, setTitle] = React.useState(initialTitle);
  const [subtitle, setSubtitle] = React.useState(initialSubtitle);
  const [themeColor, setThemeColor] = React.useState(initialThemeColor);
  const [titleFont, setTitleFont] = React.useState(initialTitleFont);
  const [backgroundId, setBackgroundId] = React.useState(initialBackgroundId);
  const [isPublic, setIsPublic] = React.useState(initialIsPublic);
  const [bouts, setBouts] = React.useState<FormBout[]>(() =>
    initialBouts && initialBouts.length > 0
      ? initialBouts.map((b) => ({ ...b, key: nextBoutKey() }))
      : [freshBout()],
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function addBout() {
    setBouts((cur) => (cur.length >= MAX_BOUTS ? cur : [...cur, freshBout()]));
  }
  function removeBout(key: string) {
    setBouts((cur) =>
      cur.length <= 1 ? cur : cur.filter((b) => b.key !== key),
    );
  }
  function moveBout(idx: number, dir: -1 | 1) {
    setBouts((cur) => {
      const target = idx + dir;
      if (target < 0 || target >= cur.length) return cur;
      const next = [...cur];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }
  function patchBout(key: string, patch: Partial<FormBout>) {
    setBouts((cur) => cur.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }
  function toggleMainEvent(key: string) {
    setBouts((cur) => {
      const target = cur.find((b) => b.key === key);
      const makeMain = !(target?.isMain ?? false);
      // At most one main event per card — selecting one clears the rest.
      return cur.map((b) => ({ ...b, isMain: makeMain && b.key === key }));
    });
  }

  const usedFighterIds = bouts.flatMap((b) =>
    [b.fighterA?.id, b.fighterB?.id].filter((x): x is string => Boolean(x)),
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (title.trim().length < 3) {
      setError(t("titleTooShort"));
      return;
    }
    if (bouts.some((b) => !b.fighterA || !b.fighterB)) {
      setError(t("boutsNeedFighters"));
      return;
    }

    setPending(true);
    const formData = new FormData();
    formData.append("title", title);
    formData.append("subtitle", subtitle);
    formData.append("themeColor", themeColor);
    formData.append("titleFont", titleFont);
    formData.append("backgroundId", backgroundId);
    formData.append("isPublic", String(isPublic));
    formData.append(
      "bouts",
      JSON.stringify(
        bouts.map((b, i) => ({
          fighterAId: b.fighterA?.id ?? "",
          fighterBId: b.fighterB?.id ?? "",
          weightClass: b.weightClass,
          isMain: b.isMain,
          order: i,
        })),
      ),
    );

    const res =
      mode === "create"
        ? await createFightCardAction(formData)
        : await updateFightCardAction(cardId!, formData);
    setPending(false);

    if (res?.error) {
      setError(res.error);
      return;
    }
    if (!res?.slug) {
      setError(t("couldNotResolveUrl"));
      return;
    }
    router.push(`/cards/${res.slug}`);
    router.refresh();
  }

  async function onDelete() {
    if (!cardId) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("deleteCardConfirm"))
    ) {
      return;
    }
    setPending(true);
    setError(null);
    const res = await deleteFightCardAction(cardId);
    setPending(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    router.push("/cards");
    router.refresh();
  }

  const previewBouts: PosterDisplayBout[] = bouts.map((b) => ({
    weightClass: b.weightClass,
    isMain: b.isMain,
    fighterA: b.fighterA
      ? {
          slug: null,
          name: b.fighterA.name,
          photoUrl: b.fighterA.photo_thumbnail_url,
          record: null,
        }
      : null,
    fighterB: b.fighterB
      ? {
          slug: null,
          name: b.fighterB.name,
          photoUrl: b.fighterB.photo_thumbnail_url,
          record: null,
        }
      : null,
  }));

  return (
    <form
      onSubmit={onSubmit}
      className="grid gap-8 lg:grid-cols-[1fr_minmax(320px,400px)]"
    >
      <div className="flex flex-col gap-6">
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>{t("titleLabel")}</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={3}
            maxLength={100}
            className={INPUT_CLASS}
            placeholder={t("titlePlaceholder")}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>{t("subtitleLabel")}</span>
          <input
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            maxLength={120}
            className={INPUT_CLASS}
            placeholder={t("subtitlePlaceholder")}
          />
        </label>

        <div className="flex flex-col gap-4 rounded-md border border-foreground/10 bg-background-elevated/20 p-4">
          <h2 className={LABEL}>{t("styleHeading")}</h2>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t("accentColor")}</span>
            <div className="flex flex-wrap gap-2">
              {CARD_THEME_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setThemeColor(c.id)}
                  aria-label={c.label}
                  title={c.label}
                  className={cn(
                    "h-8 w-8 rounded-full border-2 transition-transform hover:scale-110",
                    themeColor === c.id
                      ? "border-foreground"
                      : "border-transparent",
                  )}
                  style={{ backgroundColor: c.accent }}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t("titleFont")}</span>
            <div className="flex flex-wrap gap-2">
              {CARD_THEME_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setTitleFont(f.id)}
                  className={cn(
                    "rounded-sm border px-3 py-1.5 text-sm uppercase tracking-wide",
                    f.className,
                    titleFont === f.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-foreground/15 text-foreground-muted hover:bg-foreground/[0.05]",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t("background")}</span>
            <div className="flex flex-wrap gap-2">
              {CARD_THEME_BACKGROUNDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBackgroundId(b.id)}
                  className={cn(
                    "rounded-sm border px-3 py-1.5 font-sans text-sm",
                    backgroundId === b.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-foreground/15 text-foreground-muted hover:bg-foreground/[0.05]",
                  )}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span className="font-sans text-sm text-foreground">
              {t("publicCard")}
            </span>
          </label>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className={LABEL}>
              {t("boutsCounter", { n: bouts.length, max: MAX_BOUTS })}
            </h2>
          </div>

          <ol className="flex flex-col gap-3">
            {bouts.map((b, idx) => (
              <li
                key={b.key}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                    {t("boutNumber", { n: idx + 1 })}
                    {b.isMain ? (
                      <span className="text-primary">{t("mainEventSuffix")}</span>
                    ) : null}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveBout(idx, -1)}
                      disabled={idx === 0}
                      className="rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-30"
                      aria-label={t("moveBoutUp")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveBout(idx, 1)}
                      disabled={idx === bouts.length - 1}
                      className="rounded-sm border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-30"
                      aria-label={t("moveBoutDown")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeBout(b.key)}
                      disabled={bouts.length <= 1}
                      className="rounded-sm border border-streak-loss/30 px-2 py-0.5 font-mono text-xs text-streak-loss hover:bg-streak-loss/10 disabled:opacity-30"
                      aria-label={t("removeBoutAria")}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
                  <FighterSlotPicker
                    label={t("fighterA")}
                    fighter={b.fighterA}
                    onPick={(f) =>
                      patchBout(b.key, { fighterA: toBoutFighter(f) })
                    }
                    onClear={() => patchBout(b.key, { fighterA: null })}
                    excludedIds={usedFighterIds}
                  />
                  <span className="hidden self-center font-display text-sm text-foreground-subtle sm:block">
                    {t("vsLabel")}
                  </span>
                  <FighterSlotPicker
                    label={t("fighterB")}
                    fighter={b.fighterB}
                    onPick={(f) =>
                      patchBout(b.key, { fighterB: toBoutFighter(f) })
                    }
                    onClear={() => patchBout(b.key, { fighterB: null })}
                    excludedIds={usedFighterIds}
                  />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                      {t("weight")}
                    </span>
                    <select
                      value={b.weightClass}
                      onChange={(e) =>
                        patchBout(b.key, { weightClass: e.target.value })
                      }
                      className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-2 py-1.5 font-sans text-sm text-foreground focus:border-primary focus:outline-none"
                    >
                      {WEIGHT_CLASSES.map((wc) => {
                        const key = wc.replace(/-/g, "_");
                        const label = tWeight.has(key)
                          ? tWeight(key as "lightweight")
                          : formatWeightClass(wc);
                        return (
                          <option key={wc} value={wc}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={b.isMain}
                      onChange={() => toggleMainEvent(b.key)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="font-sans text-sm text-foreground-muted">
                      {t("mainEvent")}
                    </span>
                  </label>
                </div>
              </li>
            ))}
          </ol>

          <button
            type="button"
            onClick={addBout}
            disabled={bouts.length >= MAX_BOUTS}
            className="rounded-md border border-dashed border-foreground/20 px-4 py-2.5 font-sans text-sm text-foreground-muted hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
          >
            {bouts.length >= MAX_BOUTS
              ? t("boutLimit", { max: MAX_BOUTS })
              : t("addBoutBtn")}
          </button>
        </div>

        {error ? (
          <p className="font-sans text-sm text-streak-loss" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-sm bg-primary px-4 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
          >
            {pending
              ? t("saving")
              : mode === "create"
                ? t("publishCard")
                : t("saveChanges")}
          </button>
          {mode === "edit" ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              className="rounded-sm border border-streak-loss/30 px-4 py-2 font-sans text-sm text-streak-loss hover:bg-streak-loss/10 disabled:opacity-50"
            >
              {t("deleteCard")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <p className={cn(LABEL, "mb-2")}>{t("livePreview")}</p>
        <FightCardPoster
          title={title}
          subtitle={subtitle.trim() || null}
          themeColor={themeColor}
          titleFont={titleFont}
          backgroundId={backgroundId}
          bouts={previewBouts}
        />
      </div>
    </form>
  );
}
