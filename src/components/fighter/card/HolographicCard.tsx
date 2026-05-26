"use client";

import * as React from "react";
import Image from "next/image";
import { Trophy } from "lucide-react";

import type { ChampionEntry } from "@/lib/champions";
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  type FighterAttributes,
} from "@/lib/fighter-attributes";
import type { FighterDetail } from "@/lib/fighter-detail";
import type { FightHistoryEntry } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { cn } from "@/lib/utils";

interface HolographicCardProps {
  fighter: FighterDetail;
  championEntry: ChampionEntry | null;
  attributes: FighterAttributes;
  recentHistory: FightHistoryEntry[];
}

type Tier = "champion" | "elite" | "roster";

function tierOf(
  fighter: FighterDetail,
  champion: ChampionEntry | null,
): Tier {
  if (champion) return "champion";
  const denom = fighter.wins_total + fighter.losses_total;
  const wr = denom > 0 ? fighter.wins_total / denom : 0;
  if (fighter.wins_total >= 20 && wr >= 0.75) return "elite";
  return "roster";
}

const TIER_LABEL: Record<Tier, string> = {
  champion: "Champion",
  elite: "Elite",
  roster: "Roster",
};

const TIER_BORDER: Record<Tier, string> = {
  champion: "border-primary/55 shadow-glow-primary",
  elite: "border-foreground/30",
  roster: "border-foreground/15",
};

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

const FOIL_OVERLAY_STYLE: React.CSSProperties = {
  background:
    "conic-gradient(from 200deg at var(--mx, 50%) var(--my, 50%)," +
    " oklch(0.78 0.15 70 / 0.18)," +
    " oklch(0.62 0.20 320 / 0.14)," +
    " oklch(0.55 0.15 230 / 0.16)," +
    " oklch(0.78 0.15 70 / 0.18))",
  mixBlendMode: "screen",
};

const SHEEN_OVERLAY_STYLE: React.CSSProperties = {
  background:
    "radial-gradient(circle at var(--mx, 50%) var(--my, 50%)," +
    " oklch(0.98 0 0 / 0.16) 0%," +
    " oklch(0.98 0 0 / 0) 35%)",
  mixBlendMode: "screen",
};

export function HolographicCard({
  fighter,
  championEntry,
  attributes,
  recentHistory,
}: HolographicCardProps) {
  const tilt = React.useRef<HTMLDivElement>(null);
  const raf = React.useRef<number | null>(null);
  const [flipped, setFlipped] = React.useState(false);

  const tier = tierOf(fighter, championEntry);

  React.useEffect(() => {
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const node = tilt.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      node.style.setProperty("--rx", `${-(y - 0.5) * 14}deg`);
      node.style.setProperty("--ry", `${(x - 0.5) * 14}deg`);
      node.style.setProperty("--mx", `${x * 100}%`);
      node.style.setProperty("--my", `${y * 100}%`);
    });
  };

  const handleLeave = () => {
    const node = tilt.current;
    if (!node) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    node.style.setProperty("--rx", "0deg");
    node.style.setProperty("--ry", "0deg");
    node.style.setProperty("--mx", "50%");
    node.style.setProperty("--my", "50%");
  };

  return (
    <div className="select-none" style={{ perspective: "1200px" }}>
      <div
        ref={tilt}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={() => setFlipped((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            setFlipped((v) => !v);
          }
        }}
        aria-label={`Holographic card for ${fighter.name_en}. Click to flip.`}
        className={cn(
          "group relative aspect-[3/4] w-[300px] cursor-pointer sm:w-[360px]",
          "outline-none focus-visible:ring-2 focus-visible:ring-primary",
          "focus-visible:ring-offset-4 focus-visible:ring-offset-background-base",
          "transition-transform duration-150 ease-out will-change-transform",
        )}
        style={
          {
            transformStyle: "preserve-3d",
            transform:
              "rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))",
          } as React.CSSProperties
        }
      >
        {/* Flip wrapper */}
        <div
          className={cn(
            "absolute inset-0 transition-transform duration-700 ease-[cubic-bezier(0.4,0,0.2,1)]",
          )}
          style={{
            transformStyle: "preserve-3d",
            transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
          }}
        >
          <CardFront
            fighter={fighter}
            championEntry={championEntry}
            tier={tier}
          />
          <CardBack
            fighter={fighter}
            attributes={attributes}
            tier={tier}
            recentHistory={recentHistory}
          />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Front face                                                                 */
/* -------------------------------------------------------------------------- */

function CardFace({
  tier,
  children,
  isBack = false,
}: {
  tier: Tier;
  children: React.ReactNode;
  isBack?: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col overflow-hidden rounded-xl border-2",
        "bg-[radial-gradient(circle_at_30%_20%,oklch(0.18_0.02_240),oklch(0.08_0.005_240))]",
        TIER_BORDER[tier],
      )}
      style={{
        backfaceVisibility: "hidden",
        WebkitBackfaceVisibility: "hidden",
        transform: isBack ? "rotateY(180deg)" : undefined,
      }}
    >
      {children}
      {/* Foil + sheen overlays — under content, above bg. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={FOIL_OVERLAY_STYLE}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={SHEEN_OVERLAY_STYLE}
      />
      {/* Vignette */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 55%, oklch(0.08 0.005 240 / 0.85) 100%)",
        }}
      />
    </div>
  );
}

