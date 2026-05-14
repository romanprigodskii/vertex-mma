import Link from "next/link";
import { ArrowLeftRight, ArrowRight, Crown, RotateCcw } from "lucide-react";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { WEIGHT_CLASSES } from "@/lib/constants";
import { getCountryFlag } from "@/lib/fighter-helpers";
import type { FighterCatalogRow } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";
import { classifyAndStyle } from "@/lib/vertex-tier";

const WEIGHT_LABELS: Record<string, string> = Object.fromEntries(
  WEIGHT_CLASSES.map((w) => [w.id, w.label]),
);
WEIGHT_LABELS["catchweight"] = "Catchweight";
WEIGHT_LABELS["openweight"] = "Openweight";

const METHOD_LABELS: Record<string, string> = {
  ko: "KO",
  tko: "TKO",
  submission: "SUB",
  decision_unanimous: "U-DEC",
  decision_split: "S-DEC",
  decision_majority: "M-DEC",
  draw: "DRAW",
  no_contest: "NC",
  dq: "DQ",
};

interface FighterCardProps {
  fighter: FighterCatalogRow;
  /** 1-indexed list position. Rendered only when `showRank` is true. */
  rank?: number;
  showRank?: boolean;
  /** Eager-load avatar image (above-the-fold cards). */
  priority?: boolean;
  className?: string;
  /** Which Vertex Score to feed the tier classifier. "current" (default)
   *  drives the active leaderboard; "all_time" shows historical rank. */
  scoreMode?: "current" | "all_time";
}

function StanceIcon({ stance }: { stance: string | null }) {
  const cls = "h-3.5 w-3.5 text-foreground-subtle";
  if (stance === "orthodox") return <ArrowRight className={cls} aria-hidden />;
  if (stance === "southpaw")
    return (
      <ArrowRight
        className={cn(cls, "-scale-x-100")}
        aria-hidden
      />
    );
  if (stance === "switch") return <ArrowLeftRight className={cls} aria-hidden />;
  return <RotateCcw className={cls} aria-hidden />;
}

function streakClassFor(
  type: "W" | "L" | null,
  count: number,
): string {
  if (!type || count < 1) return "text-foreground-muted";
  if (type === "W") return "text-streak-win";
  return "text-streak-loss";
}

