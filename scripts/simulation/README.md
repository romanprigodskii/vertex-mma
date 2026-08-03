# Vertex MMA — Simulation (Phase 1)

LightGBM-based winner predictor for upcoming UFC bouts. Writes one row
per scheduled bout to `bout_simulation`; the `/bouts/[id]` page reads
that row and renders a "Vertex Simulation" panel when the bout hasn't
happened yet.

## Phase 1 scope

- Baseline winner-probability model (LightGBM + isotonic calibration)
- Point-in-time feature engineering (no leakage of post-bout stats)
- Temporal train/val/test split (≤2023 / 2024 / 2025+)
- Idempotent inference runner — safe to invoke from cron
- Single confidence label on the bout detail page (low / medium / high)

Phase 2 (SHAP feature attributions) and Phase 3 (Monte Carlo per-round
simulator) are tracked separately. Both extend the same artifacts and
DB tables — no breaking changes planned.

## Install

```bash
cd scripts/simulation
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# macOS only — LightGBM needs OpenMP:
brew install libomp
```

`.env.local` at the project root must contain `DATABASE_URL`. Reused
verbatim from the Next.js app; no new secrets.

## Train

```bash
source venv/bin/activate
python scripts/run_train.py
```

Outputs to `artifacts/`:

- `ensemble/` — served 3-learner ensemble (LGB + XGB + LogReg + blender),
  refit on ALL data
- `ensemble_eval/` — the split-trained twin, kept for out-of-sample evals
- `method_model/` — served conditional method model (v0.12.0), refit on all
  gradeable rows; prices the method / distance / total_rounds legs
- `method_model_eval/` — its split-trained twin, so
  `eval_method_market.py` stays out-of-sample on every moving part
- `metadata.json` — feature columns, params, per-split metrics, model_version

v0.8.0 adds full-slate coverage: bouts with a UFC debutant (~18 % of
the slate, previously skipped entirely) are scored by a dedicated
debut specialist — the same 3-learner ensemble trained on the full
dataset with both-experienced rows down-weighted to 0.2 so the debut
regime dominates (debut probabilities are directional, not sharp, and
the sportsbook only opens debut markets when a consensus line exists
for the edge-guard to anchor to).