function CardFront({
  fighter,
  championEntry,
  tier,
}: {
  fighter: FighterDetail;
  championEntry: ChampionEntry | null;
  tier: Tier;
}) {
  const flag = getCountryFlag(fighter.country_code);
  const weightLabel = fighter.weight_class_primary
    ? WEIGHT_LABEL[fighter.weight_class_primary] ??
      fighter.weight_class_primary
    : null;
  const record =
    fighter.draws_total > 0
      ? `${fighter.wins_total}-${fighter.losses_total}-${fighter.draws_total}`
      : `${fighter.wins_total}-${fighter.losses_total}`;

  return (
    <CardFace tier={tier}>
      {/* Tier badge top-right */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5">
        {tier === "champion" ? (
          <Trophy className="h-3.5 w-3.5 text-primary" aria-hidden />
        ) : null}
        <span
          className={cn(
            "font-sans text-[10px] font-medium uppercase tracking-[0.22em]",
            tier === "champion"
              ? "text-primary"
              : tier === "elite"
                ? "text-foreground"
                : "text-foreground-muted",
          )}
        >
          {championEntry?.isInterim ? "Interim Champ" : TIER_LABEL[tier]}
        </span>
      </div>

      {/* Photo */}
      <div
        className="relative z-10 mx-auto mt-12 h-[200px] w-[200px] overflow-hidden rounded-lg border border-foreground/10 sm:h-[240px] sm:w-[240px]"
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
              className="font-sans font-bold uppercase tracking-wider text-foreground/90"
              style={{ fontSize: 64 }}
            >
              {initialsOf(fighter.name_en)}
            </span>
          </div>
        )}
      </div>

      {/* Identity block */}
      <div className="relative z-10 mt-3 flex flex-1 flex-col items-center px-4 text-center">
        <h2 className="font-sans font-bold text-[28px] uppercase leading-none tracking-tight text-foreground sm:text-3xl">
          {fighter.name_en}
        </h2>
        {fighter.nickname ? (
          <p className="mt-1 line-clamp-1 font-sans text-[12px] italic text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </p>
        ) : null}
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-sans font-bold tabular text-[40px] leading-none tracking-tight text-foreground">
            {record}
          </span>
        </div>
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 font-sans text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
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

      {/* Footer wordmark */}
      <div className="relative z-10 mb-3 flex items-center justify-between px-4">
        <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-foreground-subtle">
          MMA · 2026
        </span>
        <span className="font-sans font-bold text-[13px] tracking-[0.32em]">
          <span className="text-primary">V</span>
          <span className="text-foreground">ERTEX</span>
        </span>
      </div>
    </CardFace>
  );
}

