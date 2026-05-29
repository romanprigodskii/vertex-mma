import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isRuLocale, localizedColSql, localizedNameSql } from "@/lib/i18n-name";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MarketCardOutcome = {
  label: string;
  order_index: number;
  current_price: number;
};

export type MarketListItem = {
  id: string;
  type: string; // 'winner' | 'method' | future variants
  bout_id: string;
  question: string;
  status: string;
  closes_at: string;
  total_volume: number;
  unique_traders: number;
  event_name: string;
  event_slug: string;
  event_date: string;
  fighter_a_name: string;
  fighter_a_slug: string;
  fighter_b_name: string;
  fighter_b_slug: string;
  outcomes: MarketCardOutcome[];
};

export async function listOpenMarkets(limit = 50): Promise<MarketListItem[]> {
  const isRu = await isRuLocale();
  const rows = await db.execute<MarketListItem>(sql`
    SELECT
      m.id::text AS id,
      m.type::text AS type,
      m.bout_id::text AS bout_id,
      m.question,
      m.status::text AS status,
      m.closes_at::text AS closes_at,
      m.total_volume,
      m.unique_traders,
      ${localizedColSql("e.name", "e.name_ru", isRu)} AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fb.slug AS fighter_b_slug,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'label', label,
              'order_index', order_index,
              'current_price', current_price::float
            ) ORDER BY order_index
          )
          FROM market_outcome
          WHERE market_id = m.id
        ),
        '[]'::json
      ) AS outcomes
    FROM market m
    JOIN bout b ON b.id = m.bout_id
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE m.status = 'open' AND m.closes_at > NOW()
    ORDER BY m.closes_at ASC, m.type ASC
    LIMIT ${limit}
  `);
  return rows as unknown as MarketListItem[];
}

export type EventMarketsGroup = {
  event_id: string;
  event_slug: string;
  event_name: string;
  event_short_name: string | null;
  event_date: string;
  total_markets: number;
  bouts: Array<{
    bout_id: string;
    bout_order: number | null;
    weight_class: string;
    is_main_event: boolean;
    is_co_main_event: boolean;
    is_title_fight: boolean;
    fighter_a_name: string;
    fighter_a_slug: string;
    fighter_b_name: string;
    fighter_b_slug: string;
    markets: Array<{
      id: string;
      type: string;
      question: string;
      total_volume: number;
      unique_traders: number;
      outcomes: MarketCardOutcome[];
    }>;
  }>;
};

/**
 * Tournament-grouped view for /markets. Returns up to `limit` upcoming
 * events, each with its bouts and each bout's open markets (one row per
 * market). The single flat SQL query joins through bout + event + both
 * fighters and uses a json_agg subselect to bundle outcomes per market;
 * grouping into the nested shape happens in TS so the structure stays
 * obvious.
 */
