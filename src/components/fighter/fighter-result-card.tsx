"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { Crown } from "lucide-react";

import {
  TIER_STYLES,
  type ChampionStatus,
  type VertexTier,
} from "@/lib/vertex-tier";

export interface FighterResultCardData {
  id: string;
  slug: string;
  name: string;
  nickname: string | null;
  photo_thumbnail_url: string | null;
  weight_class: string | null;
  wins_total: number | null;
  losses_total: number | null;
  draws_total: number | null;
  vertex_score: number | null;
  vertex_score_all_time: number | null;
  ufc_bouts: number;
  tier: VertexTier;
  championStatus: ChampionStatus;
}

interface Props {
  fighter: FighterResultCardData;
  /** Provide either an `onClick` (button) or an `href` (link); `onClick`
   *  also fires alongside link navigation so callers can close menus. */
  onClick?: () => void;
  href?: string;
}

const SHORT_WEIGHT: Record<string, string> = {
  strawweight: "STRAW",
  flyweight: "FLY",
  bantamweight: "BANTAM",
  featherweight: "FEATHER",
  lightweight: "LIGHT",
  welterweight: "WELTER",
  middleweight: "MIDDLE",
  light_heavyweight: "LIGHT-HVY",
  heavyweight: "HEAVY",
  catchweight: "CATCH",
  openweight: "OPEN",
};

function shortWeight(w: string | null): string {
  if (!w) return "—";
  return SHORT_WEIGHT[w] ?? w.replace(/_/g, " ").toUpperCase();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * Vertical poster-style fighter card for search surfaces. Photo on top,
 * info stacked below on a flat surface, dual CUR/ALL score chip pinned
 * to the bottom. Tier is signalled by a small text chip on the photo and
 * a 1px tier-coloured edge on the card; champions wear an icon-only
 * crown next to the tier chip.
 */
export function FighterResultCard({ fighter, onClick, href }: Props) {
  const style = TIER_STYLES[fighter.tier];
  const record =
    fighter.wins_total != null && fighter.losses_total != null
      ? `${fighter.wins_total}-${fighter.losses_total}${
          fighter.draws_total ? `-${fighter.draws_total}` : ""
        }`
      : null;
  const isChamp =
    fighter.championStatus === "active" ||
    fighter.championStatus === "dominant";

  const tierLabel = style.badgeText || null;

  const inner = (
    <>
      <div className="relative aspect-square w-full overflow-hidden bg-foreground/[0.04]">
        {fighter.photo_thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={fighter.photo_thumbnail_url}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-display text-4xl tracking-widest text-foreground-subtle">
            {initials(fighter.name)}
          </div>
        )}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3"
          style={{
            background:
              "linear-gradient(180deg, transparent, oklch(0.14 0.01 240 / 0.7))",
          }}
          aria-hidden
        />
        {/* Top-right photo corner: tier text chip + (optional) crown mark.
            Crown is icon-only — no "Champion" label, no backdrop-blur — so
            the corner reads as one quiet identity chip, not two stacked pills. */}
        {tierLabel || isChamp ? (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
            {tierLabel ? (
              <span
                className="rounded-sm bg-background-base/75 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest"
                style={{ color: style.scoreColor }}
              >
                {tierLabel}
              </span>
            ) : null}
            {isChamp ? (
              <span
                className="flex items-center rounded-sm bg-background-base/75 px-1 py-0.5"
                style={{ color: "oklch(0.85 0.18 75)" }}
                title="Champion"
              >
                <Crown className="h-2.5 w-2.5" aria-hidden />
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="relative flex flex-1 flex-col gap-1 px-3 py-2.5">
        <p className="truncate font-display text-sm uppercase tracking-tight text-foreground">
          {fighter.name}
        </p>
        {fighter.nickname ? (
          <p className="-mt-1 truncate font-sans text-[10px] italic text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </p>
        ) : null}
        <p
          className="font-display text-xl leading-none tabular text-foreground"
          style={{ color: record ? undefined : "var(--foreground-subtle)" }}
        >
          {record ?? "—"}
        </p>
        <p className="truncate font-mono text-[9px] uppercase tracking-widest text-foreground-subtle">
          {shortWeight(fighter.weight_class)}
          {fighter.ufc_bouts > 0 ? ` · ${fighter.ufc_bouts} UFC` : ""}
        </p>
        <div className="mt-auto pt-1.5">
          <DualScore
            current={fighter.vertex_score}
            allTime={fighter.vertex_score_all_time}
            scoreColor={style.scoreColor}
            borderColor={style.badgeBorder}
            size="sm"
          />
        </div>
      </div>
    </>
  );

  const baseClass =
    "group relative flex h-full w-full flex-col overflow-hidden rounded-md border text-left";
  const interactiveClass = " transition-colors";
  // Tier identity carried by a 1px tier-coloured edge — replaces the
  // full-card gradient wash. Unranked falls back to the neutral border.
  const edgeStyle: CSSProperties =
    fighter.tier === "unranked"
      ? { borderColor: "var(--color-foreground-10, oklch(1 0 0 / 0.15))" }
      : { borderColor: style.badgeBorder };

  if (href) {
    return (
      <Link
        href={href}
        prefetch={false}
        onClick={onClick}
        className={baseClass + interactiveClass}
        style={edgeStyle}
      >
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={baseClass + interactiveClass}
        style={edgeStyle}
      >
        {inner}
      </button>
    );
  }
  // Static (e.g. simulator "picked" panel).
  return (
    <div className={baseClass} style={edgeStyle}>
      {inner}
    </div>
  );
}

/** Side-by-side CUR / ALL chip with a tier-coloured border + numbers.
 *  Exported so the simulator picked panel can render its own. */
export function DualScore({
  current,
  allTime,
  scoreColor,
  borderColor,
  size = "md",
}: {
  current: number | null;
  allTime: number | null;
  scoreColor: string;
  borderColor: string;
  size?: "sm" | "md" | "lg";
}) {
  const cell =
    size === "lg"
      ? "min-w-[44px] px-2.5 py-1.5"
      : size === "sm"
        ? "min-w-[34px] px-1 py-0.5"
        : "min-w-[38px] px-2 py-1";
  const numClass =
    size === "lg" ? "text-lg" : size === "sm" ? "text-sm" : "text-base";
  return (
    <div
      className="flex shrink-0 items-stretch overflow-hidden rounded-sm border"
      style={{ borderColor }}
    >
      <ScoreCell
        label="CUR"
        value={current}
        color={scoreColor}
        tone="primary"
        cellClass={cell}
        numberClass={numClass}
      />
      <ScoreCell
        label="ALL"
        value={allTime}
        color={scoreColor}
        tone="muted"
        cellClass={cell}
        numberClass={numClass}
      />
    </div>
  );
}

function ScoreCell({
  label,
  value,
  color,
  tone,
  cellClass,
  numberClass,
}: {
  label: string;
  value: number | null;
  color: string;
  tone: "primary" | "muted";
  cellClass: string;
  numberClass: string;
}) {
  return (
    <div
      className={
        "flex flex-col items-center justify-center " +
        cellClass +
        " " +
        (tone === "primary"
          ? "bg-foreground/[0.06]"
          : "border-l border-foreground/10 bg-background-base/40")
      }
    >
      <span
        className={
          "font-display font-semibold tabular leading-none " + numberClass
        }
        style={{ color: value != null ? color : undefined }}
      >
        {value != null ? Math.round(value) : "—"}
      </span>
      <span className="mt-0.5 text-[8px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </span>
    </div>
  );
}