/* -------------------------------------------------------------------------- */
/*  Back face                                                                  */
/* -------------------------------------------------------------------------- */

function CardBack({
  fighter,
  attributes,
  tier,
  recentHistory,
}: {
  fighter: FighterDetail;
  attributes: FighterAttributes;
  tier: Tier;
  recentHistory: FightHistoryEntry[];
}) {
  const ufcTotalWins = fighter.ufc_wins;
  const koPct = ufcTotalWins
    ? Math.round((fighter.ufc_wins_ko / ufcTotalWins) * 100)
    : 0;
  const subPct = ufcTotalWins
    ? Math.round((fighter.ufc_wins_sub / ufcTotalWins) * 100)
    : 0;
  const decPct = ufcTotalWins
    ? Math.round((fighter.ufc_wins_dec / ufcTotalWins) * 100)
    : 0;

  const lastFive = recentHistory.slice(0, 5);

  return (
    <CardFace tier={tier} isBack>
      <div className="relative z-10 flex flex-1 flex-col px-5 py-5">
        <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-foreground-subtle">
          Attributes
        </p>

        <ul className="mt-2 flex flex-col gap-1.5">
          {ATTRIBUTE_KEYS.map((key) => {
            const value = attributes[key];
            return (
              <li
                key={key}
                className="flex items-center gap-2 font-sans text-[11px] text-foreground"
              >
                <span className="w-[72px] shrink-0 uppercase tracking-widest text-foreground-muted">
                  {ATTRIBUTE_LABELS[key]}
                </span>
                <span className="relative h-1 flex-1 overflow-hidden rounded-sm bg-foreground/[0.08]">
                  <span
                    className="absolute inset-y-0 left-0 rounded-sm bg-primary/80"
                    style={{ width: `${value}%` }}
                  />
                </span>
                <span className="w-7 shrink-0 text-right font-mono tabular text-foreground">
                  {value}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 border-t border-foreground/10 pt-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-foreground-subtle">
            UFC career
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-[11px] text-foreground-muted">
            <span>
              <span className="font-mono tabular text-foreground">
                {fighter.ufc_wins}-{fighter.ufc_losses}
              </span>{" "}
              record
            </span>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>
              KO{" "}
              <span className="font-mono tabular text-foreground">
                {koPct}%
              </span>
            </span>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>
              Sub{" "}
              <span className="font-mono tabular text-foreground">
                {subPct}%
              </span>
            </span>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>
              Dec{" "}
              <span className="font-mono tabular text-foreground">
                {decPct}%
              </span>
            </span>
          </p>
        </div>

        {lastFive.length > 0 ? (
          <div className="mt-4 border-t border-foreground/10 pt-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-foreground-subtle">
              Last {lastFive.length}
            </p>
            <div className="mt-2 flex items-center gap-1.5">
              {lastFive.map((h) => (
                <span
                  key={h.bout_id}
                  title={`${h.event_date.slice(0, 10)} · ${h.result} vs ${h.opponent_name}`}
                  className={cn(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full font-sans font-bold text-[10px]",
                    h.result === "W"
                      ? "bg-streak-win/80 text-background-base"
                      : h.result === "L"
                        ? "bg-streak-loss/80 text-foreground"
                        : "bg-foreground-muted/40 text-foreground",
                  )}
                >
                  {h.result}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-auto pt-3">
          <p className="text-center font-sans font-bold text-[14px] tracking-[0.32em]">
            <span className="text-primary">V</span>
            <span className="text-foreground">ERTEX · </span>
            <span className="text-foreground-muted">MMA</span>
          </p>
        </div>
      </div>
    </CardFace>
  );
}