v0.9.0 closes the pre-UFC information gap: every fighter's full
Sherdog career (`fighter_sherdog_bout`, scraper step 17, 99.6 % of
bout fighters matched) feeds 14 point-in-time `preufc_*` features —
record/finish rates, career length, REAL regional layoff (a
debutant's UFC layoff_days is NaN by construction), 24-month
activity, last-3 form, Contender Series appearances, finish speed —
plus per-side `sherdog_matched` known-vs-unknown flags. 112 main /
114 specialist columns. Quarterly rolling backtest on the debut
segment 2024-01..2026-07 (n=226): accuracy 53.5 % → 55.8 %,
log-loss 0.677 → 0.676, AUC 0.599 → 0.608 vs the identical recipe
without pre-UFC features; the market on the odds-covered subset sits
at 73 % — tape scouting and camp intel it prices are not in any
record-shaped feature. The single static test split (n=142) is noisy
(±5 pp between splits); trust the rolling numbers. Main model also
improved: test acc 65.1 → 65.6 %, log-loss 0.628 → 0.623,
AUC 0.706 → 0.711 (pre-UFC data fills in 1-2-fight fighters too).

v0.10.0 (small-lever batch, all val-gated + adversarially verified):
Glicko-2 conservative rating (rating − 2·RD — uncertainty baked into
the rating; complements Elo, corr ~0.75), form-trajectory features
(last-3 performance rates vs career baseline — live decline/improve
signal that results-only recent-form misses), and CatBoost replacing
XGBoost in the blend (strongest individual learner on every eval).
Tested and rejected honestly: KO-damage recency (val tie = luck at
the 0.5 threshold).

v0.12.0 moves the METHOD leg. Until now the fixed-odds book took its
winner probability from the 118-feature ensemble and its method / round /
distance probabilities from `monte_carlo.simulate_bout` — a generative
simulator whose entire per-fight input is the ten hand-shrunk fields of
`FighterMC`. No weight class, no gender, no ratings. A 6-cell method
distribution factorises exactly as `LL = LL(winner) + LL(method | winner)`,
and on the held-out window 82 % of the 0.106 nats the closing method line
beat us by lived in the second term.

`src/method_model.py` fits that term directly — P(ko/sub/dec | this side
wins) over the winner model's own feature matrix, called once per
orientation so each side's conditional is an independent estimate.
Held-out test, n=566 bouts with a coherent 6-cell book:

| | 6-cell | = winner | + conditional |
|---|---|---|---|
| production (v0.11.0) | 1.5952 | 0.6096 | 0.9856 |
| **v0.12.0, edge-guarded** | **1.5295** | 0.6096 | **0.9200** |
| devigged market | 1.4966 | 0.5989 | 0.8977 |

Paired bootstrap by bout: 0.066 nats off the production number, improving
in 100 % of resamples. **The book is still ahead** — new − market =
+0.0330 nats with a [+0.0039, +0.0629] interval that excludes zero in the
book's favour. About two thirds of the gap closed, not all of it.
Flat-stake ROI against the closing method lines improves from −26.5 % to
−16.7 % and stays negative.

Three of the four legs move, because `sportsbook.ts` prices method,
`distance` and `total_rounds` off one reconciled distribution: distance
0.6734 → 0.6595, under-2.5 0.6590 → 0.6416, winner 0.6066 → 0.6066 (the
control — this is a mix change, not a re-scoring). Most of the gain is in
reallocating between KO and submission given a finish; the
finish-vs-decision split barely moves. `METHOD_ANCHOR_LAMBDA` was swept
again and selected 0.00: it existed to hide a mix with no resolution.

The lab also found a leak in its own first result, and in the scraper:
`bout.is_title_fight` is set from "any image in the weight-class cell",
which on UFCStats includes the post-fight BONUS icons — so ~30 % of
completed bouts carry it against a real title rate near 5 %, and bonuses
go to finishes. It was the method model's largest feature until removed,
worth 0.132 nats of pure leakage. The winner ensemble is unaffected (rank
114 of 118). Parser fixed, column excluded from the model, existing rows
not yet repaired. Full gate trail and refusal list: `docs/method_leg.md`.

v0.13.0 moves the WINNER leg, which nine labs in a row had failed to
move. Not with a feature: with one coefficient applied after the blend.
`ResidualCorrector` (`src/ensemble.py`) adds −0.2939 logits per ten
years of age advantage to the blended logit, fitted on 3,087
walk-forward out-of-fold bouts and pinned in `config.RESIDUAL_CORRECTION`.

The bias it corrects is large and had gone unnoticed because the market
shares most of it: on bouts where a 35-plus fighter meets someone 28 or
younger, the older side wins 16.4 % of the time, the closing line says
34.3 %, and the ensemble said 37.1 %. Raising the age throttle in
`FEATURE_CONTRI_OVERRIDES` does NOT fix it (+0.0000 on the OOF pool) —
`diff_age` competes with 117 partly collinear columns and three learners
whose disagreement the blend averages toward zero, so the correction has
to live where nothing else is competing with it.

Held-out test, order-averaged: log-loss **0.6131 → 0.6078**, AUC 0.7332
→ 0.7360, gap to the closing line **0.0248 → 0.0196**, and the
market-0.72+ bucket that `tail_resolution.md` could not move at all goes
+0.0770 → +0.0616. Rolling retrain on identical origins: 0.6218 →
0.6159. The method book moves with it (6-cell 1.5273 → 1.5231, ROI at
EV>0 −18.8 % → −15.9 %) because the winner term is shared. Accuracy
drops 0.45 pp — three near-coin-flip picks out of 664 change side, which
is what optimising log-loss instead of accuracy costs.

Applied to the main ensemble only; the debut specialist is untouched and
explicitly ungated. Full trail, including the eleven levers that closed
at zero and the rankings that failed twice: `docs/winner_batch.md`.

Where the model stands against the closing line. Every number below
names the basis it was measured on, because the two bases disagree by
more than the effect anyone is arguing about — an earlier version of
this README quoted 66.9 % against a rolling window that does not
produce it, and a ~2.4 pp gap that no basis produces.

* **Static test split** (event date ≥ 2025-01-01, averaged over both
  fighter orderings, n=582 bouts that have a closing line):
  model **0.6632 accuracy / 0.6118 log-loss**, market **0.6838 /
  0.5922**. Over all 664 test bouts (not just those with a line) the
  model is 0.6732 / 0.6078. The accuracy difference is NOT
  established — the two disagree on individual fights about as often
  in each direction as chance predicts.
* **Rolling retrain**, 2025-07..2026-07, main segment (n=417):
  model **0.6451 accuracy / 0.6159 log-loss**; on the 394 with a line
  the model is 0.6103 against the book's 0.5928. Rolling is the
  honest number for "how would this have performed week to week"; the
  static split is the one every earlier metric in this README was
  measured on.

The log-loss gap decomposes, and after v0.13.0 it decomposes the other
way round from how it used to: **calibration is now BETTER than the
book's** while **resolution** is 0.03826 vs 0.04801. The deficit is
sharpness on lopsided matchups: the book knows which mismatches are
real and we don't.

The calibration half of that sentence used to be quoted as reliability
0.00186 model vs 0.00301 market, off a 10-equal-width-bin Murphy
decomposition. The claim survives; that statistic should not be the one
carrying it. Swept over bin counts on five baseline seeds, the sign of
(model − market) reliability is stable only at 5 bins — at 10, 20 and 40
it flips depending on the seed, because ~30 bouts per bin makes the
statistic measure the market's *dispersion* rather than its calibration,
and the market is the more dispersed series by construction. The
bin-free CORP miscalibration is sign-stable on all five seeds and says
the same thing the README always said: **model 0.0101–0.0132 against the
market's 0.0154** (lower is better). Full sweep: `docs/accuracy_batch.md`
§7.

What closed a fifth of it was not sharpness. `docs/winner_batch.md`
asked each losing segment whether the book was merely SHARPER there or
we were wrong in a DIRECTION, and found one direction big enough to
correct: a 35-year-old facing someone 28 or younger wins 16 % of the
time and the ensemble said 37 %. One coefficient after the blend
(`RESIDUAL_CORRECTION`) took the gap from 0.0248 to 0.0196. Eleven
other levers in the same lab closed at zero, including raising the age
throttle itself — the signal was diluted across 118 collinear columns,
not missing, which is why the fix belongs after the blend.

The remaining deficit is resolution, and resolution needs information:
booking circumstance (short notice, replacement opponent, missed
weight), which the scraper began accruing in `bout_change_event` /
`first_seen_at` and which cannot be backfilled. The official UFC
rankings — the last untapped source in the database, 47k point-in-time
snapshots — were tried twice and failed both gates
(`docs/winner_batch.md` §7).

v0.14.0 does not touch the winner leg either. It closes a COVERAGE hole:
`train_method_model` was handed the both-experienced frame, so the
conditional method model had never seen a debut row, and `predict.py`
passed `method_mix=None` for those bouts — about 19 % of the priced slate
took its method / distance / total_rounds numbers from the simulator's
hazards, whose ten `FighterMC` inputs are all router defaults when one
side has no UFC record. `train_debut_method_model` fits that segment on
the v0.8.0 transfer recipe (both-experienced rows down-weighted to 0.2,
selection on debut val rows only) and beats what production serves there
by **0.048 nats** on 793 walk-forward bouts — −0.048 / −0.053 / −0.046
across three seeds, every interval excluding zero, 100 % of resamples
improving. The winner leg moves by exactly 0.0000; this is a mix change
on a segment, not a re-scoring.

The baseline that gate ran against is worth recording, because the prior
was wrong. It was meant to be a per-length CONSTANT on the debut base
rates, on the reasoning that the MC anchor was a straw man and most of
the gain would be a corrected marginal. Measured, the constant is
**worse** than the anchor (1.0524 vs 1.0091) — the simulator carries real
per-bout signal on debut bouts even on defaults, so the win is a model
win.

Everything else in that batch failed (`docs/accuracy_batch.md`): a
sub-vs-dec temperature, the age correction transferred to the debut
specialist, absolute levels in the debut matrix, and a nationality term in
the corrector. The last one is the interesting refusal. It passed all three
legs of the gate that shipped v0.13.0 — cross-fit −0.0015, forward −0.0020,
held-out −0.0013 — and then the ROLLING basis, which this README calls the
honest week-to-week number, came back **+0.0022** against age alone on
identical origins. Every one of those readings is under the floor below, so
the reading is not "three bases beat one": it is that nothing is resolved,
and a sign that flips between bases is the same condition (g) that kills
levers whose sign flips between seeds. The substrate shipped anyway —
`fighter.sherdog_flag_code` is filled for 4,136 fighters and
`features.CORRECTOR_COLUMNS` carries the column — because building the data
is the expensive part.

What those left behind is instruments and a floor. Two more
walk-forward pools now exist — the conditional method leg is selectable on
**543 submissions** instead of the 71 val rows its own writeup called
noise, and the debut specialist on **798 bouts** instead of 84 — and the
main pool's detection limit is measured for the first time: a one-sided
80 % MDE of **0.0036** on a single seed, 0.0029 with an infinite seed
budget. `RESIDUAL_CORRECTION` is worth −0.0026, i.e. below it. v0.13.0
shipped because three independent legs agreed on its sign, not because any
one reading resolved it — which is the standard to keep, and the reason
more seeds cannot rescue an underpowered arm.

Main model core (v0.7.0 recipe): opponent-adjusted ratings
(`src/opponent_ratings.py`) — online attack/defense skill ratings
(Holmes-style: each performance scored against what THAT opponent
usually allows, updated bout-by-bout like Elo) and opponent-quality
Elo aggregates (who the record was compiled against). The bookmaker
closing line stays the honest upper bound for a fundamentals-only
model.

## Predict upcoming bouts

```bash
source venv/bin/activate
python scripts/run_predict.py
```

Iterates every UFC bout where `status != 'completed'` AND both fighters
have ≥1 prior UFC bout, scores it, and upserts into `bout_simulation`.
Safe to re-run — uses ON CONFLICT (bout_id, model_version) DO UPDATE
so each invocation refreshes existing rows in place.

## Retrain after a card

After a PPV closes and UFCStats publishes the round-by-round, re-run
train so the new fight history is folded into features. Bump
`MODEL_VERSION` in `src/config.py` before commit so old predictions
stay distinguishable from new ones.

```bash
source venv/bin/activate
# edit MODEL_VERSION in src/config.py first
python scripts/run_train.py
python scripts/run_predict.py
git add artifacts/model.lgb artifacts/calibrator.pkl artifacts/metadata.json
git commit -m "sim(v0.X.Y): retrain after UFC <event>"
```

## Cron (VPS)

```cron
# Nightly at 03:30 local — pick up new scheduled bouts, refresh odds
30 3 * * * cd /srv/vertexmma/scripts/simulation && ./venv/bin/python scripts/run_predict.py >> /var/log/vertexmma-sim.log 2>&1
```

(`run_train.py` stays manual — we don't want to silently retrain.)

## Layout

```
scripts/simulation/
├── pyproject.toml          # ruff config
├── requirements.txt
├── src/
│   ├── config.py           # MODEL_VERSION, split dates, LGB params
│   ├── db.py               # psycopg connection (reuses .env.local)
│   ├── dns_override.py     # mirrors photo_scraper trick for libpq DNS
│   ├── export.py           # raw → leakage-free per-bout feature rows
│   ├── features.py         # row → A-B diff matrix (column order locked)
│   ├── method_model.py     # P(ko/sub/dec | this side wins) — the method leg
│   ├── rank_export.py      # point-in-time UFC rankings (built, gated, unused)
│   ├── train.py            # LightGBM + isotonic + metrics + save
│   └── predict.py          # load artifacts → upsert bout_simulation
├── scripts/
│   ├── run_train.py        # CLI: full pipeline (export → features → train)
│   └── run_predict.py      # CLI: predict upcoming + write DB
├── artifacts/              # committed: ensemble/, method_model/, corrector.json, metadata.json
└── data/                   # cache: dataset.parquet (not committed)
```
