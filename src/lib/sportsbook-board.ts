import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  isRuLocale,
  localizedColSql,
  localizedEventNameSql,
  localizedNameSql,
} from "@/lib/i18n-name";
import {
  computeSportsbookOutcomes,
  marketProbFromOdds,
  MAX_MARKET_EDGE,
  type SportsbookSelectionCode,
} from "@/lib/sportsbook";

/** One winner-market price for the board card. */
export type BoardPrice = {
  code: Extract<SportsbookSelectionCode, "win_a" | "win_b">;
  decimalOdds: number;
  /** Fair model probability (post-floor, pre-margin). */
  prob: number;
};

export type BoardBout = {
  boutId: string;
  weightClass: string;
  isMainEvent: boolean;
  isTitleFight: boolean;
  fighterAName: string;
  fighterBName: string;
  winnerA: BoardPrice;
  winnerB: BoardPrice;
  /** Live model−market winner edge (clamped to ±MAX_MARKET_EDGE); null when
   *  the bout has no bookmaker line. Drives the "value" badge. */
  edgeA: number | null;
  /** Bookmaker consensus winner odds, shown for reference. */
  consensus: { aDecimal: number | null; bDecimal: number | null } | null;
};

export type BoardEvent = {
  slug: string;
  name: string;
  shortName: string;
  date: string;
  bouts: BoardBout[];
};

type Row = {
  event_slug: string;
  event_name: string;
  event_short_name: string;
  event_date: string;
  bout_id: string;
  weight_class: string;
  is_main_event: boolean;
  is_title_fight: boolean;
  fighter_a_name: string;
  fighter_b_name: string;
  prob_a: number;
  prob_b: number;
  winner_a_decimal: number | null;
  winner_b_decimal: number | null;
};

/**
 * The fixed-odds sportsbook board for /markets: every upcoming bettable bout
 * (scheduled, event in the future) that has a model prediction, with its
 * winner-market odds priced exactly like the full bout panel — edge-guarded
 * against the live bookmaker consensus. Grouped by event, soonest first.
 *
 * Winner-only by design: the slip holds one leg per bout, so surfacing method
 * /totals here would just let a later pick silently replace the winner pick.
 * The full 12-cell board (method/totals/distance) lives on /bouts/[id], which
 * each card links to.
 *
 * One LATERAL pulls the freshest prediction per bout (so the INNER join also
 * filters to bouts that actually have a line); a second LATERAL pulls the
 * latest external odds. No N+1.
 */
export async function getSportsbookBoard(limit = 60): Promise<BoardEvent[]> {
  const isRu = await isRuLocale();
  const rows = (await db.execute<Row>(sql`
    SELECT
      e.slug AS event_slug,
      ${localizedColSql("e.name", "e.name_ru", isRu)} AS event_name,
      ${localizedEventNameSql("e", isRu)} AS event_short_name,
      e.date::text AS event_date,
      b.id::text AS bout_id,
      b.weight_class::text AS weight_class,
      b.is_main_event,
      b.is_title_fight,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      s.prob_a,
      s.prob_b,
      x.winner_a_decimal,
      x.winner_b_decimal
    FROM bout b
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    JOIN LATERAL (
      SELECT prob_a, prob_b
      FROM bout_simulation
      WHERE bout_id = b.id
      ORDER BY generated_at DESC
      LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT winner_a_decimal, winner_b_decimal
      FROM bout_external_odds
      WHERE bout_id = b.id
      ORDER BY fetched_at DESC
      LIMIT 1
    ) x ON true
    WHERE b.status = 'scheduled'
      AND e.date > NOW()
    ORDER BY e.date ASC, b.bout_order DESC NULLS LAST, b.id ASC
    LIMIT ${Math.min(150, Math.max(1, limit))}
  `)) as unknown as Row[];

  const byEvent = new Map<string, BoardEvent>();

  for (const r of rows) {
    const marketProbA = marketProbFromOdds(
      r.winner_a_decimal,
      r.winner_b_decimal,
    );
    const outcomes = computeSportsbookOutcomes({
      probA: r.prob_a,
      probB: r.prob_b,
      marketProbA,
      rounds: null,
    });
    const a = outcomes.find((o) => o.code === "win_a");
    const b = outcomes.find((o) => o.code === "win_b");
    if (!a || !b) continue;

    const rawEdgeA = marketProbA != null ? r.prob_a - marketProbA : null;
    const edgeA =
      rawEdgeA == null
        ? null
        : Math.max(-MAX_MARKET_EDGE, Math.min(MAX_MARKET_EDGE, rawEdgeA));

    let ev = byEvent.get(r.event_slug);
    if (!ev) {
      ev = {
        slug: r.event_slug,
        name: r.event_name,
        shortName: r.event_short_name,
        date: r.event_date,
        bouts: [],
      };
      byEvent.set(r.event_slug, ev);
    }
    ev.bouts.push({
      boutId: r.bout_id,
      weightClass: r.weight_class,
      isMainEvent: r.is_main_event,
      isTitleFight: r.is_title_fight,
      fighterAName: r.fighter_a_name,
      fighterBName: r.fighter_b_name,
      winnerA: { code: "win_a", decimalOdds: a.decimalOdds, prob: a.prob },
      winnerB: { code: "win_b", decimalOdds: b.decimalOdds, prob: b.prob },
      edgeA,
      consensus:
        r.winner_a_decimal != null || r.winner_b_decimal != null
          ? { aDecimal: r.winner_a_decimal, bDecimal: r.winner_b_decimal }
          : null,
    });
  }

  return [...byEvent.values()];
}
