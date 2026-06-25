/**
 * Vertex Sportsbook — house-P&L / solvency backtest.
 *
 * The audit (point 7) flagged that a zero-margin book is structurally <=-EV for
 * the house and that NO backtest existed to check it. This replays every
 * SETTLED bout that carried a model prediction through the exact production odds
 * engine (computeSportsbookOutcomes) and grader (settleSelection), simulates a
 * uniform bettor (equal stake on EVERY selection of every market), and reports
 * the house's realized P&L per market under several margin scenarios.
 *
 * Reading it:
 *   - "uniform bettor" backs both sides of every market, so the result is the
 *     realized house HOLD = structural overround ± model miscalibration. A book
 *     that holds < 0 on a market is losing coins on it in the long run.
 *   - voided bets (draw/NC/DQ/missing-round) refund the stake → excluded from
 *     staked + hold, counted separately.
 *
 *   Usage: npx tsx scripts/backtest_sportsbook.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

import { install as installDnsFallback } from "../src/lib/dns-fallback";
import {
  HOUSE_MARGIN_PROP,
  HOUSE_MARGIN_WINNER,
  type BoutResult,
  type SportsbookMarketKind,
  type SportsbookSimInput,
  computeSportsbookOutcomes,
  oddsForMarket,
  potentialPayout,
  settleSelection,
} from "../src/lib/sportsbook";

installDnsFallback();

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 3 });

/** Flat stake per selection. Large enough that the floor() in payout doesn't
 *  swamp the signal at typical odds. */
const STAKE = 1000;

/** Margin scenarios to sweep: [winner tier, prop tier]. The shipped tier is
 *  marked so it's easy to spot. */
const SCENARIOS: { label: string; winner: number; prop: number }[] = [
  { label: "no-vig 0% / 0%", winner: 0, prop: 0 },
  { label: "flat 6% / 6%", winner: 0.06, prop: 0.06 },
  {
    label: `shipped ${pct(HOUSE_MARGIN_WINNER)} / ${pct(HOUSE_MARGIN_PROP)}`,
    winner: HOUSE_MARGIN_WINNER,
    prop: HOUSE_MARGIN_PROP,
  },
  { label: "heavy 6% / 12%", winner: 0.06, prop: 0.12 },
];

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function marginFor(
  kind: SportsbookMarketKind,
  s: { winner: number; prop: number },
): number {
  return kind === "winner" ? s.winner : s.prop;
}

interface SimRow {
  bout_id: string;
  status: string;
  winner_id: string | null;
  fighter_a_id: string;
  fighter_b_id: string;
  method: string | null;
  round_finished: number | null;
  scheduled_rounds: number | null;
  prob_a: number;
  prob_b: number;
  market_prob_a: number | null;
  prob_ko_a: number;
  prob_ko_b: number;
  prob_sub_a: number;
  prob_sub_b: number;
  prob_decision_a: number;
  prob_decision_b: number;
  prob_finish_round_1: number | null;
  prob_finish_round_2: number | null;
  prob_finish_round_3: number | null;
  prob_finish_round_4: number | null;
  prob_finish_round_5: number | null;
}

/** Per (scenario, market) running tally. */
interface Tally {
  bets: number;
  voids: number;
  staked: number;
  housePnl: number;
}

function blankTally(): Tally {
  return { bets: 0, voids: 0, staked: 0, housePnl: 0 };
}

