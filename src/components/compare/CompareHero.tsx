"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
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

interface TradingCardProps {
  fighter: FighterDetail;
  champion: ChampionEntry | null;
  side: "left" | "right";
}

function TradingCard({ fighter, champion, side }: TradingCardProps) {
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
    <article
      className={cn(
        // base card — fixed aspect ratio keeps VS centered vertically
        "group relative flex w-full max-w-sm flex-col overflow-hidden rounded-xl p-5",
        "border-2 bg-gradient-to-b from-background-elevated to-background",
        "transition-transform duration-300 ease-out will-change-transform",
        // tilt + hover-straighten only at sm+, mobile lays flat & stacked
        side === "left"
          ? "sm:rotate-[-4deg] sm:hover:rotate-0"
          : "sm:rotate-[4deg] sm:hover:rotate-0",
        "sm:origin-bottom sm:hover:scale-[1.02]",
        // width — full mobile, 280 tablet, 320 desktop
        "sm:w-[280px] lg:w-[320px]",
        isChampion
          ? "border-primary/45 shadow-glow-primary"
          : "border-foreground/15",
      )}
    >
      <div
        className={cn(
          "relative aspect-[4/3] w-full overflow-hidden rounded-md",
          isChampion ? "ring-1 ring-primary/30" : "ring-1 ring-foreground/10",
        )}
      >
        {fighter.photo_url ? (
          <Image
            src={fighter.photo_url}
            alt=""
            fill
            sizes="320px"
            priority
            className="object-cover object-top brightness-[0.92] saturate-[0.95]"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ backgroundColor: hashColor(fighter.name_en) }}
            aria-hidden
          >
            <span
              className="font-display uppercase tracking-wider text-foreground/90"
              style={{ fontSize: 56 }}
            >
              {initialsOf(fighter.name_en)}
            </span>
          </div>
        )}
        {champion ? (
          <span
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-widest text-primary backdrop-blur-sm"
            aria-label={`${champion.division} champion`}
          >
            <Trophy className="h-3 w-3" aria-hidden />
            {champion.isInterim ? "Interim" : champion.divisionShort}
          </span>
        ) : null}
      </div>

      <h2
        className="mt-3 font-display uppercase leading-[0.92] tracking-tight text-foreground"
        style={{ fontSize: 28 }}
      >
        {fighter.name_en}
      </h2>
      {fighter.nickname ? (
        <p
          className="mt-0.5 truncate font-sans italic text-foreground-muted"
          style={{ fontSize: 13 }}
        >
          &ldquo;{fighter.nickname}&rdquo;
        </p>
      ) : null}
      <p className="mt-1 flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
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

      <div className="mt-3 flex items-baseline gap-2">
        <span
          className="font-display tabular leading-none tracking-tight text-foreground"
          style={{ fontSize: 48 }}
        >
          {record}
        </span>
        {wr != null ? (
          <span className="font-sans text-xs text-foreground-muted">
            {wr}% WR
          </span>
        ) : null}
      </div>

      <Link
        href={`/fighters/${fighter.slug}`}
        prefetch={false}
        className="mt-3 inline-flex items-center gap-1 self-start font-sans text-[11px] uppercase tracking-widest text-foreground-muted transition-colors hover:text-primary"
      >
        View profile
        <ChevronRight className="h-3 w-3" aria-hidden />
      </Link>
    </article>
  );
}

interface CompareHeroProps {
  a: FighterDetail;
  b: FighterDetail;
  championA: ChampionEntry | null;
  championB: ChampionEntry | null;
}

export function CompareHero({ a, b, championA, championB }: CompareHeroProps) {
  const reduced = useReducedMotion();

  // Mount-time entrance: cards slide in from outside and settle into tilt.
  // Honor reduced-motion — render static if the user prefers it.
  const leftInit = reduced
    ? { opacity: 1, x: 0, rotate: 0 }
    : { opacity: 0, x: -40, rotate: -10 };
  const leftAnim = reduced
    ? { opacity: 1, x: 0, rotate: 0 }
    : { opacity: 1, x: 0, rotate: 0 };
  const rightInit = reduced
    ? { opacity: 1, x: 0, rotate: 0 }
    : { opacity: 0, x: 40, rotate: 10 };
  const rightAnim = reduced
    ? { opacity: 1, x: 0, rotate: 0 }
    : { opacity: 1, x: 0, rotate: 0 };

  return (
    <div className="flex flex-col items-center justify-center gap-6 sm:flex-row sm:gap-4 md:gap-8 lg:gap-12">
      <motion.div
        initial={leftInit}
        animate={leftAnim}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-sm sm:w-auto"
      >
        <TradingCard fighter={a} champion={championA} side="left" />
      </motion.div>

      <motion.div
        initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: 0.3, ease: "easeOut" }}
        className="flex shrink-0 items-center justify-center sm:w-[80px] lg:w-[120px]"
      >
        <span
          aria-hidden
          className="font-display uppercase tracking-[0.2em] text-primary"
          style={{ fontSize: "clamp(56px, 7vw, 96px)", lineHeight: 1 }}
        >
          vs
        </span>
      </motion.div>

      <motion.div
        initial={rightInit}
        animate={rightAnim}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-sm sm:w-auto"
      >
        <TradingCard fighter={b} champion={championB} side="right" />
      </motion.div>
    </div>
  );
}
