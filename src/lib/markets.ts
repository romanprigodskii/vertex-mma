import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

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
      e.name AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      fa.name_en AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      fb.name_en AS fighter_b_name,
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
      e.name AS event_name,
      e.slug AS event_slug,
      e.date::text AS event_date,
      fa.name_en AS fighter_a_name,
      fa.slug AS fighter_a_slug,
      fb.name_en AS fighter_b_name,
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

export async function listMyBets(userProfileId: string): Promise<MyBetRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
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
      fa.name_en AS fighter_a_name,
      fb.name_en AS fighter_b_name
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