export async function listOpenMarketsByEvent(
  limit = 20,
): Promise<EventMarketsGroup[]> {
  const isRu = await isRuLocale();
  const rows = await db.execute<{
    event_id: string;
    event_slug: string;
    event_name: string;
    event_short_name: string | null;
    event_date: string;
    bout_id: string;
    bout_order: number | null;
    weight_class: string;
    is_main_event: boolean;
    is_co_main_event: boolean;
    is_title_fight: boolean;
    fighter_a_name: string;
    fighter_a_slug: string;
    fighter_b_name: string;
    fighter_b_slug: string;
    market_id: string;
    market_type: string;
    market_question: string;
    market_total_volume: number;
    market_unique_traders: number;
    outcomes_json: MarketCardOutcome[];
  }>(sql`
    SELECT
      e.id::text AS event_id,
      e.slug AS event_slug,
      ${localizedColSql("e.name", "e.name_ru", isRu)} AS event_name,
      e.short_name AS event_short_name,
      e.date::text AS event_date,
      b.id::text AS bout_id,
      b.bout_order,
      b.weight_class::text AS weight_class,
      b.is_main_event,
      b.is_co_main_event,
      b.is_title_fight,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fb.slug AS fighter_b_slug,
      m.id::text AS market_id,
      m.type::text AS market_type,
      m.question AS market_question,
      m.total_volume AS market_total_volume,
      m.unique_traders AS market_unique_traders,
      COALESCE(
        (
          SELECT json_agg(json_build_object(
            'label', mo.label,
            'order_index', mo.order_index,
            'current_price', mo.current_price::float
          ) ORDER BY mo.order_index)
          FROM market_outcome mo
          WHERE mo.market_id = m.id
        ),
        '[]'::json
      ) AS outcomes_json
    FROM market m
    JOIN bout b ON b.id = m.bout_id
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE m.status = 'open'
      AND m.closes_at > NOW()
    ORDER BY e.date ASC, b.bout_order DESC NULLS LAST, b.id ASC, m.type ASC
  `);

  const arr = rows as unknown as Array<{
    event_id: string;
    event_slug: string;
    event_name: string;
    event_short_name: string | null;
    event_date: string;
    bout_id: string;
    bout_order: number | null;
    weight_class: string;
    is_main_event: boolean;
    is_co_main_event: boolean;
    is_title_fight: boolean;
    fighter_a_name: string;
    fighter_a_slug: string;
    fighter_b_name: string;
    fighter_b_slug: string;
    market_id: string;
    market_type: string;
    market_question: string;
    market_total_volume: number;
    market_unique_traders: number;
    outcomes_json: MarketCardOutcome[];
  }>;

  const eventMap = new Map<string, EventMarketsGroup>();
  for (const r of arr) {
    let evt = eventMap.get(r.event_id);
    if (!evt) {
      evt = {
        event_id: r.event_id,
        event_slug: r.event_slug,
        event_name: r.event_name,
        event_short_name: r.event_short_name,
        event_date: r.event_date,
        total_markets: 0,
        bouts: [],
      };
      eventMap.set(r.event_id, evt);
    }
    let bout = evt.bouts.find((b) => b.bout_id === r.bout_id);
    if (!bout) {
      bout = {
        bout_id: r.bout_id,
        bout_order: r.bout_order,
        weight_class: r.weight_class,
        is_main_event: r.is_main_event,
        is_co_main_event: r.is_co_main_event,
        is_title_fight: r.is_title_fight,
        fighter_a_name: r.fighter_a_name,
        fighter_a_slug: r.fighter_a_slug,
        fighter_b_name: r.fighter_b_name,
        fighter_b_slug: r.fighter_b_slug,
        markets: [],
      };
      evt.bouts.push(bout);
    }
    bout.markets.push({
      id: r.market_id,
      type: r.market_type,
      question: r.market_question,
      total_volume: r.market_total_volume,
      unique_traders: r.market_unique_traders,
      outcomes: r.outcomes_json ?? [],
    });
    evt.total_markets++;
  }

  return Array.from(eventMap.values()).slice(0, limit);
}

export type MarketOutcomeRow = {
  id: string;
  label: string;
  order_index: number;
  current_shares: number;
  current_price: number;
};

export type MarketDetail = Omit<MarketListItem, "outcomes"> & {
  b_parameter: number;
  outcomes: MarketOutcomeRow[];
};

