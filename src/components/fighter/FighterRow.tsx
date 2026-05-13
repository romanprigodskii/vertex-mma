import Link from "next/link";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { WEIGHT_CLASSES } from "@/lib/constants";
import { getCountryFlag } from "@/lib/fighter-helpers";
import type { FighterCatalogRow } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const WEIGHT_LABELS: Record<string, string> = Object.fromEntries(
  WEIGHT_CLASSES.map((w) => [w.id, w.label]),
);
WEIGHT_LABELS["catchweight"] = "Catchweight";
WEIGHT_LABELS["openweight"] = "Openweight";

interface FighterRowProps {
  fighter: FighterCatalogRow;
  /** 1-indexed list position. When provided alongside `showRank`, renders #N. */
  rank?: number;
  showRank?: boolean;
  priority?: boolean;
  className?: string;
}

export function FighterRow({
  fighter,
  rank,
  showRank = false,
  priority = false,
  className,
}: FighterRowProps) {
  const weightLabel = fighter.weight_class_primary
    ? WEIGHT_LABELS[fighter.weight_class_primary] ?? null
    : null;
  const flag = getCountryFlag(fighter.country_code);
  const hasNickname = Boolean(fighter.nickname?.trim());
  const record =
    fighter.draws_total > 0
      ? `${fighter.wins_total}-${fighter.losses_total}-${fighter.draws_total}`
      : `${fighter.wins_total}-${fighter.losses_total}`;
  const noContestSuffix =
    fighter.no_contests > 0 ? `${fighter.no_contests} NC` : null;

  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      className={cn(
        "group grid grid-cols-[40px_64px_1fr_auto] items-center gap-3 px-2 py-2.5",
        "sm:grid-cols-[48px_72px_1fr_auto] sm:gap-4 sm:px-4 sm:py-3",
        "border-b border-foreground/[0.06] last:border-b-0",
        "transition-colors duration-150",
        "hover:bg-foreground/[0.03]",
        "focus-visible:outline-none focus-visible:bg-foreground/[0.04]",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
        className,
      )}
      aria-label={`${fighter.name_en}${
        hasNickname ? ` (${fighter.nickname})` : ""
      }, record ${record}`}
    >
      {/* Rank column */}
      <span
        className={cn(
          "text-right font-display text-2xl leading-none tracking-wider tabular text-foreground-subtle",
          "sm:text-[28px]",
          !showRank || !rank ? "opacity-0" : null,
        )}
        aria-hidden={!showRank}
      >
        {showRank && rank ? `#${rank}` : "#"}
      </span>

      {/* Avatar */}
      <FighterAvatar
        name={fighter.name_en}
        photoUrl={fighter.photo_url}
        size="md"
        priority={priority}
        imageSizes="72px"
      />

      {/* Identity column */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate font-display text-lg uppercase leading-none tracking-tight text-foreground sm:text-[22px]">
          {fighter.name_en}
        </h3>
        {hasNickname ? (
          <p className="truncate font-sans text-[13px] italic leading-snug text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </p>
        ) : null}
        <p className="truncate font-sans text-[11px] leading-snug text-foreground-subtle sm:text-xs">
          <span aria-hidden className="mr-1 text-[14px] leading-none">
            {flag}
          </span>
          {weightLabel ? (
            <span className="uppercase tracking-wide">{weightLabel}</span>
          ) : (
            <span className="uppercase tracking-wide opacity-60">—</span>
          )}
          <span aria-hidden className="mx-1.5 text-foreground-subtle/40">·</span>
          <span className="tabular">{fighter.bout_count}</span> fights
        </p>
      </div>

      {/* Record column */}
      <div className="flex flex-col items-end gap-0.5 pl-1">
        <span className="font-display text-xl leading-none tabular tracking-tight text-foreground sm:text-2xl">
          {record}
        </span>
        {noContestSuffix ? (
          <span className="font-sans text-[10px] uppercase tracking-wider text-foreground-subtle sm:text-[11px]">
            {noContestSuffix}
          </span>
        ) : null}
        {/* TODO Wave 3B: champion crown / interim chip would slot here */}
      </div>
    </Link>
  );
}