async function main() {
  // Latest prediction per completed bout that also has a Monte-Carlo rounds row.
  const rows = (await sql`
    SELECT DISTINCT ON (b.id)
      b.id::text AS bout_id,
      b.status::text AS status,
      b.winner_id::text AS winner_id,
      b.fighter_a_id::text AS fighter_a_id,
      b.fighter_b_id::text AS fighter_b_id,
      b.method::text AS method,
      b.round_finished AS round_finished,
      b.scheduled_rounds AS scheduled_rounds,
      bs.prob_a, bs.prob_b, bs.market_prob_a,
      br.prob_ko_a, br.prob_ko_b, br.prob_sub_a, br.prob_sub_b,
      br.prob_decision_a, br.prob_decision_b,
      br.prob_finish_round_1, br.prob_finish_round_2, br.prob_finish_round_3,
      br.prob_finish_round_4, br.prob_finish_round_5
    FROM bout b
    JOIN bout_simulation bs ON bs.bout_id = b.id
    JOIN bout_simulation_rounds br
      ON br.bout_id = b.id AND br.model_version = bs.model_version
    WHERE b.status = 'completed'
    ORDER BY b.id, bs.generated_at DESC
  `) as unknown as SimRow[];

  console.log(`Replaying ${rows.length} settled bouts with predictions…\n`);

  // tallies[scenarioLabel][marketKind] = Tally
  const tallies = new Map<string, Map<SportsbookMarketKind, Tally>>();
  for (const s of SCENARIOS) tallies.set(s.label, new Map());
  const get = (label: string, kind: SportsbookMarketKind): Tally => {
    const m = tallies.get(label)!;
    let t = m.get(kind);
    if (!t) {
      t = blankTally();
      m.set(kind, t);
    }
    return t;
  };

  let graded = 0;
  for (const r of rows) {
    const sim: SportsbookSimInput = {
      probA: r.prob_a,
      probB: r.prob_b,
      marketProbA: r.market_prob_a,
      rounds: {
        probKoA: r.prob_ko_a,
        probKoB: r.prob_ko_b,
        probSubA: r.prob_sub_a,
        probSubB: r.prob_sub_b,
        probDecisionA: r.prob_decision_a,
        probDecisionB: r.prob_decision_b,
        finishByRound: [
          r.prob_finish_round_1,
          r.prob_finish_round_2,
          r.prob_finish_round_3,
          r.prob_finish_round_4,
          r.prob_finish_round_5,
        ],
      },
    };
    const result: BoutResult = {
      status: r.status,
      winnerId: r.winner_id,
      fighterAId: r.fighter_a_id,
      fighterBId: r.fighter_b_id,
      method: r.method,
      roundFinished: r.round_finished,
      scheduledRounds: r.scheduled_rounds,
    };

    const outcomes = computeSportsbookOutcomes(sim);
    if (outcomes.length === 0) continue;
    graded++;

    // Group fair probs by market so we can re-price at each scenario margin.
    const byMarket = new Map<
      SportsbookMarketKind,
      { code: (typeof outcomes)[number]["code"]; prob: number }[]
    >();
    for (const o of outcomes) {
      const list = byMarket.get(o.marketKind) ?? [];
      list.push({ code: o.code, prob: o.prob });
      byMarket.set(o.marketKind, list);
    }

    for (const s of SCENARIOS) {
      for (const [kind, sels] of byMarket) {
        const odds = oddsForMarket(
          sels.map((x) => x.prob),
          marginFor(kind, s),
        );
        sels.forEach((sel, i) => {
          const status = settleSelection(sel.code, result);
          const t = get(s.label, kind);
          if (status === "void") {
            t.voids++;
            return;
          }
          t.bets++;
          t.staked += STAKE;
          const payout = status === "won" ? potentialPayout(STAKE, odds[i]) : 0;
          t.housePnl += STAKE - payout;
        });
      }
    }
  }

  console.log(`Graded ${graded} bouts (uniform ${STAKE}-coin stake per selection).\n`);

  const MARKET_ORDER: SportsbookMarketKind[] = [
    "winner",
    "method",
    "total_rounds",
    "distance",
  ];
  for (const s of SCENARIOS) {
    console.log(`── ${s.label} ───────────────────────────────`);
    console.log(
      `${"market".padEnd(14)}${"bets".padStart(8)}${"voids".padStart(8)}` +
        `${"house P&L".padStart(14)}${"hold%".padStart(9)}`,
    );
    let allBets = 0;
    let allStaked = 0;
    let allPnl = 0;
    let allVoids = 0;
    for (const kind of MARKET_ORDER) {
      const t = tallies.get(s.label)!.get(kind);
      if (!t) continue;
      allBets += t.bets;
      allStaked += t.staked;
      allPnl += t.housePnl;
      allVoids += t.voids;
      const hold = t.staked > 0 ? (t.housePnl / t.staked) * 100 : 0;
      console.log(
        `${kind.padEnd(14)}${String(t.bets).padStart(8)}${String(t.voids).padStart(8)}` +
          `${fmtCoins(t.housePnl).padStart(14)}${`${hold.toFixed(2)}%`.padStart(9)}`,
      );
    }
    const allHold = allStaked > 0 ? (allPnl / allStaked) * 100 : 0;
    console.log(
      `${"ALL".padEnd(14)}${String(allBets).padStart(8)}${String(allVoids).padStart(8)}` +
        `${fmtCoins(allPnl).padStart(14)}${`${allHold.toFixed(2)}%`.padStart(9)}`,
    );
    console.log("");
  }

  console.log(
    "hold% > 0 = house wins long-run on that market. A no-vig book trending\n" +
      "<= 0 (esp. on props) is the structural -EV the margin fixes.",
  );
  await sql.end();
}

function fmtCoins(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString()}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
