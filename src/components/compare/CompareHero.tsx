import Image from "next/image";
import Link from "next/link";
import { ChevronRight, Trophy } from "lucide-react";

import { type ChampionEntry } from "@/lib/champions";
import type { FighterDetail } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { cn } from "@/lib/utils";

const WEIGHT_LABEL: Record<string, string> = {
  strawweight: "Strawweight",
  flyweight: "Flyweight",
  bantamweight: "Bantamweight",
  featherweight: "Featherweight",
  lightweight: "Lightweight",
  welterweight: "Welterweight",
  middleweight: "Middleweight",
  light_heavyweight: "Light Heavyweight",
  heavyweight: "Heavyweight",
  catchweight: "Catchweight",
  openweight: "Openweight",
};

const PALETTE: readonly string[] = [
  "oklch(0.35 0.12 27)",
  "oklch(0.35 0.10 70)",
  "oklch(0.30 0.08 250)",
  "oklch(0.30 0.10 310)",
  "oklch(0.30 0.10 150)",
  "oklch(0.25 0.02 240)",
];

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function FighterPanel({
  fighter,
  champion,
  align,
}: {
  fighter: FighterDetail;
  champion: ChampionEntry | null;
  align: "left" | "right";
}) {
  const flag = getCountryFlag(fighter.country_code);
  const weightLabel = fighter.weight_class_primary
    ? WEIGHT_LABEL[fighter.weight_class_primary] ??
      fighter.weight_class_primary
    : null;
  const denom = fighter.wins_total + fighter.losses_total;
  const wr = denom > 0 ? Math.round((fighter.wins_total / denom) * 100) : null;
  const record =
    fighter.draws_total > 0
      ? `${fighter.wins_total}—${fighter.losses_total}—${fighter.draws_total}`
      : `${fighter.wins_total}—${fighter.losses_total}`;
  const isChampion = champion !== null;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3",
        align === "right" ? "lg:items-end lg:text-right" : "lg:items-start lg:text-left",
      )}
    >
      <div
        className={cn(
          "relative h-[200px] w-[200px] overflow-hidden rounded-md sm:h-[240px] sm:w-[240px]",
          isChampion
            ? "border-2 border-primary/40 shadow-glow-primary"
            : "border border-foreground/10",
        )}
      >
        {fighter.photo_url ? (
          <Image
            src={fighter.photo_url}
            alt=""
            fill
            sizes="240px"
            priority
            className="object-cover object-top brightness-[0.95]"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ backgroundColor: hashColor(fighter.name_en) }}
            aria-hidden
          >
            <span
              className="font-display uppercase tracking-wider text-foreground/90"
              style={{ fontSize: 64 }}
            >
              {initialsOf(fighter.name_en)}
            </span>
          </div>
        )}
        {champion ? (
          <span
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-primary/35 bg-primary/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-widest text-primary backdrop-blur-sm"
            aria-label={`${champion.division} champion`}
          >
            <Trophy className="h-3 w-3" aria-hidden />
            {champion.isInterim ? "Interim" : champion.divisionShort}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col items-center gap-1 lg:items-stretch">
        <h2
          className={cn(
            "font-display uppercase leading-[0.92] tracking-tight text-foreground",
            "text-[36px] sm:text-[44px]",
            align === "right" ? "lg:text-right" : "lg:text-left",
          )}
        >
          {fighter.name_en}
        </h2>
        {fighter.nickname ? (
          <p className="font-sans text-sm italic text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </p>
        ) : null}
        <p className="flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
          <span aria-hidden className="text-[13px] leading-none">
            {flag}
          </span>
          {fighter.country_code ? <span>{fighter.country_code}</span> : null}
          {weightLabel ? (
            <>
              <span aria-hidden className="text-foreground-subtle/40">·</span>
              <span>{weightLabel}</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-col items-center gap-0.5">
        <span className="font-display tabular text-4xl leading-none tracking-tight text-foreground sm:text-[44px]">
          {record}
        </span>
        <span className="font-sans text-xs text-foreground-muted">
          {wr != null ? `${wr}% win rate` : "Record pending"}
        </span>
      </div>

      <Link
        href={`/fighters/${fighter.slug}`}
        prefetch={false}
        className="inline-flex items-center gap-1 font-sans text-[11px] uppercase tracking-widest text-foreground-muted transition-colors hover:text-primary"
      >
        View profile
        <ChevronRight className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}

interface CompareHeroProps {
  a: FighterDetail;
  b: FighterDetail;
  championA: ChampionEntry | null;
  championB: ChampionEntry | null;
}

export function CompareHero({ a, b, championA, championB }: CompareHeroProps) {
  return (
    <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1fr_auto_1fr] lg:gap-12">
      <FighterPanel fighter={a} champion={championA} align="left" />
      <div className="flex items-center justify-center lg:mt-24">
        <span className="font-display text-3xl uppercase tracking-[0.4em] text-foreground-subtle">
          vs
        </span>
      </div>
      <FighterPanel fighter={b} champion={championB} align="right" />
    </div>
  );
}
