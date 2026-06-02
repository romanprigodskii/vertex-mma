/**
 * Vertex Sportsbook — settlement BACKSTOP (single bets + parlays).
 *
 * Fixed-odds bets and parlay legs settle INSTANTLY via the
 * on_bout_settle_fixed_odds AFTER-UPDATE trigger (scripts/apply_parlay_
 * settlement.ts). The trigger is AFTER UPDATE, so a bout INSERTed
 * already-completed (no UPDATE) won't fire it — this cron sweep catches those.
 * It just re-invokes the same PL/pgSQL settle functions (single source of
 * grading truth), so it's fully consistent with the trigger and idempotent
 * (the functions only touch status='open' rows).
 *
 * It ALSO cancels "abandoned" bouts first: a fighter withdrawal / scratch on an
 * official card leaves the bout stuck at status='scheduled' forever (UFCStats
 * just stops listing it; nothing sets it 'cancelled'), so any bet/leg on it
 * would sit open with the stake locked and no refund. Flipping such a bout to
 * 'cancelled' fires both this trigger (void/refund single bets + parlay legs)
 * and on_bout_auto_settle (refund open LMSR markets), so one UPDATE returns
 * every staked coin.
 *
 *   Usage: npx tsx scripts/settle_fixed_odds.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 3 });

async function main() {
  // 1) Cancel abandoned scheduled bouts so their bets stop being stuck open.
  //    Two safe signals (a stake is only ever REFUNDED here, never forfeited):
  //      - the event is 2+ days past AND a sibling bout on the same card has a
  //        recorded result → the card was scraped and this fight wasn't on it
  //        (a withdrawal / scratch), or
  //      - the event is 14+ days past with still no result on this bout →
  //        stale net for fully-unscraped scratches and news-only provisional
  //        cards UFCStats never listed.
  //    The UPDATE fires the settlement triggers, which do the void/refund.
  const cancelled = (await sql`
    WITH abandoned AS (
      SELECT b.id
      FROM bout b
      JOIN event e ON e.id = b.event_id
      WHERE b.status = 'scheduled'
        AND e.date IS NOT NULL
        AND (
          (
            e.date < NOW() - INTERVAL '2 days'
            AND EXISTS (
              SELECT 1 FROM bout sib
              WHERE sib.event_id = b.event_id
                AND sib.id <> b.id
                AND (sib.status = 'completed' OR sib.status = 'no_contest'
                     OR sib.winner_id IS NOT NULL)
            )
          )
          OR e.date < NOW() - INTERVAL '14 days'
        )
    )
    UPDATE bout SET status = 'cancelled', updated_at = NOW()
    WHERE id IN (SELECT id FROM abandoned)
    RETURNING id::text AS id
  `) as unknown as Array<{ id: string }>;
  if (cancelled.length > 0) {
    console.log(`Cancelled ${cancelled.length} abandoned scheduled bout(s) → refunding.`);
  }

  // 2) Resolved/cancelled bouts that still have an open single bet OR open
  //    parlay leg (catches bouts INSERTed already-completed, and the bouts we
  //    just cancelled above in case their triggers didn't run).
  const bouts = (await sql`
    SELECT b.id::text AS id
    FROM bout b
    WHERE (
        b.status = 'completed' OR b.status = 'no_contest' OR b.status = 'cancelled'
        OR b.winner_id IS NOT NULL OR b.method IN ('draw','no_contest')
      )
      AND (
        EXISTS (SELECT 1 FROM fixed_odds_bet f WHERE f.bout_id = b.id AND f.status = 'open')
        OR EXISTS (SELECT 1 FROM parlay_leg pl WHERE pl.bout_id = b.id AND pl.status = 'open')
      )
  `) as unknown as Array<{ id: string }>;

  console.log(`${bouts.length} resolved bout(s) with unsettled bets/legs.`);
  for (const b of bouts) {
    await sql`SELECT settle_fixed_odds_bets_for_bout(${b.id}::uuid)`;
    await sql`SELECT settle_parlay_legs_for_bout(${b.id}::uuid)`;
  }
  console.log(`Backstop settlement run complete (${bouts.length} bouts).`);

  // 3) Knockdown-prop (LMSR) backstop. These props grade off bout_round_stats,
  //    which loads in a later scraper pass than the result, so on_bout_auto_
  //    settle leaves them open at completion. The enrich loader settles them
  //    inline once rounds land; this catches any it missed. The helper is
  //    self-gating (no-op until round stats are complete) and idempotent.
  const kdBouts = (await sql`
    SELECT DISTINCT m.bout_id::text AS id
    FROM market m
    JOIN bout b ON b.id = m.bout_id
    WHERE m.type = 'prop' AND m.question ILIKE '%knockdown%'
      AND m.status = 'open' AND b.status = 'completed'
  `) as unknown as Array<{ id: string }>;
  for (const b of kdBouts) {
    await sql`SELECT settle_knockdown_props_for_bout(${b.id}::uuid)`;
  }
  if (kdBouts.length > 0) {
    console.log(`Knockdown-prop backstop checked ${kdBouts.length} bout(s).`);
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
