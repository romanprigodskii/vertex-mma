import Link from "next/link";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import type { ChampionEntry } from "@/lib/champions";
import { getCountryFlag } from "@/lib/fighter-helpers";
import type { FighterCatalogRow } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

interface ChampionCardProps {
  entry: ChampionEntry;
  fighter: FighterCatalogRow | null;
}

const CARD_BASE = cn(
  "group relative flex h-[120px] shrink-0 snap-start items-center gap-4",
  "w-[280px] sm:w-[320px]",
  "rounded-lg border px-4 py-3",
  "bg-gradient-to-br from-background-elevated to-background-base",
  "transition-[transform,border-color] duration-200 ease-out",
);

export function ChampionCard({ entry, fighter }: ChampionCardProps) {
  if (!fighter) {
    return (
      <div
        className={cn(
          CARD_BASE,
          "border-border/40 text-foreground-subtle",
        )}
        aria-label={`${entry.division}: data missing`}
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-border bg-background-base/40">
          <span className="font-mono text-[10px] uppercase tracking-wider">
            n/a
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl uppercase tracking-tight text-foreground-muted">
            TBD
          </p>
          <p className="font-sans text-[11px] uppercase tracking-widest text-gold">
            {entry.divisionShort} · {entry.isInterim ? "INTERIM" : "CHAMPION"}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-foreground-subtle">
            slug not found
          </p>
        </div>
      </div>
    );
  }

  const flag = getCountryFlag(fighter.country_code);
  const hasNickname = Boolean(fighter.nickname?.trim());
  const record =
    fighter.draws_total > 0
      ? `${fighter.wins_total}-${fighter.losses_total}-${fighter.draws_total}`
      : `${fighter.wins_total}-${fighter.losses_total}`;
  const titleLabel = entry.isInterim ? "INTERIM CHAMP" : "CHAMPION";

  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      className={cn(
        CARD_BASE,
        "border-red-accent/30",
        "hover:scale-[1.02] hover:border-red-accent/55 hover:shadow-glow-red-accent",
        "focus-visible:scale-[1.02] focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
      )}
      aria-label={`${fighter.name_en}, ${entry.division} ${titleLabel}, record ${record}`}
    >
      <FighterAvatar
        name={fighter.name_en}
        photoUrl={fighter.photo_url}
        size="lg"
        imageSizes="80px"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="truncate font-display text-[22px] uppercase leading-none tracking-tight text-foreground">
          {fighter.name_en}
        </h3>
        {hasNickname ? (
          <p className="truncate font-sans text-[12px] italic leading-snug text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </p>
        ) : (
          <p className="font-sans text-[12px] italic leading-snug text-foreground-subtle/60">
            —
          </p>
        )}
        <div className="mt-1 h-px w-8 bg-gold/40" aria-hidden />
        <p className="mt-1 font-sans text-[11px] uppercase leading-snug tracking-[0.18em] text-gold">
          {entry.divisionShort} · {titleLabel}
        </p>
        <p className="mt-0.5 font-sans text-[13px] leading-snug text-foreground-muted">
          <span aria-hidden className="mr-1 text-[15px] leading-none">
            {flag}
          </span>
          <span className="font-mono tabular text-foreground">{record}</span>
        </p>
      </div>
    </Link>
  );
}
