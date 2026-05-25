import Link from "next/link";
import { ArrowLeftRight, ArrowRight, Crown, RotateCcw } from "lucide-react";

import { BmfBadge } from "@/components/fighter/detail/BmfBadge";
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
  const cls = "h-3.5 w-3.5 text-fg-subtle";
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
  if (!type || count < 1) return "text-fg-muted";
  if (type === "W") return "text-profit";
  return "text-loss";
}

export function FighterCard({
  fighter,
  rank,
  showRank = false,
  priority = false,
  className,
  scoreMode = "current",
}: FighterCardProps) {
  // Wave 14B.2: when the catalog query joined a divisional row (single-
  // weight filter), prefer the per-division score for "current"
  // classification. all_time always stays global. divisional_score is
  // NULL outside the single-weight-filter path, so this is a no-op for
  // multi-/no-weight catalogs and for callers like the champion strip.
  const effectiveCurrent =
    fighter.divisional_score ?? fighter.vertex_score;
  const { classification, tierStyle, championStyle } = classifyAndStyle({
    slug: fighter.slug,
    vertexScore: effectiveCurrent,
    vertexScoreAllTime: fighter.vertex_score_all_time,
    ufcBouts: fighter.ufc_bouts,
    scoreMode,
  });
  const isChampion = championStyle.status !== "none";
  const showTierBadge = tierStyle.tier !== "unranked";
  const rawScore =
    scoreMode === "all_time"
      ? fighter.vertex_score_all_time
      : effectiveCurrent ?? fighter.vertex_score_all_time;
  const isProvisional =
    scoreMode === "current" && fighter.divisional_status === "provisional";
  // Cap visible score at 100 — raw all-time values can exceed 100 for sort
  // ordering after we lifted the LEAST(100, ...) cap in step 5E, but the UI
  // tier breaks (Apex 75+, Elite 55-74 etc.) are calibrated against [0, 100].
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

  // Tier identity is now carried by the score+label chip in the
  // bottom-right (tier-coloured number + tier-text badge) plus the
  // Crown overlay for champions — no full-card gradient wash.
  const cardBase =
    "color-mix(in oklch, var(--color-surface-elevated) 30%, transparent)";

  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      style={{
        background:
          tierStyle.tier === "unranked"
            ? "color-mix(in oklch, var(--color-surface-elevated) 18%, transparent)"
            : cardBase,
      }}
      className={cn(
        "group relative flex min-h-[168px] gap-4 rounded-lg border border-edge p-4",
        "transition-[background-color] duration-(--motion-fast) ease-out-soft",
        "hover:bg-fg/[0.02]",
        "focus-visible:outline-none focus-visible:bg-fg/[0.02]",
        "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
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
        {championStyle.hasCrown && championStyle.crownColor ? (
          <span
            aria-hidden
            style={{ color: championStyle.crownColor }}
            // Wave 6F: smaller crown (20px container vs 28px, 10px icon vs
            // 14px) sits at the avatar's bottom-right so it sits diagonally
            // opposite the tier-score number in the card's bottom-right.
            // For double champions the 2× badge needs that corner; the
            // crown shifts back up to top-right to make room.
            className={cn(
              "absolute flex h-5 w-5 items-center justify-center rounded-full border border-fg/15 bg-surface-base shadow-sm",
              classification.isDoubleChampion
                ? "-right-1 -top-1"
                : "-bottom-1 -right-1",
            )}
            title={championStyle.label}
          >
            <Crown className="h-2.5 w-2.5" />
          </span>
        ) : null}
        {championStyle.hasCrown && classification.isDoubleChampion ? (
          <span
            aria-label="Two-division champion"
            style={{
              color: championStyle.crownColor ?? championStyle.borderColor,
              borderColor:
                championStyle.crownColor ?? championStyle.borderColor,
            }}
            className="absolute -bottom-1 -right-1 inline-flex items-center justify-center rounded-full border bg-surface-base px-1.5 py-0.5 font-broadcast-display font-bold tabular text-[10px] leading-none"
          >
            2×
          </span>
        ) : null}
      </div>

      {/* Identity + extras (middle column, flex-1) */}
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div className="flex min-w-0 flex-col">
          {showRank && rank ? (
            <p className="type-meta text-[10px] text-fg-subtle">
              #{rank}
            </p>
          ) : null}
          <h3 className="line-clamp-2 break-words font-broadcast-display text-2xl font-bold uppercase leading-tight tracking-tight text-fg sm:text-[28px]">
            {fighter.name_en}
          </h3>
          {hasNickname ? (
            <p className="truncate type-body text-[13px] italic leading-snug text-fg-muted">
              &ldquo;{fighter.nickname}&rdquo;
            </p>
          ) : null}
          {/* Wave 10A: BMF chip — current BMF champion only (rare, ~1 fighter
              at a time). Sits in the identity column away from the crown /
              2× double-champion avatar overlays so it can't visually collide. */}
          <div className="mt-1">
            <BmfBadge slug={fighter.slug} variant="card" />
          </div>
        </div>

        <div className="mt-2 flex flex-col gap-1.5">
          <div className="h-px w-full bg-fg/[0.07]" aria-hidden />
          <p
            className={cn(
              "type-body flex items-center gap-1.5 truncate text-[11px] text-fg-muted",
              showTierBadge && "pr-[140px]",
            )}
          >
            <span aria-hidden className="text-[14px] leading-none">
              {flag}
            </span>
            {weightLabel ? (
              <span className="uppercase tracking-wide">{weightLabel}</span>
            ) : (
              <span className="uppercase tracking-wide opacity-60">—</span>
            )}
            <span aria-hidden className="text-fg-subtle/40">
              ·
            </span>
            <span className="font-mono tabular">{fighter.bout_count}</span>
            <span>fights</span>
          </p>
          <p
            className={cn(
              "type-body flex items-center gap-1.5 truncate text-[11px] text-fg-muted",
              showTierBadge && "pr-[140px]",
            )}
          >
            <StanceIcon stance={fighter.stance} />
            <span>{stanceText}</span>
            <span aria-hidden className="text-fg-subtle/40">
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
            <span aria-hidden className="text-fg-subtle/40">
              ·
            </span>
            <span className="font-mono tabular">{lastFightLabel}</span>
          </p>
        </div>
      </div>

      {/* Record column */}
      <div className="flex flex-col items-end gap-1 pl-1">
        <span className="font-broadcast-display text-3xl font-bold leading-none tabular tracking-tight text-fg sm:text-[32px]">
          {record}
        </span>
        <span className="h-px w-6 bg-fg/[0.1]" aria-hidden />
        <span className="type-num text-xs text-fg-muted">{winRate}</span>
        {ncs > 0 ? (
          <span className="type-body text-[10px] uppercase tracking-wider text-fg-subtle">
            · {ncs} NC
          </span>
        ) : null}
      </div>

      {/* Tier score chip — tier-coloured number paired with the tier-text
          badge, on its own dark-chip backing so it doesn't float now that
          the full-card gradient wash is gone. Hidden for unranked. */}
      {showTierBadge && displayScore != null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-3 right-3 inline-flex select-none items-baseline gap-2 rounded-sm border border-edge bg-surface-elevated/70 px-2 py-1"
        >
          <span
            className="type-meta text-[9px]"
            style={{ color: tierStyle.scoreColor }}
          >
            {tierStyle.badgeText}
          </span>
          <span
            className="type-num leading-none"
            style={{ fontSize: 26, color: tierStyle.scoreColor }}
          >
            {displayScore}
          </span>
        </div>
      ) : null}
      {/* Wave 14B.2: provisional badge — surfaces "≤4 bouts in this
          division" for divisional rating display. Anchored just above the
          large score so it reads as a qualifier on that number. Hidden in
          all_time mode and when the active catalog isn't divisional. */}
      {isProvisional ? (
        <span
          aria-label="Provisional rating — fewer than 5 bouts in this division"
          className="type-meta pointer-events-none absolute bottom-12 right-4 select-none rounded-sm border border-edge bg-surface-elevated/85 px-1.5 py-0.5 text-[9px] text-fg-muted"
        >
          Prov
        </span>
      ) : null}
    </Link>
  );
}
