# Vertex MMA

**A UFC analytics platform built around a machine-learning fight predictor that is honest about its own limits.**

Live at **[vertexmma.com](https://vertexmma.com)** · English + Russian · virtual currency only, no real-money betting

![Next.js 16](https://img.shields.io/badge/Next.js-16.2-000?logo=nextdotjs&logoColor=white)
![React 19](https://img.shields.io/badge/React-19.2-087EA4?logo=react&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-5.9%20strict-3178C6?logo=typescript&logoColor=white)
![Tailwind 4](https://img.shields.io/badge/Tailwind-4.3-06B6D4?logo=tailwindcss&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-Supabase-3ECF8E?logo=supabase&logoColor=white)
![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![LightGBM · CatBoost](https://img.shields.io/badge/ML-LightGBM%20%C2%B7%20CatBoost-9cf)

---

Vertex MMA scrapes the entire UFC record, rates every fighter with a rating system built in SQL,
trains a bout-outcome model on point-in-time features, and prices four betting markets off that
model's own probabilities. It runs on one VPS, updates itself from cron, and publishes the model's
scoreboard against the closing line — including the parts where the bookmaker wins.

| | |
|---|---|
| **Fighters** | 4,581 · **Bouts** 8,906 · **Events** 795 |
| **Derived rows** | 243k Vertex score-history · 49k official ranking snapshots · 86k Sherdog career bouts · 41k round-stat rows · 31k judge scorecards |
| **Model** | 118 features · 3-learner ensemble + post-blend correction · 10,000-run Monte-Carlo simulator |
| **Front end** | 35 routes × 2 locales · 1,533 translation keys per locale · dark-first OKLCH design tokens |

*Counts as of 2026-08.*

---

## Contents

- [What you can do on it](#what-you-can-do-on-it)
- [The prediction model](#the-prediction-model)
- [The Vertex Score](#the-vertex-score)
- [Data pipeline](#data-pipeline)
- [Architecture](#architecture)
- [Database](#database)
- [Running it locally](#running-it-locally)
- [Deployment](#deployment)
- [Tests and quality gates](#tests-and-quality-gates)
- [Known gaps](#known-gaps)

---

## What you can do on it

| Area | Routes | What's there |
|---|---|---|
| **Fighters** | `/fighters`, `/fighters/[slug]` | Catalog with 11 filters and 11 sort modes; profiles with Vertex score, career timeline, radar attributes, striking heatmaps, round-by-round averages, score history chart, collectible card |
| **Compare** | `/fighters/compare` | Two-fighter tale of the tape, overlap radar, common opponents, and a heuristic win estimate (deliberately *not* the ML model) |
| **Events & bouts** | `/events`, `/events/[slug]`, `/bouts/[id]` | Full cards, results, judge scorecards, strike analysis, embedded fight videos, and the model's pick on upcoming bouts |
| **Simulation** | `/simulation`, `/simulation/custom` | Model index for the upcoming slate with confidence and edge-vs-market, recent graded accuracy, plus a "dream fight" simulator that scores any two fighters at any point in their careers |
| **Betting** | `/markets`, `/bouts/[id]`, `/parlay/[id]` | Fixed-odds sportsbook priced off the model (winner / method / totals / distance), parlay slip, and an LMSR prediction-market implementation |
| **Rankings** | `/rankings` | 13 Vertex-score boards (P4P + divisions, current and all-time) plus user-built ranking lists |
| **News** | `/news`, `/news/[id]` | LLM-classified, rephrased and translated MMA news with fighter/event linking and threaded comments |
| **Accounts** | `/profile/[username]`, `/me/bets`, `/leaderboard` | Virtual coin balance, 5-tier progression, 10 achievements, transaction ledger, leaderboard |

Everything is server-rendered (Next.js App Router, `force-dynamic` on data pages), fully bilingual —
English unprefixed, Russian under `/ru` — with dark and light themes.

---

## The prediction model

Lives in [`scripts/simulation/`](./scripts/simulation) (Python). It is **six fitted objects plus a
Monte-Carlo simulator**, not one model:

| Object | Predicts | Features |
|---|---|---|
| Winner ensemble | P(A wins), both fighters experienced | 118 |
| Debut specialist | Same, when either fighter is a UFC debutant | 120 |
| Method model | P(KO / submission / decision \| this side wins) | 184 |
| Debut method model | Same, for the debut segment | 184 |
| Finish hazard | *When* a finish lands (cause-specific Poisson) | 13 covariates + 6 time terms |
| Decision model | Who wins a decision (no-intercept logistic) | 10 |
| Monte Carlo | 10,000 simulations → 6-cell outcome × round distribution | 10 fields |

The winner ensemble is **LightGBM + CatBoost + logistic regression**, blended with weights chosen on a
validation window, then order-averaged over both fighter orderings, then adjusted by a single
post-blend coefficient (−0.2939 logits per ten years of age advantage — the one correction that ever
survived a gate).

### How it does against the closing line

Model `v0.14.0`, held-out test window (`event_date ≥ 2025-01-01`), from the committed
`artifacts/metadata.json`:

| | Accuracy | Log-loss | Brier | AUC |
|---|---|---|---|---|
| Model, all 664 bouts | 0.6747 | 0.6137 | 0.2124 | 0.7244 |
| Model, 582 bouts that carry a line | 0.6753 | 0.6171 | 0.2140 | — |
| **Bookmaker closing line, same 582** | **0.6838** | **0.5922** | **0.2035** | — |

The weekly retrain refreshes these; `artifacts/metadata.json` is always the source of truth for
what is being served.

**The book is ahead**, by roughly 0.025 nats of log-loss, and the repository says so everywhere
rather than quoting a friendlier basis. The interesting part is the decomposition: the model is
now *better calibrated* than the closing line and *less sharp* — the remaining deficit is
resolution, and resolution needs information the record doesn't contain (short-notice bookings,
camp intel, injuries).

Every metric names the basis it was measured on, because the two bases disagree by more than most
effects being argued about: metrics in `metadata.json` are single-orientation, while lab and rolling
numbers are order-averaged the way production serves them.

### What makes it unusual

- **Point-in-time everything.** Five independent mechanisms keep the future out of the features:
  snapshot-then-apply history, strictly-`<` rating lookups, a separate chronological ratings replay,
  a date-bounded pre-UFC career walk, and a frozen percentile-clipping anchor.
- **The market is not an input.** Bookmaker odds are stored, displayed and used for evaluation, but
  never enter the feature matrix — they are a closing line, which would be a near-leak in backtests.
  Removing them cost 1.5 points of test accuracy, and the number stayed removed.
- **A measured detection floor.** Five seeds on a 3,087-bout walk-forward pool put the one-sided 80%
  MDE at **0.0036 nats**. The only lever ever shipped to the winner leg is worth −0.0026 — *below its
  own floor*. It shipped because three independent evaluation legs agreed on the sign, not because
  any single reading resolved it.
- **A written record of failure.** Roughly two dozen ideas were built, gated and rejected — official
  UFC rankings (twice), recency weighting, seed bagging, symmetry augmentation, a graded outcome
  label, non-UFC regional fights as training rows, post-hoc calibration, a submission-specific
  axis. One shipped feature was found to be a data leak (a "title fight" flag that was really a
  post-fight bonus icon) and the result that depended on it was withdrawn.

Full write-ups: [`docs/model_overview.md`](./scripts/simulation/docs/model_overview.md) (the
top-down spec), [`winner_batch.md`](./scripts/simulation/docs/winner_batch.md),
[`method_leg.md`](./scripts/simulation/docs/method_leg.md),
[`accuracy_batch.md`](./scripts/simulation/docs/accuracy_batch.md).

### From probabilities to prices

[`src/lib/sportsbook.ts`](./src/lib/sportsbook.ts) turns one reconciled distribution into four
markets — winner, method (6 cells), over/under 2.5 rounds, and goes-the-distance — so they cannot be
arbitraged against each other. House margin is 4% on the winner and 8% on props; where a bookmaker
consensus exists the model probability is clamped to ±15pp of it, and bouts with a debutant are only
bettable when a real line exists (the debut specialist loses to the books on that segment, and the
code says so).

---

## The Vertex Score

A 0–100 fighter rating computed **in Postgres views**, not in application code, in two flavours
(current form and all-time) plus a per-division variant.

The current-form score weights quality of wins, championship pedigree, era dominance, performance
differential, finishing dominance, activity and recent form, subtracts recent-loss and defensive
vulnerability penalties, applies an age factor and a credibility damp for short UFC careers, then
re-anchors through a piecewise curve and applies stacked skid penalties. All-time drops the recency
terms and adds peak career score.

The inputs are computed by a fixed chain of TypeScript jobs — opponent quality tiering (17,644 rows,
using point-in-time official ranking snapshots rather than today's rank), championship pedigree, era
dominance, radar aggregates, then a per-bout replay of the whole formula into 243k score-history
rows. `headlineScore()` is the single display rule: retired fighters show all-time, active fighters
show divisional-or-global current.

---

## Data pipeline

Three Python packages, each with its own virtualenv, plus TypeScript compute jobs.

**Scrapers** (`scripts/scraper/`) — 18 numbered steps against ufcstats.com (events, fighters, bouts,
per-fighter career stats, per-round stats), mmadecisions.com (judge scorecards),
bestfightodds.com (winner and method lines), Sherdog (pre-UFC regional careers), UFC.com (official
rankings), and YouTube (full-fight videos). Sequential, rate-limited, checkpointed, with a
non-fatal error log.

**News** (hourly) — RSS from three sources → article extraction with trafilatura → classification
into 8 categories with `claude-haiku-4-5` → rephrasing → Russian translation with `claude-sonnet-4-6`.
A confidence gate decides auto-approval, and a stricter one may create provisional events and bouts
from a headline, which the UFCStats scraper later adopts or reconciles.

**Photos** — Wikipedia/Commons with a mandatory licence check (CC0 / PD / CC BY / CC BY-SA only),
plus a separate UFC.com path stored under an explicit `ufc_editorial` label.

**Cron on the VPS** — nine jobs, coordinated with `flock`:

| When | Job |
|---|---|
| hourly | News ingest chain |
| every 6h | Event/bout refresh + odds + materialized-view refresh |
| every 6h (+20m) | Read-only card-drift check against UFCStats |
| 03:30 | Official UFC rankings |
| 04:00 | Sherdog pre-UFC careers |
| 04:30 | Round stats, scorecards, then the 13-step recompute chain |
| 05:15 | Model scoring of the upcoming slate |
| Sun 05:30 | Full A–Z scrape |
| Sun 07:00 | Model retrain — commits new weights to `main` only if the bytes changed |

The recompute chain is ordered and mostly fail-fast, because two of its steps truncate and
repopulate; the 04:30 slot exists so that window lands at night.

---

## Architecture

```
src/
  app/[locale]/        35 routes, App Router, server components
  app/api/             fighter search, news search, 5 OG-image renderers
  components/          137 files — fighter, bout, markets, news, simulation, layout
  lib/
    db/schema/         Drizzle schema, 8 modules
    sportsbook.ts      fixed-odds engine (DB-free, unit-tested)
    lmsr.ts            log market scoring rule
    vertex-tier.ts     headlineScore(), tiers, champion styling
    official-rankings.ts, fighter-search.ts, fighter-detail.ts, ...
  i18n/                next-intl routing and message loading
messages/              en.json + ru.json, 1,533 keys each
drizzle/migrations/    93 hand-written SQL files
scripts/
  scraper/             Python — UFCStats, Sherdog, odds, news
  simulation/          Python — the ML model, its labs and artifacts
  photo_scraper/       Python — fighter portraits
  odds_scraper/        Python — historical odds backfill
  *.ts                 ~90 tsx compute/apply jobs
ops/
  cron/                VPS wrappers + crontab
  systemd/             dream-fight worker unit
  umami/               self-hosted analytics stack
```

**Stack:** Next.js 16.2 (App Router, React Compiler, standalone output) · React 19.2 · TypeScript 5.9
strict · Tailwind 4 (CSS-first `@theme`, OKLCH tokens, dark-first) · Drizzle ORM over postgres.js ·
Supabase (Postgres, Auth, Storage) · next-intl · Radix primitives · Python 3.12 with
LightGBM / CatBoost / scikit-learn / pandas.

---

## Database

43 tables in `public`, 37 of them declared in Drizzle across 8 modules:

| Module | Tables |
|---|---|
| `fighters.ts` | `fighter`, `fighter_alias`, `fighter_stats_aggregate`, `ranking_snapshot`, `fighter_divisional_score`, `fighter_score_history`, `fighter_sherdog_bout` |
| `events.ts` | `event`, `bout`, `bout_change_event`, `bout_round_stats`, `bout_scorecard`, `title_fight_bout`, `bout_external_odds`, `bout_video` |
| `simulation.ts` | `bout_simulation`, `bout_simulation_features`, `bout_simulation_rounds`, `custom_simulation` |
| `markets.ts` | `market`, `market_outcome`, `bet`, `fixed_odds_bet`, `parlay`, `parlay_leg` |
| `users.ts` | `user_profile`, `transaction`, `achievement`, `user_achievement`, `notification` |
| `news.ts` | `news_source`, `news_item`, `news_comment`, `news_comment_flag`, `news_comment_vote` |
| `rankings.ts` | `custom_ranking`, `custom_ranking_entry` |
| `enums.ts` | 17 `pgEnum` definitions |

Three SQL objects carry the rating and are defined in migrations rather than Drizzle:
`fighter_vertex_score` and `fighter_divisional_vertex_score` (views) and `fighter_with_stats`
(materialized, refreshed concurrently by cron).

**Migrations are two mechanisms, not one.** `drizzle-kit push` syncs the declared schema; everything
that Drizzle cannot express — views, triggers, PL/pgSQL settlement functions, RLS policies, backfills
— lives in 93 hand-written SQL files applied by one-off `scripts/*_apply.ts` runners. There is no
ledger table, so nothing records which SQL has run.

> **Warning:** `pnpm db:push` is destructive against this database. Six live tables are not declared
> in the schema (including `bout_opponent_tier`, 17k rows), and `push --force` drops RLS policies.
> Use migration SQL plus an apply script.

---

## Running it locally

**Prerequisites:** Node 22, pnpm 11.1.0, Python 3.12 (only for the scrapers and the model), and a
Supabase project.

```bash
pnpm install
cp .env.example .env.local     # fill in the values below
pnpm dev                       # http://localhost:3000
```

Required environment:

| Variable | Used by |
|---|---|
| `DATABASE_URL` | app, every Python package, every compute script |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | auth (inlined at build time) |
| `SUPABASE_SERVICE_ROLE_KEY` | avatar and photo uploads |
| `ANTHROPIC_API_KEY` | news classification, rephrasing, translation |
| `NEXT_PUBLIC_SITE_URL`, `ADMIN_EMAILS` | optional — canonical URLs, staff allowlist |

Database bootstrap: run `drizzle/migrations/0000_enable_extensions.sql` in the Supabase SQL editor
(`CREATE EXTENSION` needs privileges `push` doesn't have), then `pnpm db:push`, then apply the
migration SQL you need with the matching `scripts/*_apply.ts`.

**Common commands**

```bash
pnpm dev / build / start          # Next.js
pnpm test                         # node:test over src/**/*.test.ts
pnpm type-check                   # tsc --noEmit
pnpm lint                         # eslint

pnpm scrape:setup && pnpm scrape:quick    # events + fighters + bouts
pnpm scrape:enrich                        # career + per-round stats
pnpm odds:scrape                          # bookmaker lines
pnpm news:ingest                          # full news chain
pnpm photos:setup && pnpm photos:fetch    # fighter portraits

cd scripts/simulation
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python scripts/run_train.py    # retrain, writes artifacts/
./venv/bin/python scripts/run_predict.py  # score upcoming bouts
```

The model's artifacts are committed, so `run_predict.py` works on a fresh clone without retraining.

---

## Deployment

A single VPS running **Coolify**, which builds the repo `Dockerfile` (`node:22-alpine`, standalone
output, non-root) and fronts it with Traefik and Let's Encrypt. **Push to `main` deploys.**
Supabase provides Postgres, auth and storage; Resend sends auth mail; analytics is self-hosted
Umami at `stats.vertexmma.com` (cookie-free, no consent banner).

A second checkout on the same box runs the data pipeline from root cron, independent of the app
container, plus a systemd unit for the dream-fight worker that polls the custom-simulation queue.

Two automated committers push to `main` from the VPS: the recompute chain commits regenerated
champion/title-fight files when they actually change, and the weekly retrain commits new model
weights when the bytes differ. Both trigger a redeploy.

`docker-compose.yml` and `nginx/` are the alternative no-Coolify path and are not used in production.
Setup walkthrough: [`docs/deploy.md`](./docs/deploy.md).

---

## Tests and quality gates

Stated plainly, because the gaps are as informative as the coverage:

- **`pnpm test`** — Node's built-in runner over 4 files in `src/lib/`: 96 tests covering the
  fixed-odds engine, LMSR pricing, market odds and the compare heuristic. Money math is tested;
  components, routes and end-to-end flows are not.
- **`pnpm type-check`** — clean, repo-wide, `strict: true`, and `next build` enforces it.
- **`pnpm lint`** — currently red: 13 errors from three React Compiler rules
  (`set-state-in-effect`, `purity`, `refs`) that are accepted rather than fixed.
- **Python** — hand-run test scripts across the scraper and the model (leak bans, label mirroring,
  point-in-time rank contracts, the residual correction's antisymmetry). No pytest, no collector.
- **CI** — none. A workflow was written once and lost in a merge. Nothing gates a deploy except the
  type-check inside the Docker build.

---

## Known gaps

- No CI, no health endpoint, no error tracking, no `LICENSE` file.
- `drizzle-kit push` cannot be used safely (see the database warning above).
- RLS covers 16 of 43 tables; several user-owned tables rely on server-action auth only.
- The LMSR prediction-market half of `/markets` is idle — market generation is a manual script and
  isn't scheduled, so only the fixed-odds board is populated.
- The Monte-Carlo timing and decision models are fitted by lab scripts that the weekly retrain does
  not call, so they age between manual refits.
- Booking-circumstance data (short notice, opponent changes, missed weight) began accruing in
  2026-07 and cannot be backfilled; it is the most likely source of the model's remaining deficit
  against the closing line, and it needs 12–18 months before it can be tested.
- No Content-Security-Policy yet — the other security headers ship, CSP needs nonce wiring.

---

## Status and licence

Beta, single-author, actively developed — 600+ commits on `main`. All betting is play money; there
are no payments, no real-money wagering and no affiliate links anywhere in the codebase.

No licence file yet: the repository is public for reading and review, not yet licensed for reuse.
