"use client";

import Link from "next/link";

import { TIER_STYLES, type VertexTier } from "@/lib/vertex-tier";

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
}

interface Props {
  fighter: FighterResultCardData;
  /** Provide either an `onClick` (renders a <button>) or an `href` (renders
   *  a <Link>). `onClick` is also fired alongside link navigation so callers
   *  can close menus / clear state on click. */
  onClick?: () => void;
  href?: string;
}

export function FighterResultCard({ fighter, onClick, href }: Props) {
  const style = TIER_STYLES[fighter.tier];
  const record =
    fighter.wins_total != null && fighter.losses_total != null
      ? `${fighter.wins_total}-${fighter.losses_total}-${fighter.draws_total ?? 0}`
      : null;

  const inner = (
    <>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(135deg, ${style.gradientFrom}, ${style.gradientTo})`,
        }}
        aria-hidden
      />
      {fighter.photo_thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fighter.photo_thumbnail_url}
          alt=""
          className="relative h-12 w-12 shrink-0 rounded-sm border border-foreground/15 object-cover"
        />
      ) : (
        <div
          className="relative h-12 w-12 shrink-0 rounded-sm bg-foreground/[0.05]"
          aria-hidden
        />
      )}
      <div className="relative min-w-0 flex-1">
        <p className="truncate font-display text-sm uppercase tracking-tight text-foreground">
          {fighter.name}
        </p>
        {fighter.nickname ? (
          <p className="truncate font-sans text-[11px] italic text-foreground-muted">
            &ldquo;{fighter.nickname}&rdquo;
          </p>
        ) : null}
        <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {fighter.weight_class?.replace(/_/g, " ") ?? "—"}
          {record ? ` · ${record}` : ""}
          {fighter.ufc_bouts > 0 ? ` · ${fighter.ufc_bouts} UFC` : ""}
        </p>
      </div>
      <DualScore
        current={fighter.vertex_score}
        allTime={fighter.vertex_score_all_time}
        scoreColor={style.scoreColor}
        borderColor={style.badgeBorder}
      />
    </>
  );

  const baseClass =
    "group relative flex w-full items-center gap-3 overflow-hidden rounded-md border border-foreground/10 px-3 py-2.5 text-left transition-colors hover:border-foreground/30";

  if (href) {
    return (
      <Link
        href={href}
        prefetch={false}
        onClick={onClick}
        className={baseClass}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={baseClass}>
      {inner}
    </button>
  );
}

/** Side-by-side CUR / ALL score chip with a tier-coloured border + numbers.
 *  Exported so the simulator's "picked" panel can render the same chip
 *  using the same colour mapping. */
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
        ? "min-w-[32px] px-1.5 py-0.5"
        : "min-w-[38px] px-2 py-1";
  const numClass =
    size === "lg"
      ? "text-lg"
      : size === "sm"
        ? "text-xs"
        : "text-base";
  return (
    <div
      className="relative flex shrink-0 items-stretch overflow-hidden rounded-sm border"
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
