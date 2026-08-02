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

Where the model stands against the closing line. Every number below
names the basis it was measured on, because the two bases disagree by
more than the effect anyone is arguing about — an earlier version of
this README quoted 66.9 % against a rolling window that does not
produce it, and a ~2.4 pp gap that no basis produces.

* **Static test split** (event date ≥ 2025-01-01, averaged over both
  fighter orderings, n=568 bouts that have a closing line):
  model **0.6690 accuracy / 0.6198 log-loss**, market **0.6796 /
  0.5968**. The 1.1 pp accuracy difference is NOT established —
  McNemar exact p = 0.72, i.e. the two disagree on individual fights
  about as often in each direction as chance predicts.
* **Rolling retrain**, 2025-07..2026-07, main segment (n=417):
  model **0.6475 accuracy / 0.6218 log-loss**; market 0.6929 on the
  394 of those with a line. Rolling is the honest number for "how
  would this have performed week to week"; the static split is the
  one every earlier metric in this README was measured on.

The log-loss gap decomposes cleanly, and this is the useful part:
calibration is at **parity** (reliability 0.00296 model vs 0.00303
market — lower is better), while **resolution** is 0.03812 vs
0.04580. The entire deficit is sharpness on lopsided matchups: the
book knows which mismatches are real and we don't. Three attempts to
close it by tuning — post-blender recalibration, re-selecting the
blend on the tail bucket, removing the age throttle — all failed
their gate (`docs/tail_resolution.md`). The remaining lever is
information, not fitting: booking circumstance (short notice,
replacement opponent, missed weight), which the scraper began
accruing in `bout_change_event` / `first_seen_at` and which cannot be
backfilled.

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
│   ├── train.py            # LightGBM + isotonic + metrics + save
│   └── predict.py          # load artifacts → upsert bout_simulation
├── scripts/
│   ├── run_train.py        # CLI: full pipeline (export → features → train)
│   └── run_predict.py      # CLI: predict upcoming + write DB
├── artifacts/              # committed: model.lgb, calibrator.pkl, metadata.json
└── data/                   # cache: dataset.parquet (not committed)
```
