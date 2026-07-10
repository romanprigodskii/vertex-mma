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
the 0.5 threshold). Rolling-retrain backtest 2025-07..2026-07, main
segment (n=417): **66.9 % accuracy, log-loss 0.623, AUC 0.717**;
market on the odds subset 69.3 % / 0.593 — the accuracy gap to the
closing line is down to ~2.4 pp.

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
│   ├── train.py            # LightGBM + isotonic + metrics + save
│   └── predict.py          # load artifacts → upsert bout_simulation
├── scripts/
│   ├── run_train.py        # CLI: full pipeline (export → features → train)
│   └── run_predict.py      # CLI: predict upcoming + write DB
├── artifacts/              # committed: model.lgb, calibrator.pkl, metadata.json
└── data/                   # cache: dataset.parquet (not committed)
```
