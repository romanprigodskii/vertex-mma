import * as React from "react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import {
  formatWeightClass,
  resolveThemeBackground,
  resolveThemeColor,
  resolveThemeFont,
} from "@/lib/card-theme";
import { cn } from "@/lib/utils";

function useWeightLabel() {
  const tWeight = useTranslations("weight");
  return (wc: string): string => {
    const key = wc.replace(/-/g, "_");
    return tWeight.has(key)
      ? tWeight(key as "lightweight")
      : formatWeightClass(wc);
  };
}

export type PosterDisplayFighter = {
  slug: string | null;
  name: string;
  photoUrl: string | null;
  record: string | null;
};

export type PosterDisplayBout = {
  weightClass: string;
  isMain: boolean;
  fighterA: PosterDisplayFighter | null;
  fighterB: PosterDisplayFighter | null;
};

export type FightCardPosterProps = {
  title: string;
  subtitle: string | null;
  themeColor: string;
  titleFont: string;
  backgroundId: string;
  bouts: PosterDisplayBout[];
};

/**
 * The themed fight-card artifact. Pure presentational — rendered by the
 * public view page (server) and the builder's live preview (client).
 */
export function FightCardPoster({
  title,
  subtitle,
  themeColor,
  titleFont,
  backgroundId,
  bouts,
}: FightCardPosterProps) {
  const t = useTranslations("cards");
  const color = resolveThemeColor(themeColor);
  const font = resolveThemeFont(titleFont);
  const bg = resolveThemeBackground(backgroundId);

  const headliner = bouts.find((b) => b.isMain) ?? bouts[0] ?? null;
  const undercard = bouts.filter((b) => b !== headliner);
  // Only stamp the "MAIN EVENT" badge when the builder explicitly flagged a
  // bout. Otherwise the first bout is shown as a plain headliner — never
  // crowned with a label the user didn't choose.
  const hasExplicitMain = bouts.some((b) => b.isMain);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-foreground/10",
        bg.className,
      )}
      style={
        { "--card-accent": color.accent, ...bg.style } as React.CSSProperties
      }
    >
      <div className="relative px-5 py-8 sm:px-10 sm:py-12">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[var(--card-accent)]">
          {t("posterKicker")}
        </p>
        <h2
          className={cn(
            "mt-3 uppercase leading-[0.95] tracking-tight text-foreground line-clamp-3 break-words [text-wrap:balance]",
            font.className,
          )}
          style={{ fontSize: "clamp(28px, 4.6vw, 52px)" }}
        >
          {title || t("untitledCard")}
        </h2>
        {subtitle ? (
          <p className="mt-2 font-sans text-sm text-foreground-muted">
            {subtitle}
          </p>
        ) : null}
        <div className="mt-5 h-0.5 w-16 rounded-full bg-[var(--card-accent)]" />

        {headliner ? (
          <div className="mt-8">
            <PosterHeadliner bout={headliner} showMainBadge={hasExplicitMain} />
          </div>
        ) : (
          <p className="mt-8 font-sans text-sm text-foreground-subtle">
            {t("noBouts")}
          </p>
        )}

        {undercard.length > 0 ? (
          <ul className="mt-6 flex flex-col gap-2">
            {undercard.map((b, i) => (
              <li key={i}>
                <PosterUndercardRow bout={b} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function PosterHeadliner({
  bout,
  showMainBadge,
}: {
  bout: PosterDisplayBout;
  showMainBadge: boolean;
}) {
  const t = useTranslations("cards");
  const weightLabel = useWeightLabel();
  return (
    <div
      className="rounded-lg border px-4 py-5 sm:px-6"
      style={{
        borderColor: "color-mix(in oklch, var(--card-accent) 38%, transparent)",
        backgroundColor:
          "color-mix(in oklch, var(--card-accent) 8%, transparent)",
      }}
    >
      <div className="flex items-center justify-center gap-2">
        {showMainBadge ? (
          <span className="rounded-sm bg-[var(--card-accent)] px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-widest text-background-base">
            {t("mainEvent")}
          </span>
        ) : null}
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {weightLabel(bout.weightClass)}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-5">
        <PosterFighterColumn fighter={bout.fighterA} align="right" />
        <span className="font-display text-2xl text-[var(--card-accent)] sm:text-4xl">
          {t("vsLabel")}
        </span>
        <PosterFighterColumn fighter={bout.fighterB} align="left" />
      </div>
    </div>
  );
}

function PosterFighterColumn({
  fighter,
  align,
}: {
  fighter: PosterDisplayFighter | null;
  align: "left" | "right";
}) {
  const t = useTranslations("cards");
  const alignClass =
    align === "right" ? "items-end text-right" : "items-start text-left";

  if (!fighter) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-2", alignClass)}>
        <div className="h-20 w-20 rounded-md border border-dashed border-foreground/20 bg-foreground/[0.03] sm:h-24 sm:w-24" />
        <span className="font-display text-base uppercase tracking-tight text-foreground-subtle">
          {t("tbd")}
        </span>
      </div>
    );
  }

  const nameNode = (
    <span className="font-display text-base uppercase leading-tight tracking-tight text-foreground line-clamp-2 break-words [text-wrap:balance] sm:text-xl">
      {fighter.name}
    </span>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", alignClass)}>
      {fighter.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fighter.photoUrl}
          alt={fighter.name}
          className="h-20 w-20 rounded-md border border-foreground/15 object-cover sm:h-24 sm:w-24"
        />
      ) : (
        <div
          className="flex h-20 w-20 items-center justify-center rounded-md border border-foreground/15 bg-foreground/[0.04] sm:h-24 sm:w-24"
          aria-hidden
        >
          <span className="font-display text-3xl text-foreground-subtle">
            {fighter.name.slice(0, 1)}
          </span>
        </div>
      )}
      {fighter.slug ? (
        <Link
          href={`/fighters/${fighter.slug}`}
          prefetch={false}
          className="transition-colors hover:text-[var(--card-accent)]"
        >
          {nameNode}
        </Link>
      ) : (
        nameNode
      )}
      {fighter.record ? (
        <span className="font-mono text-[11px] tabular text-foreground-muted">
          {fighter.record}
        </span>
      ) : null}
    </div>
  );
}

function PosterUndercardRow({ bout }: { bout: PosterDisplayBout }) {
  const t = useTranslations("cards");
  const weightLabel = useWeightLabel();
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-md border border-foreground/10 bg-background-base/40 px-3 py-2.5 sm:gap-3">
      <span className="min-w-0 truncate text-right font-display text-sm uppercase tracking-tight text-foreground sm:text-base">
        <FighterInline fighter={bout.fighterA} />
      </span>
      <span className="flex shrink-0 flex-col items-center leading-none">
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--card-accent)]">
          {t("vsConnector")}
        </span>
        <span className="mt-1 font-mono text-[9px] uppercase tracking-wider text-foreground-subtle">
          {weightLabel(bout.weightClass)}
        </span>
      </span>
      <span className="min-w-0 truncate font-display text-sm uppercase tracking-tight text-foreground sm:text-base">
        <FighterInline fighter={bout.fighterB} />
      </span>
    </div>
  );
}

function FighterInline({
  fighter,
}: {
  fighter: PosterDisplayFighter | null;
}) {
  const t = useTranslations("cards");
  if (!fighter) return <span className="text-foreground-subtle">{t("tbd")}</span>;
  if (fighter.slug) {
    return (
      <Link
        href={`/fighters/${fighter.slug}`}
        prefetch={false}
        className="transition-colors hover:text-[var(--card-accent)]"
      >
        {fighter.name}
      </Link>
    );
  }
  return <span>{fighter.name}</span>;
}
