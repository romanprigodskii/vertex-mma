import Image from "next/image";
import Link from "next/link";

import { WEIGHT_CLASSES } from "@/lib/constants";
import { getCountryFlag } from "@/lib/fighter-helpers";
import type { FighterCatalogRow } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const DEFAULT_SILHOUETTE = "/images/silhouette-fighter-male.svg";
const FEMALE_WEIGHT_CLASSES = new Set([
  "strawweight",
  "flyweight",
  "bantamweight",
  "featherweight",
]);

function photoSrcFor(row: FighterCatalogRow): { src: string; isReal: boolean } {
  if (row.photo_url) {
    return { src: row.photo_url, isReal: true };
  }
  if (row.photo_silhouette_url) {
    return { src: row.photo_silhouette_url, isReal: false };
  }
  // Heuristic gender silhouette by weight class.
  // (Female-only divisions in our enum currently overlap with men's lower divs,
  // so we keep the male silhouette as the universal default and only switch
  // when we have a clearly female-coded division. Refine in Wave 3B.)
  const isLikelyFemale =
    row.weight_class_primary != null &&
    FEMALE_WEIGHT_CLASSES.has(row.weight_class_primary) &&
    row.name_en.match(/\b(she|her|ms\.)\b/i) != null; // intentionally narrow
  return {
    src: isLikelyFemale
      ? "/images/silhouette-fighter-female.svg"
      : DEFAULT_SILHOUETTE,
    isReal: false,
  };
}

const WEIGHT_LABEL_LOOKUP: Record<string, { label: string; limit: number }> =
  Object.fromEntries(
    WEIGHT_CLASSES.map((w) => [w.id, { label: w.label, limit: w.limitLb }]),
  );

function weightLabelFor(id: string | null): { short: string; full: string } | null {
  if (!id) return null;
  const known = WEIGHT_LABEL_LOOKUP[id];
  if (known) {
    // Short = first letters of each word, e.g. "Light Heavyweight" → "LHW"
    const short = known.label
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    return { short, full: known.label };
  }
  if (id === "catchweight") return { short: "CW", full: "Catchweight" };
  if (id === "openweight") return { short: "OW", full: "Openweight" };
  return null;
}

function formatRecord(w: number, l: number, d: number): string {
  if (d > 0) return `${w}-${l}-${d}`;
  return `${w}-${l}`;
}

interface FighterCardProps {
  fighter: FighterCatalogRow;
  /** Used by next/image as the responsive sizes attr. */
  sizes?: string;
  /** When true, eagerly load image (above-the-fold). */
  priority?: boolean;
  className?: string;
}

export function FighterCard({
  fighter,
  sizes = "(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  priority = false,
  className,
}: FighterCardProps) {
  const { src, isReal } = photoSrcFor(fighter);
  const weight = weightLabelFor(fighter.weight_class_primary);
  const flag = getCountryFlag(fighter.country_code);
  const record = formatRecord(
    fighter.wins_total,
    fighter.losses_total,
    fighter.draws_total,
  );
  const hasNickname = Boolean(fighter.nickname?.trim());
  // TODO Wave 3B: champion badge once current-champion data exists.

  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      className={cn(
        "group relative block aspect-[3/4] overflow-hidden rounded-lg",
        "border border-border bg-background-elevated",
        "transition-[transform,border-color,box-shadow] duration-200 ease-out",
        "hover:-translate-y-1 hover:border-primary/60",
        "hover:shadow-[0_8px_24px_-8px_oklch(0.62_0.22_27/0.35),inset_0_0_0_1px_oklch(0.62_0.22_27/0.25)]",
        "focus-visible:-translate-y-1 focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
        "active:scale-[0.98]",
        className,
      )}
      aria-label={`${fighter.name_en}${
        fighter.nickname ? ` (${fighter.nickname})` : ""
      }, record ${record}`}
    >
      {/* Photo */}
      <Image
        src={src}
        alt=""
        fill
        sizes={sizes}
        priority={priority}
        className={cn(
          "object-cover object-top transition-transform duration-300 ease-out",
          "group-hover:scale-[1.03]",
          !isReal && "opacity-60 object-contain p-6 mix-blend-screen",
        )}
        unoptimized={!isReal}
      />

      {/* Top dim for badge legibility */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-background-base/70 to-transparent"
      />

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-2">
        {weight ? (
          <span
            className="inline-flex h-5 items-center rounded-sm border border-border-strong/60 bg-background-base/40 px-1.5 font-mono text-[10px] uppercase tracking-wider text-foreground backdrop-blur-sm"
            title={weight.full}
          >
            {weight.short}
          </span>
        ) : (
          <span aria-hidden />
        )}
        {fighter.hall_of_fame_year ? (
          <span
            className="inline-flex h-5 items-center rounded-sm border border-gold/40 bg-gold/15 px-1.5 font-mono text-[10px] uppercase tracking-wider text-gold backdrop-blur-sm"
            title={`Hall of Fame ${fighter.hall_of_fame_year}`}
          >
            HOF
          </span>
        ) : null}
      </div>

      {/* Bottom gradient + name plate */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col">
        <div className="bg-gradient-to-t from-background-base via-background-base/90 to-transparent px-3 pb-2 pt-16">
          {hasNickname ? (
            <p className="truncate font-display text-lg uppercase tracking-wide text-foreground leading-tight">
              {fighter.nickname}
            </p>
          ) : null}
          <p
            className={cn(
              "truncate font-sans leading-tight",
              hasNickname
                ? "text-xs text-foreground-muted"
                : "text-base font-medium text-foreground",
            )}
          >
            {fighter.name_en}
          </p>
        </div>

        {/* Stats strip */}
        <div className="flex items-center justify-between gap-2 border-t border-border bg-background-base/95 px-3 py-2 backdrop-blur-sm">
          <span className="font-mono tabular text-base font-semibold leading-none text-foreground">
            {record}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-foreground-subtle">
            <span aria-hidden className="text-sm leading-none">
              {flag}
            </span>
            {weight ? (
              <span className="truncate">{weight.full}</span>
            ) : (
              <span className="truncate">—</span>
            )}
          </span>
        </div>
      </div>
    </Link>
  );
}
