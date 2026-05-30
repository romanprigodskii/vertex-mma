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

- `model.lgb` — trained booster (best iteration)
- `calibrator.pkl` — isotonic regression on val
- `metadata.json` — feature columns, params, per-split metrics, model_version

Current baseline (v0.1.0): test accuracy ~64 %, AUC ~0.67, log-loss
~0.65. Roughly in line with the bookmaker-favorite hit rate (~67 %),
and the honest ceiling on UFC prediction with only career-aggregate
features. External-odds coverage is still thin (23 rows at time of
writing) — every additional opening line the scraper backfills will
move accuracy up by ~0.5–1 pp.

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
