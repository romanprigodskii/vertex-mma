import { ChevronDown, ChevronUp, Crown } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { Link } from "@/i18n/navigation";
import { WEIGHT_SHORT } from "@/lib/constants";
import { getCountryFlag } from "@/lib/fighter-helpers";
import {
  championMark,
  OFFICIAL_BOARDS,
  type BoardDepth,
  type OfficialBoard,
  type OfficialRankingRow,
} from "@/lib/official-rankings";
import { cn } from "@/lib/utils";
import { classifyFighter, getTierStyle } from "@/lib/vertex-tier";

interface OfficialRankingBoardProps {
  board: OfficialBoard;
  rows: OfficialRankingRow[];
  depth: BoardDepth;
  /** True when the pool holds more fighters than the visible window. */
  hasMore: boolean;
}

/**
 * The official Vertex ranking board: division/P4P pill navigation (server-
 * rendered links driving the ?board= search param) above a ranked list of
 * fighters. Rank order is pure Vertex Score — champions are badged with a
 * crown wherever the score puts them, never pinned to the top.
 */
export async function OfficialRankingBoard({
  board,
  rows,
  depth,
  hasMore,
}: OfficialRankingBoardProps) {
  const t = await getTranslations("rankings");
  const tWeight = await getTranslations("weight");

  // Board divisions are weight_class enum values; every one of them has a
  // key in the `weight` namespace, so no has()-guard is needed here.
  const pillLabel = (b: OfficialBoard) =>
    b.kind === "p4p" ? t("p4pLabel") : tWeight(b.division as "lightweight");
  const fullLabel = (b: OfficialBoard) =>
    b.gender === "female"
      ? t("womensBoard", { label: pillLabel(b) })
      : pillLabel(b);

  const groups = [
    {
      label: t("menGroup"),
      boards: OFFICIAL_BOARDS.filter((b) => b.gender === "male"),
    },
    {
      label: t("womenGroup"),
      boards: OFFICIAL_BOARDS.filter((b) => b.gender === "female"),
    },
  ];

  return (
    <section aria-label={t("officialHeading")}>
      <nav aria-label={t("boardNavAria")} className="space-y-2">
        {groups.map((group) => (
          <div key={group.label} className="flex items-start gap-3">
            <span className="w-16 shrink-0 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle">
              {group.label}
            </span>
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible">
              {group.boards.map((b) => {
                const active = b.id === board.id;
                return (
                  <Link
                    key={b.id}
                    href={{
                      pathname: "/rankings",
                      query: b.id === "p4p" ? undefined : { board: b.id },
                    }}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    // Visible pill text is the bare division name in both
                    // gender rows — disambiguate the accessible name so
                    // screen-reader link lists don't show two "Flyweight"s.
                    aria-label={fullLabel(b)}
                    className={cn(
                      "whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                      active
                        ? "border-primary bg-primary text-background-base"
                        : "border-foreground/15 text-foreground-muted hover:border-foreground/30 hover:text-foreground",
                    )}
                  >
                    {pillLabel(b)}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-6 overflow-hidden rounded-lg border border-foreground/10 bg-background-elevated/30">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-foreground/10 px-4 py-4 sm:px-6">
          <h2 className="font-display text-2xl uppercase tracking-tight text-foreground sm:text-3xl">
            {fullLabel(board)}
          </h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle">
            {t("rankedByVertex")}
          </p>
        </div>

        {rows.length === 0 ? (
          <p className="px-6 py-12 text-center font-sans text-sm text-foreground-muted">
            {t("emptyBoard")}
          </p>
        ) : (
          <ol className="divide-y divide-foreground/[0.06]">
            {rows.map((row, i) => (
              <RankingRow
                key={row.fighter_id}
                row={row}
                rank={i + 1}
                board={board}
              />
            ))}
          </ol>
        )}

        {(hasMore || depth !== 15) && (
          <div className="flex flex-wrap items-center justify-center gap-3 border-t border-foreground/10 px-4 py-3">
            {depth === 15 && hasMore && (
              <DepthLink board={board} depth="50" icon="down">
                {t("expandTo50")}
              </DepthLink>
            )}
            {depth === 50 && hasMore && (
              <DepthLink board={board} depth="all" icon="down">
                {t("expandAll")}
              </DepthLink>
            )}
            {depth !== 15 && (
              <DepthLink board={board} depth={undefined} icon="up">
                {t("collapseTo15")}
              </DepthLink>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function DepthLink({
  board,
  depth,
  icon,
  children,
}: {
  board: OfficialBoard;
  depth: "50" | "all" | undefined;
  icon: "down" | "up";
  children: React.ReactNode;
}) {
  const query: Record<string, string> = {};
  if (board.id !== "p4p") query.board = board.id;
  if (depth) query.depth = depth;
  return (
    // scroll={false}: the reader is at the bottom of the list — an RSC
    // navigation that jumps back to the top would lose their place.
    <Link
      href={{
        pathname: "/rankings",
        query: Object.keys(query).length > 0 ? query : undefined,
      }}
      prefetch={false}
      scroll={false}
      className="inline-flex items-center gap-1.5 rounded-full border border-foreground/15 px-4 py-1.5 font-mono text-[11px] uppercase tracking-wider text-foreground-muted transition-colors hover:border-foreground/30 hover:text-foreground"
    >
      {icon === "down" ? (
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
      )}
      {children}
    </Link>
  );
}

interface RankingRowProps {
  row: OfficialRankingRow;
  rank: number;
  board: OfficialBoard;
}

async function RankingRow({ row, rank, board }: RankingRowProps) {
  const t = await getTranslations("rankings");
  const isTop = rank === 1;
  const champ = championMark(row.slug, board.division);
  // Board rows are current-score surfaces; tier colour must agree with the
  // displayed number (headline convention).
  const tierStyle = getTierStyle(
    classifyFighter({
      slug: row.slug,
      vertexScore: row.score,
      vertexScoreAllTime: null,
      ufcBouts: row.ufc_total,
      scoreMode: "current",
    }).tier,
  );
  const record =
    row.ufc_draws > 0
      ? `${row.ufc_wins}-${row.ufc_losses}-${row.ufc_draws}`
      : `${row.ufc_wins}-${row.ufc_losses}`;
  const hasStreak =
    row.current_streak_type !== null && row.current_streak_count > 0;
  const championLabel = champ
    ? champ.isInterim
      ? t("interimBadge")
      : t("championBadge")
    : null;

  return (
    <li>
      {/* No aria-label here: it would override the link's content-derived
          accessible name and hide the record/streak/champion badge from
          screen readers. The rank number stays in the accessible name. */}
      <Link
        href={`/fighters/${row.slug}`}
        prefetch={false}
        className={cn(
          "group flex items-center gap-3 px-4 py-3 transition-colors sm:gap-4 sm:px-6",
          "hover:bg-foreground/[0.04]",
          "focus-visible:outline-none focus-visible:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
          isTop &&
            "bg-gradient-to-r from-primary/[0.07] via-transparent to-transparent py-5",
        )}
      >
        <span
          className={cn(
            "w-8 shrink-0 text-center font-display tabular leading-none",
            isTop ? "text-3xl text-primary" : "text-lg text-foreground-subtle",
          )}
        >
          {rank}
        </span>

        {/* border-0: the default avatar ring reads as a grey frame around
            transparent UFC cutout photos, especially in light theme. */}
        <FighterAvatar
          name={row.name}
          photoUrl={row.photo_thumbnail_url}
          size={isTop ? "lg" : "sm"}
          className="border-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate font-display uppercase tracking-tight text-foreground",
                isTop ? "text-xl sm:text-3xl" : "text-base sm:text-lg",
              )}
            >
              {row.name}
            </span>
            {championLabel && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-primary">
                <Crown className="h-3 w-3" aria-hidden />
                <span className="hidden font-mono text-[10px] uppercase tracking-wider sm:inline">
                  {championLabel}
                </span>
                <span className="sr-only sm:hidden">{championLabel}</span>
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] uppercase tracking-wider text-foreground-subtle">
            <span aria-hidden>{getCountryFlag(row.country_code)}</span>
            <span className="tabular">{record} UFC</span>
            {row.p4p_division && (
              <span>
                {WEIGHT_SHORT[row.p4p_division] ??
                  row.p4p_division.toUpperCase()}
              </span>
            )}
            {hasStreak && (
              <span
                className={cn(
                  "tabular",
                  row.current_streak_type === "W"
                    ? "text-streak-win"
                    : "text-streak-loss",
                )}
              >
                {row.current_streak_type === "W"
                  ? t("streakWin", { n: row.current_streak_count })
                  : t("streakLoss", { n: row.current_streak_count })}
              </span>
            )}
            {row.divisional_status === "provisional" && (
              <span className="rounded-sm border border-foreground/15 px-1.5 py-0.5 text-[10px]">
                {t("provisionalBadge")}
              </span>
            )}
          </div>
        </div>

        <span className="flex shrink-0 flex-col items-end">
          <span
            className={cn(
              "font-display tabular leading-none",
              isTop ? "text-4xl sm:text-5xl" : "text-2xl",
            )}
            style={{ color: tierStyle.scoreColor }}
          >
            {row.score}
          </span>
          {isTop && (
            <span className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("vertexCaption")}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