export function FighterCard({
  fighter,
  rank,
  showRank = false,
  priority = false,
  className,
  scoreMode = "current",
}: FighterCardProps) {
  const { classification, tierStyle, championStyle } = classifyAndStyle({
    slug: fighter.slug,
    vertexScore: fighter.vertex_score,
    vertexScoreAllTime: fighter.vertex_score_all_time,
    ufcBouts: fighter.ufc_bouts,
    scoreMode,
  });
  const isChampion = championStyle.status !== "none";
  const showTierBadge = tierStyle.tier !== "unranked";
  const rawScore =
    scoreMode === "all_time"
      ? fighter.vertex_score_all_time
      : fighter.vertex_score ?? fighter.vertex_score_all_time;
  // Cap visible score at 100 — raw all-time values can exceed 100 for sort
  // ordering after we lifted the LEAST(100, ...) cap in step 5E, but the UI
  // tier breaks (Apex 80+, Elite 60-79 etc.) are calibrated against [0, 100].
  const displayScore =
    rawScore == null ? null : Math.min(100, Math.max(0, rawScore));
  const weightLabel = fighter.weight_class_primary
    ? WEIGHT_LABELS[fighter.weight_class_primary] ?? null
    : null;
  const flag = getCountryFlag(fighter.country_code);
  const hasNickname = Boolean(fighter.nickname?.trim());

  const wins = fighter.wins_total;
  const losses = fighter.losses_total;
  const draws = fighter.draws_total;
  const ncs = fighter.no_contests;
  const record =
    draws > 0 ? `${wins}-${losses}-${draws}` : `${wins}-${losses}`;
  const denominator = wins + losses;
  const winRate = denominator > 0
    ? `${Math.round((wins / denominator) * 100)}%`
    : "—";

  const stanceText = fighter.stance
    ? fighter.stance[0].toUpperCase() + fighter.stance.slice(1)
    : "Stance unknown";

  const streakType = fighter.current_streak_type;
  const streakCount = fighter.current_streak_count ?? 0;
  const streakLabel =
    streakType && streakCount > 0
      ? `${streakType}${streakCount} streak`
      : "No streak";

  const lastMethod = fighter.last_fight_method
    ? METHOD_LABELS[fighter.last_fight_method] ?? null
    : null;
  const lastFightLabel = fighter.last_fight_result
    ? lastMethod
      ? `Last: ${fighter.last_fight_result} (${lastMethod})`
      : `Last: ${fighter.last_fight_result}`
    : "Last: —";

  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      style={
        isChampion
          ? {
              borderColor: championStyle.borderColor,
              borderWidth: `${championStyle.borderWidth}px`,
              boxShadow: championStyle.glowColor
                ? `0 0 20px ${championStyle.glowColor}`
                : undefined,
            }
          : undefined
      }
      className={cn(
        "group relative flex min-h-[168px] gap-4 rounded-lg bg-background-elevated/30 p-4",
        // Champion fighters use an inline-styled border (set above). Non-champions
        // keep the standard Tailwind subtle border.
        isChampion ? "border" : "border border-foreground/10",
        "transition-[background-color] duration-200 ease-out",
        "hover:bg-foreground/[0.02]",
        "focus-visible:outline-none focus-visible:bg-foreground/[0.02]",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
        className,
      )}
      aria-label={`${fighter.name_en}${
        hasNickname ? ` (${fighter.nickname})` : ""
      }, record ${record}, ${streakLabel}${
        showTierBadge ? `, ${tierStyle.label} tier` : ""
      }${championStyle.label ? `, ${championStyle.label}` : ""}`}
    >
      {/* Avatar (with optional crown / 2× champion overlays) */}
      <div className="relative shrink-0">
        <FighterAvatar
          name={fighter.name_en}
          photoUrl={fighter.photo_url}
          size="2xl"
          priority={priority}
          imageSizes="140px"
        />
        {championStyle.hasCrown ? (
          <span
            aria-hidden
            style={{ color: championStyle.borderColor }}
            className="absolute -right-1.5 -top-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-foreground/15 bg-background-base shadow-sm"
            title={championStyle.label}
          >
            <Crown className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {championStyle.hasCrown && classification.isDoubleChampion ? (
          <span
            aria-label="Two-division champion"
            style={{
              color: championStyle.borderColor,
              borderColor: championStyle.borderColor,
            }}
            className="absolute -bottom-1 -right-1 inline-flex items-center justify-center rounded-full border bg-background-base px-1.5 py-0.5 font-display text-[10px] tabular leading-none"
          >
            2×
          </span>
        ) : null}
      </div>

      {/* Identity + extras (middle column, flex-1) */}
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div className="flex min-w-0 flex-col">
          {showRank && rank ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              #{rank}
            </p>
          ) : null}
          <h3 className="truncate font-display text-2xl uppercase leading-tight tracking-tight text-foreground sm:text-[28px]">
            {fighter.name_en}
          </h3>
          {hasNickname ? (
            <p className="truncate font-sans text-[13px] italic leading-snug text-foreground-muted">
              &ldquo;{fighter.nickname}&rdquo;
            </p>
          ) : null}
        </div>

        <div className="mt-2 flex flex-col gap-1.5">
          <div className="h-px w-full bg-foreground/[0.07]" aria-hidden />
          <p className="flex items-center gap-1.5 truncate font-sans text-[11px] text-foreground-muted">
            <span aria-hidden className="text-[14px] leading-none">
              {flag}
            </span>
            {weightLabel ? (
              <span className="uppercase tracking-wide">{weightLabel}</span>
            ) : (
              <span className="uppercase tracking-wide opacity-60">—</span>
            )}
            <span aria-hidden className="text-foreground-subtle/40">
              ·
            </span>
            <span className="font-mono tabular">{fighter.bout_count}</span>
            <span>fights</span>
          </p>
          <p className="flex items-center gap-1.5 truncate font-sans text-[11px] text-foreground-muted">
            <StanceIcon stance={fighter.stance} />
            <span>{stanceText}</span>
            <span aria-hidden className="text-foreground-subtle/40">
              ·
            </span>
            <span
              className={cn(
                "font-mono tabular",
                streakClassFor(streakType, streakCount),
              )}
            >
              {streakLabel}
            </span>
            <span aria-hidden className="text-foreground-subtle/40">
              ·
            </span>
            <span className="font-mono tabular">{lastFightLabel}</span>
          </p>
        </div>
      </div>

      {/* Record column */}
      <div className="flex flex-col items-end gap-1 pl-1">
        <span className="font-display text-3xl leading-none tabular tracking-tight text-foreground sm:text-[32px]">
          {record}
        </span>
        <span className="h-px w-6 bg-foreground/[0.1]" aria-hidden />
        <span className="font-mono text-xs tabular text-foreground-muted">
          {winRate}
        </span>
        {ncs > 0 ? (
          <span className="font-sans text-[10px] uppercase tracking-wider text-foreground-subtle">
            · {ncs} NC
          </span>
        ) : null}
        {showTierBadge && displayScore != null ? (
          <span
            className="mt-1 inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5"
            style={{
              borderColor: tierStyle.badgeColor,
              color: tierStyle.badgeColor,
            }}
          >
            <span className="font-mono text-[9px] uppercase tracking-[0.16em]">
              {tierStyle.badgeText}
            </span>
            <span className="font-display text-sm leading-none tabular text-foreground">
              {displayScore}
            </span>
          </span>
        ) : null}
      </div>
    </Link>
  );
}
