"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

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
  // Keys of bouts flagged on the last failed submit (missing a fighter), so
  // we can outline the offending bout(s) instead of only a generic banner.
  const [invalidKeys, setInvalidKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  const boutRefs = React.useRef<Record<string, HTMLLIElement | null>>({});

  /** Drop the stale invalid-bout highlights once the user edits anything. */
  function clearInvalid() {
    setInvalidKeys((cur) => (cur.size === 0 ? cur : new Set()));
  }

  /** Map a server action's stable error code to a localized message. The
   *  action layer never returns prose — keep this in sync with actions.ts. */
  function actionErrorMessage(code: string): string {
    switch (code) {
      case "NOT_SIGNED_IN":
        return t("errNotSignedIn");
      case "CARD_NOT_FOUND":
        return t("cardNotFound");
      case "NOT_YOUR_CARD":
        return t("errNotYourCard");
      case "NO_BOUTS":
        return t("atLeastOneBout");
      case "TOO_MANY_BOUTS":
        return t("errTooManyBouts", { max: MAX_BOUTS });
      case "BOUT_NEEDS_FIGHTERS":
        return t("needFighters");
      case "FIGHTER_VS_SELF":
        return t("errFighterVsSelf");
      case "INVALID_WEIGHT_CLASS":
        return t("errInvalidWeight");
      case "TOO_MANY_MAIN_EVENTS":
        return t("errTooManyMain");
      case "INVALID_TITLE":
        return t("titleTooShort");
      case "INVALID_SUBTITLE":
        return t("errSubtitleTooLong");
      default:
        return t("errGeneric");
    }
  }

  /** Localized accent-color name, falling back to the registry's English
   *  label for any id without a translation key. */
  function colorLabel(id: string): string {
    const key = `color${id.charAt(0).toUpperCase()}${id.slice(1)}`;
    if (t.has(key as "colorPrimary")) return t(key as "colorPrimary");
    return CARD_THEME_COLORS.find((c) => c.id === id)?.label ?? id;
  }

  function addBout() {
    setBouts((cur) => (cur.length >= MAX_BOUTS ? cur : [...cur, freshBout()]));
  }
  function removeBout(key: string) {
    clearInvalid();
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
    clearInvalid();
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
    const incomplete = bouts.filter((b) => !b.fighterA || !b.fighterB);
    if (incomplete.length > 0) {
      setError(t("boutsNeedFighters"));
      setInvalidKeys(new Set(incomplete.map((b) => b.key)));
      // Bring the first incomplete bout into view so the user isn't left
      // hunting for the offending slot on a long card.
      boutRefs.current[incomplete[0].key]?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      return;
    }
    setInvalidKeys(new Set());

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
      setError(actionErrorMessage(res.error));
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
      setError(actionErrorMessage(res.error));
      return;
    }
    // The one-shot `deleted` flag drives a brief success toast on /cards.
    router.push("/cards?deleted=1");
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
            <div className="flex flex-wrap items-center gap-2">
              {CARD_THEME_COLORS.map((c) => {
                const selected = themeColor === c.id;
                const label = colorLabel(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setThemeColor(c.id)}
                    aria-label={label}
                    aria-pressed={selected}
                    title={label}
                    className={cn(
                      "relative flex h-8 w-8 items-center justify-center rounded-full transition-transform hover:scale-110",
                      selected
                        ? "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background-base"
                        : "ring-1 ring-foreground/20",
                    )}
                    style={{ backgroundColor: c.accent }}
                  >
                    {selected ? (
                      <Check
                        className="h-4 w-4 text-background-base"
                        strokeWidth={3}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            <p className="font-sans text-[11px] text-foreground-muted">
              {t("accentSelected", { color: colorLabel(themeColor) })}
            </p>
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
                ref={(el) => {
                  boutRefs.current[b.key] = el;
                }}
                className={cn(
                  "rounded-md border bg-background-elevated/30 p-3",
                  invalidKeys.has(b.key)
                    ? "border-streak-loss/60"
                    : "border-foreground/10",
                )}
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
                    invalid={invalidKeys.has(b.key) && !b.fighterA}
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
                    invalid={invalidKeys.has(b.key) && !b.fighterB}
                    onPick={(f) =>
                      patchBout(b.key, { fighterB: toBoutFighter(f) })
                    }
                    onClear={() => patchBout(b.key, { fighterB: null })}
                    excludedIds={usedFighterIds}
                  />
                </div>
                {invalidKeys.has(b.key) ? (
                  <p
                    className="mt-2 font-sans text-[11px] text-streak-loss"
                    role="alert"
                  >
                    {t("incompleteBout")}
                  </p>
                ) : null}

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