export async function getMarketById(id: string): Promise<MarketDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const isRu = await isRuLocale();
  const marketRows = await db.execute<{
    id: string;
    type: string;
    bout_id: string;
    question: string;
    status: string;
    closes_at: string;
    b_parameter: number;
    total_volume: number;
    unique_traders: number;
    event_name: string;
    event_slug: string;
    event_date: string;
    fighter_a_name: string;
    fighter_a_slug: string;
    fighter_b_name: string;
    fighter_b_slug: string;
  }>(sql`
    SELECT
      m.id::text AS id,
      m.type::text AS type,
      m.bout_id::text AS bout_id,
      m.question,
      m.status::text AS status,
      m.closes_at::text AS closes_at,
      m.b_parameter,
      m.total_volume,
      m.unique_traders,
      ${localizedColSql("e.name", "e.name_ru", isRu)} AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name,
      fb.slug AS fighter_b_slug
    FROM market m
    JOIN bout b ON b.id = m.bout_id
    JOIN event e ON e.id = b.event_id
    JOIN fighter fa ON fa.id = b.fighter_a_id
    JOIN fighter fb ON fb.id = b.fighter_b_id
    WHERE m.id = ${id}::uuid
    LIMIT 1
  `);
  const arr = marketRows as unknown as Array<{
    id: string;
    type: string;
    bout_id: string;
    question: string;
    status: string;
    closes_at: string;
    b_parameter: number;
    total_volume: number;
    unique_traders: number;
    event_name: string;
    event_slug: string;
    event_date: string;
    fighter_a_name: string;
    fighter_a_slug: string;
    fighter_b_name: string;
    fighter_b_slug: string;
  }>;
  if (arr.length === 0) return null;
  const m = arr[0];

  const outcomeRows = await db.execute<MarketOutcomeRow>(sql`
    SELECT
      id::text AS id,
      label,
      order_index,
      current_shares::float AS current_shares,
      current_price::float AS current_price
    FROM market_outcome
    WHERE market_id = ${id}::uuid
    ORDER BY order_index ASC
  `);
  const outcomes = outcomeRows as unknown as MarketOutcomeRow[];

  return {
    ...m,
    outcomes,
  };
}

export type MyBetRow = {
  bet_id: string;
  market_id: string;
  market_question: string;
  market_type: string;
  outcome_label: string;
  shares_bought: number;
  coins_spent: number;
  price_at_purchase: number;
  payout: number | null;
  resolved_at: string | null;
  created_at: string;
  market_status: string;
  is_winning: boolean | null;
  fighter_a_name: string;
  fighter_b_name: string;
};

export type BoutExternalOddsRow = {
  source: string;
  fetched_at: string;
  source_url: string | null;
  winner_a_decimal: number | null;
  winner_b_decimal: number | null;
  method_a_kotko_decimal: number | null;
  method_a_sub_decimal: number | null;
  method_a_dec_decimal: number | null;
  method_b_kotko_decimal: number | null;
  method_b_sub_decimal: number | null;
  method_b_dec_decimal: number | null;
};

export async function getBoutExternalOdds(
  boutId: string,
): Promise<BoutExternalOddsRow | null> {
  if (!UUID_RE.test(boutId)) return null;
  const rows = await db.execute<BoutExternalOddsRow>(sql`
    SELECT
      source,
      fetched_at::text AS fetched_at,
      source_url,
      winner_a_decimal,
      winner_b_decimal,
      method_a_kotko_decimal,
      method_a_sub_decimal,
      method_a_dec_decimal,
      method_b_kotko_decimal,
      method_b_sub_decimal,
      method_b_dec_decimal
    FROM bout_external_odds
    WHERE bout_id = ${boutId}::uuid
    ORDER BY fetched_at DESC
    LIMIT 1
  `);
  const arr = rows as unknown as BoutExternalOddsRow[];
  return arr[0] ?? null;
}

export async function listMyBets(userProfileId: string): Promise<MyBetRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const isRu = await isRuLocale();
  const rows = await db.execute<MyBetRow>(sql`
    SELECT
      bt.id::text AS bet_id,
      bt.market_id::text AS market_id,
      m.question AS market_question,
      m.type::text AS market_type,
      mo.label AS outcome_label,
      bt.shares_bought::float AS shares_bought,
      bt.coins_spent,
      bt.price_at_purchase::float AS price_at_purchase,
      bt.payout,
      bt.resolved_at::text AS resolved_at,
      bt.created_at::text AS created_at,
      m.status::text AS market_status,
      mo.is_winning,
      ${localizedNameSql("fa", isRu)} AS fighter_a_name,
      ${localizedNameSql("fb", isRu)} AS fighter_b_name
    FROM bet bt
    JOIN market m ON m.id = bt.market_id
    JOIN market_outcome mo ON mo.id = bt.outcome_id
    JOIN bout bo ON bo.id = m.bout_id
    JOIN fighter fa ON fa.id = bo.fighter_a_id
    JOIN fighter fb ON fb.id = bo.fighter_b_id
    WHERE bt.user_id = ${userProfileId}::uuid
    ORDER BY bt.created_at DESC
  `);
  return rows as unknown as MyBetRow[];
}
