# Migration manifest — apply order & settlement source-of-truth

These `.sql` files are **hand-authored DDL** (PL/pgSQL functions, triggers, RLS
policies, views, generated columns) applied **out of band** — via `psql` or the
`scripts/apply_*.ts` / `scripts/wave*_apply.ts` runners. They are **not** consumed
by `drizzle-kit push` (our migration mechanism, per `package.json` → `db:push`),
which only diffs *table schema* from `src/lib/db/schema/**` against the live DB and
would happily drop function/RLS drift. There has therefore never been a drizzle
`meta/_journal.json` (it pairs each entry with a snapshot drizzle-kit only writes
under `generate`/`migrate`, which we don't use). **This file is the ordering
record in its place**: apply in ascending numeric order; every file is idempotent
(`CREATE OR REPLACE`, `IF EXISTS`, guarded `DO $$`), so re-running is safe.

## Settlement subsystem — single source of truth

The money-path settlement functions had accreted divergent copies with no pinned
order (two files were both `0086`), so the *last* one applied silently won. As of
**`0089_wave60_settlement_canonical.sql`** there is exactly one authoritative
definition of every settlement function. Apply it last; its `CREATE OR REPLACE`
wins regardless of how the historical snapshots interleave.

| Function | Canonical definition | Mirrored (KEEP IN SYNC) by | Superseded historical copies |
|---|---|---|---|
| `fixed_odds_method_bucket`, `fixed_odds_grade` | `0089_wave60` | `scripts/apply_parlay_settlement.ts` | `0088_wave59` |
| `settle_fixed_odds_bets_for_bout` | `0089_wave60` | `apply_parlay_settlement.ts`, `apply_notification_params.ts` | `0088_wave59`, `0064`/`0066` |
| `settle_parlay_legs_for_bout` | `0089_wave60` | `apply_parlay_settlement.ts`, `apply_notification_params.ts` | `0085_wave57`, `0088_wave59` |
| `unlock_betting_achievements` | `0089_wave60` | `apply_parlay_settlement.ts` | `0088_wave59` |
| `settle_market_winner` / `_method` / `_outcome` | `0089_wave60` | `apply_notification_params.ts` | `0061`,`0064`,`0065`,`0066`,`0085` |
| `refund_market`, `check_and_promote_tier`, `unlock_achievement` | `0089_wave60` | `apply_notification_params.ts` | `0064`, `0065` |

The triggers `on_bout_auto_settle` (LMSR; bound in `0085_wave57`) and
`on_bout_settle_fixed_odds` (fixed-odds; bound in `scripts/apply_parlay_settlement.ts`)
are left bound as-is — `CREATE OR REPLACE FUNCTION` swaps each body in place, so
they pick up the canonical code.

### What `0089_wave60` fixes (vs. the historical copies)
1. **`fixed_odds_grade`** — a `completed` bout with a winner but a still-`NULL`
   method (`'unknown'` bucket) now VOIDs every non-winner prop (grading only
   `win_a`/`win_b`); the old grader marked them LOST, an irreversible wrong loss.
   Mirrors `settleSelection` in `src/lib/sportsbook.ts` (the TS oracle).
2. **`settle_parlay_legs_for_bout`** — a fully-won parlay (no voided leg) pays the
   stored `potential_payout`/`combined_odds`, not a float-odds recompute. This was
   added in `0085_wave57` then accidentally reverted by `0088_wave59` (which
   regenerated from the Wave-49 base).
3. **bigint money-path locals** — `v_new_balance` / `v_total_earned` are bigint.
   Wave 58 (`0087`) widened the balance/earned columns to bigint; the int4 locals
   would raise `integer out of range` above ~2.1e9 and roll back the settlement.

## Numbering anomalies

Resolved here:
- **`0086` duplicate (settlement)** — `0086_wave59_settlement_bigint.sql` →
  renamed **`0088_wave59_settlement_bigint.sql`** (it is chronologically Wave 59,
  i.e. after `0087`/Wave 58). `0086_wave57_drop_predictions.sql` keeps `0086`
  (it pairs with `0085`/Wave 57).

Pre-existing, **not** settlement-related — left untouched (owned by the
scoring/simulator history; flagged here for that owner, not reordered to avoid
rewriting an unrelated subsystem's record):
- **`0068` duplicate** — `0068_remove_simulator.sql` and
  `0068_wave31_age_layoff_ceiling_recency.sql` share a number. Free slots `0067`
  and `0077` exist if it is later renumbered.
- **Missing numbers** — `0035`, `0037`, `0067`, `0077` are unused (squashed /
  reverted during development); no action needed.
