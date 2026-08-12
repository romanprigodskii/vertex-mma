# Model overview — what is actually served, and what it is worth

The map this directory never had. `README.md` is a changelog written version by
version; the lab docs each argue one batch. This file is the top-down view of
**everything that ships**, with the numbers taken from the committed artifacts
rather than from prose — including where the README disagrees with them (§10).

Every number below names its basis, because the two main bases disagree by more
than most of the effects anyone argues about here.

---

## 0. What ships

Six fitted objects and one simulator, not one model:

| # | object | predicts | features | artifact |
|---|---|---|---|---|
| 1 | winner ensemble | P(A wins), both experienced | 118 | `ensemble/` |
| 2 | debut specialist | same, ≥1 UFC debutant | 120 | `ensemble_debut/` |
| 3 | method model | P(ko/sub/dec \| this side wins) | 184 | `method_model/` |
| 4 | debut method model | same, debut segment | 184 | `method_model_debut/` |
| 5 | finish hazard | *when* a finish lands | 13 cov + 6 time | `finish_hazard.json` |
| 6 | decision winner | who wins a decision | 10 | `decision_winner.json` |
| — | Monte Carlo | 10,000 sims → 6 cells × rounds | 10 fields | `monte_carlo.py` |

1–4 each have a split-trained twin (`*_eval/`) so evaluation stays
out-of-sample; production serves the refit-on-all-data version.

**Held-out static test** (`event_date >= 2025-01-01`, n=664, `metadata.json`,
**raw scrape order, not order-averaged**):

| | accuracy | log-loss | brier | AUC |
|---|---|---|---|---|
| model, all 664 | 0.6747 | 0.6137 | 0.2124 | 0.7244 |
| model, 582 with a line | 0.6753 | 0.6171 | 0.2140 | — |
| **market (closing line), same 582** | **0.6838** | **0.5922** | **0.2035** | — |

**Rolling retrain** (production semantics, 4 quarterly origins 2025-07→2026-07,
n=417 main / 394 with a line, **order-averaged**):

| arm | LL all 417 | LL odds subset | accuracy |
|---|---|---|---|
| uncorrected | 0.62384 | 0.61989 | 0.6595 |
| **age corrector (shipped)** | **0.61676** | **0.61150** | 0.6547 |
| age + nationality (refused) | 0.61894 | 0.61241 | 0.6523 |
| market | — | **0.59279** | 0.6929 |

The book is ahead on log-loss on every basis. Claiming otherwise is refused
(`winner_batch.md`).

> **Basis warning.** `metadata.json` metrics are single-orientation; lab and
> rolling metrics are order-averaged (`0.5·[p(A,B) + 1 − p(B,A)]`), which is what
> `predict.py` serves. Raw order understates accuracy by ~2.1 pp. The two sets of
> numbers are not comparable.

---

## 1. Data

Seven SQL queries in one round trip (`export.py:230-248`): `bout ⋈ event`,
`bout_round_stats`, `fighter`, `fighter_sherdog_bout`, `bout_external_odds`,
`fighter_score_history`, `bout_scorecard`. `BOUTS_SQL` ordering
(`e.date, b.bout_order NULLS LAST, b.id`) is load-bearing for the whole
point-in-time walk.

**Deliberately not features:** the market line (closing, UPSERTed every ~6h — a
near-leak plus train/serve skew; removing it cost test accuracy 0.648 → 0.633)
and the scorecards (they produce the graded `dominance_a` label only).

Universe (`data/dataset.parquet`, built 2026-08-03): **8,654 rows** ×178 cols,
1994-03-11 → 2026-08-01; **2,211** debut rows, **6,443** both-experienced,
2,181 with a line; `method_bucket` dec 4,034 / ko 2,886 / sub 1,711 / None 23;
target mean 0.5015 after symmetrization. Emission rule: `(both_experienced or
include_debuts) and (target is not None or (include_scheduled and is_scheduled))`,
where both-experienced means ≥1 prior UFC bout per side.

Draws are never a training row but **are** applied to history (`result="draw"`)
so layoffs and form stay correct; no-contests are neither. The `pd.isna` check on
`winner_id` is a bug fix: NULL arrives from pandas as NaN, so `is None` never
fired and completed draws were emitted as "B wins" and applied as a loss to both
fighters.

Point-in-time discipline, five independent mechanisms: snapshot-then-apply;
strictly-`<` vertex-score lookup; a separate chronological ratings replay reading
only `snaps.pre`; the pre-UFC list breaking on date; and a frozen p99 clip anchor
at `CLIP_ANCHOR_DATE = 2024-07-01`. Reproducibility rests on
`stable_hash = blake2b(digest_size=4)` — the builtin `hash()` is
`PYTHONHASHSEED`-salted and silently broke both the symmetrization mask and the
MC seed.

---

## 2. Features — 118 columns

`build_feature_matrix` emits 120; `feature_names()` freezes 118 (the two
`is_debut_*` flags belong to the specialist only).

| block | construction | count |
|---|---|---|
| `DIFF_COLUMNS` | `diff_{col} = col_a − col_b` | 67 |
| `ABSOLUTE_KEEP` | `abs_{col}_a`, `abs_{col}_b` | 13 → 26 |
| context | `is_title_fight`, `is_main_event`, `scheduled_rounds` | 3 |
| flags | `sherdog_matched_a/b` | 2 |
| `is_womens` | `gender == 'female'` | 1 |
| stance one-hots | 2 sides × (orthodox, southpaw, switch) | 6 |
| interactions | `stance_asymmetry`, `reach_height_ratio_diff`, `age_curve_diff` | 3 |
| weight class | 9 standard + `wc_other` | 10 |

```
stance_asymmetry        = 1[orthodox vs southpaw]
reach_height_ratio_diff = reach_a/height_a − reach_b/height_b
age_curve_diff          = ((age_b − 30)² − (age_a − 30)²) / 100
```

Rate denominators use `stat_seconds` (bouts that actually carried round stats),
never `total_seconds`. `prior_finish_rate` divides by **wins**, `preufc_ko_rate`
by **bouts** — the asymmetry is deliberate and matches `prior_*`.

Eight exported base names reach no feature list (`head_share`, `body_share`,
`legs_share`, `distance_share`, `clinch_share`, `ground_share`,
`title_bouts_ratio`, `finish_for_per_bout`) — 16 dead dataset columns; the
location shares were tried and hurt val.

### 2.1 Ratings (`opponent_ratings.py`) — 20 keys/side

**Elo** `K=32.0`, init 1500, divisor 400. Decisive results only; draws never
reach the update (no 0.5 score path). One global pool, no divisional split, no
inactivity decay.

**Glicko-2 → one column.** `SCALE 173.7178`, `TAU 0.5`, `INIT_RD 350`,
`INIT_VOL 0.06`, `EPS 1e-6`; volatility by Illinois. Rating period = one bout, so
the RD-inflation-for-inactivity step is **not** implemented — a layoff does not
widen RD. Only the conservative transform ships:
`glicko_cons = (1500 + 173.7178·μ) − 2·(173.7178·φ)`, debutant 800.0. Raw rating
and RD as separate columns failed val selection; the diff correlates ~0.75 with
Elo.

**Holmes-style attack/defense**, `RATING_METRICS = (str, grap, kd, ctrl, sub)`:

```
err = min(observed, clip_p99) − (league_mean[m] + off[m][me] + def[m][opp])
off[m][me] += 0.2·err ;  def[m][opp] += 0.2·err          # RATING_LR = 0.2
```

`LEAGUE_PRIOR = {str 3.5, grap 1.5, kd 0.5, ctrl 0.2, sub 0.5}` at
`LEAGUE_PRIOR_WEIGHT = 200` pseudo-observations; `DURATION_FLOOR_S = 60`. The
off/def prior is literally 0.0 (= league mean) and there is **no shrinkage** on
top. Note the sign convention: a higher `*_def` means a **more permeable**
defense. These updates run on draws too — they need stats, not a winner.

**Opponent quality** (5 cols): `avg_opp_elo_career`, `avg_opp_elo_last5`,
`max/avg_opp_elo_beaten` (sentinel 1400.0 with no wins), and
`sos_weighted_winrate = Σ_wins max(0, opp_elo − 1400)/100 ÷ all decisive bouts`.

**Trajectory** (3 cols, window 3, min 2 bouts): recent rate minus career rate for
slpm / sapm / td15.

### 2.2 Pre-UFC (14 cols, v0.9.0)

Unmatched fighter → all 14 `None` **plus** `sherdog_matched = False`; matched with
no regional fights → real zeros. That flag is what lets the model tell the two
apart. `sherdog_matched_a` mean = 0.9993. `preufc_dwcs_fights` matches
`contender series|dwcs`.

### 2.3 `CORRECTOR_COLUMNS` — the column no learner may see

`["diff_is_american"]`, built only under `corrector=True`, **float64 not int8** so
an unknown nationality reaches the corrector as NaN (zero shift) rather than as
the claim "not American". It is in `serving_columns()` and absent from
`feature_names()`: the correction works precisely because nothing competes with
it, and handing the same column to the learners would recreate the dilution it
exists to escape.

---

## 3. Winner model

Split: `TRAIN_END 2024-01-01`, `VAL_END 2025-01-01` → **5,350 / 429 / 664**. The
artifact records val's role as *"early-stop + blender fit + blend-mode select —
OPTIMISTIC, not held-out"*; only `test` is the clean holdout.

**LightGBM**, `LGB_PARAMS` overridden by `best_params.json` (Optuna, 100 trials,
TPESampler(seed=42), best 0.63409 at trial 38): lr 0.039576, leaves 17,
**max_depth 3**, min_data_in_leaf 179, feature_fraction 0.570233,
bagging 0.562038/4, l1 0.031347, l2 0.012816, min_gain_to_split 0.187574,
seed 42 + `deterministic` + `force_row_wise`. Rounds 2000, early stop 100.
`feature_contri` is 1.0 everywhere except `diff_age` 0.45 and `abs_age_a/b` 0.5.

**CatBoost** (replaced XGBoost in v0.10.0), hardcoded: iterations 2000, lr 0.05,
depth 6, seed 42, early stop 100. `thread_count` is not pinned.

**LogReg**: train-mean impute → `StandardScaler` → `max_iter 500, C 0.5,
liblinear, random_state 42`. No missingness indicator.

**Blender** — three fixed strategies scored on val, no weight grid:

| mode | val log-loss |
|---|---|
| logreg blender | 0.6613730 |
| plain mean | 0.6310938 |
| **weighted_mean (selected)** | **0.6208969** |

`weights = softmax(−per_learner_ll / std(per_learner_ll))` gives
**LGB 0.0790 / CatBoost 0.1242 / LogReg 0.7968**. It looks broken and is not:
every fixed replacement is worse (mean +0.0006, fixed 0.2/0.5/0.3 +0.0003, GBTs
only +0.0057, the LogReg blender +0.0268). The temperature is the std of three
numbers, so the rule re-picks the learner that deserves the weight in each era.

**Order averaging** is serve-time only. The model is not antisymmetric
(`abs_*_a/_b`, stance one-hots), so `P(A) = ½·[p(A,B) + 1 − p(B,A)]`. Training on
both orderings is +0.0015 OOF — duplicating rows halves bagging diversity and the
serve-time averaging already collects the benefit.

**No calibrator ships.** `calibrator = None` is hard-set in `fit()`; the five
families exist for the labs only. Isotonic on ~430 val rows moved test log-loss
0.65 → 0.72; on 429 rows val *picks* the 3-param piecewise, which is the worst
family on test; on 3,087 OOF rows every family agrees on T≈0.89, robust in 91% of
bootstraps and worth **+0.0022 of the 0.0229** gap — below the gate. The
`weighted_mean` mode averages probabilities, so by Jensen the output is mildly
under-dispersed and must not be called calibrated downstream.

### 3.1 `ResidualCorrector` (v0.13.0)

```python
RESIDUAL_CORRECTION = {"terms": [{"column": "diff_age", "weight": -0.2939,
                                  "scale": 10.0}], "slope": 1.0}
z' = slope·z + Σ wᵢ·(xᵢ/scaleᵢ)   →   p' = sigmoid(clip(z', ±50))
```

−0.2939 logits per **ten years** of age advantage ≈ −0.03/yr. No intercept and an
(A−B) input, so it negates on a side swap and composes with the order averaging;
NaN contributes exactly zero; a missing column raises `KeyError` rather than
silently serving uncorrected; `slope` is pinned to 1.0 because the coefficients
come from walk-forward models trained on less data than the served one.

What it corrects: a 35-plus fighter facing someone 28 or younger wins **16.4%**;
the ensemble said **37.1%**, the book 34.3%. Raising the age throttle does not fix
it (+0.0000 OOF) — the signal is diluted across 117 partly collinear columns and
three learners whose disagreement the blend averages toward zero, so the fix
belongs after the blend.

Three legs on 3,087 walk-forward OOF bouts: cross-fit **−0.0026** (97%), forward
**−0.0029** (94%), held-out test **−0.0054** (97%). Seeds 7/13 reproduce to the
fourth decimal. **Not applied to the debut specialist** — no `corrector.json` in
either debut dir.

### 3.2 Debut specialist (v0.8.0)

Trained on the full frame with both-experienced rows at
`DEBUT_EXP_ROW_WEIGHT = 0.2`; early stopping and blender select on **debut val
rows only** (84). Blend weights 0.3584 / 0.5843 / 0.0572. Debut test segment
(n=160): acc 0.600, LL 0.6542, AUC 0.6736 against the market's 0.6970 / 0.5638 on
the 132 with a line. The artifact says it plainly: *directional, not sharp* —
which is why the book only opens debut markets when a consensus line exists.

---

## 4. Method leg

A 6-cell distribution factorises exactly as
`LL(6-cell) = LL(winner) + LL(method | winner)`, and **82%** of the 0.106-nat gap
to the closing line lived in the second term. `method_model.py` fits it directly,
winner-first oriented, called once per orientation so the two conditionals are
independent estimates.

Matrix = 119 (base minus `is_title_fight`) + 58 per-side levels + 7 ratio
features = **184**. `USE_LEVELS = True` (0.8870 vs 0.8966 median val, seeds
42/7/13). `USE_SUB_AXIS = False` — the submission axis is built and exported but
gated off at −0.0033 / +0.0038 / −0.0081, not consistent in sign.

Learners: LGB multiclass (lr 0.04, leaves 15, depth 4, 3000 rounds / 150 early),
CatBoost (3000, lr 0.04, depth 5, l2 6.0), LogReg (C 0.3, lbfgs); blend by a
0.1-step simplex grid on val.

| | main | debut (v0.14.0) |
|---|---|---|
| n_train / n_val | 5,340 / 428 | 7,296 / **83** |
| n_served_rows | 6,432 | 8,631 |
| weights lgb/cb/logreg | 0.0 / 0.8 / 0.2 | 0.4 / 0.2 / 0.4 |
| best_iters lgb/cb | 87 / 283 | 137 / 359 |
| val log-loss | **0.88745** | **0.88128** |
| constant baseline | 0.99041 | 1.02543 |
| base rates ko/sub/dec | .3309/.1899/.4792 | .3533/.2377/.4090 |

Held-out, n=566 with a coherent book: 6-cell **1.5952 → 1.5295** (market 1.4966),
conditional **0.9856 → 0.9200**, winner term unchanged at 0.6096. Paired bootstrap
**+0.0656 [+0.0385, +0.0937]**, 100% of resamples improving; against the market
**+0.0330 [+0.0039, +0.0629]** — measurably still behind. Residual by method:
ko +0.0802 (n=189), **sub +0.2141** (n=105), **dec −0.0920** (n=272, ahead of the
book). Three of the four priced legs move: distance 0.6734 → 0.6595, under-2.5
0.6590 → 0.6416, winner **+0.0000** (the control).

Debut leg on 793 walk-forward bouts: model 0.96085 / 0.95625 / 0.96302 (seeds
42/7/13) against the **MC anchor 1.00910** and a per-length constant **1.05242**.
Median **−0.04825**, sign stable, every CI excluding zero. The constant being
*worse* than the anchor is the result that matters: the simulator carries real
per-bout signal on debut rows even on router defaults, so this is a model win and
not a corrected marginal.

---

## 5. Monte Carlo

`FighterMC` is ten shrunk fields (`slpm, sapm, kd_per_fight, sub_per15,
td_per15, td_def, control_per_min, losses_ko_rate, losses_sub_rate,
finish_rate_for`), shrunk as `(rate·n + anchor·k)/(n+k)` with
`SHRINK_PSEUDO_COUNTS = 4.0`. No weight class, no gender, no ratings — the
disparity against the winner model's 118 is what motivated the method leg.

```
H_ko  = 0.185 · clamp(1 + 0.6·(kd/0.35 − 1)) · clamp(1 + 1.0·(loss_ko/0.15 − 1))
H_sub = 0.140 · clamp(1 + 0.8·(sub15/1.0 − 1)) · clamp(1 + 1.0·(loss_sub/0.05 − 1))
clamp [0.4, 2.5];  length_bonus = 1 + 0.12·max(0, R−3)/2;  cap ΣH ≤ 2.302585
```

Neutral matchup: P(any finish) = 0.4780 at 3 rounds, 0.5171 at 5.

**Timing** is a fitted cause-specific Poisson model on a 15-second person-period
expansion, `alpha 1e-4`, 8,548 bouts, `trained_through 2026-07-18`; intercepts
ko −8.15201, sub −8.93579. Every covariate is time-constant, so `_normalize_shape`
divides it back out: **the served timing is two fixed curves per scheduled
length, identical for every bout on the card** (pinned at 1.7e-18 by
`test_method_leg.py`). It replaced a shape that produced R1/R2/R3 = 17/35/49%
against an observed 54/31/15%; held-out round-of-finish log-loss **1.0218 vs
1.4585**.

**Decisions** come from a no-intercept logistic model on all ten `FighterMC`
diffs (temperature 0.8, C 10.0, 4,014 decisions). It replaced a hand-weighted
logit scoring test log-loss **4.2238** against a coin flip's 0.6931 — and pricing
**83.4%** of decisions outside [0.05, 0.95] against the fit's 0.0%.

10,000 sims, 1-second ticks, `seed = stable_hash(bout_id)`.
`MIN_METHOD_SAMPLES = 25` before a method uses its own round distribution.
`method_mix` is a pure reshape — each side's win level comes from the simulator's
own counts and is redistributed by the model mix; `method_mix=None` reproduces
pre-v0.12.0 output bit for bit. `METHOD_ANCHOR_LAMBDA = 0.40` is therefore **not
exercised by the predict cron** (both method artifacts are present); it survives
for `custom.py`, artifact-less deploys and `--legacy`. Swept against the fitted
mix, λ selects **0.00** on every seed.

---

## 6. Serving

```
15 5 * * *   predict-refresh.sh     # daily scoring
0  7 * * 0   retrain-refresh.sh     # weekly retrain, auto-commits artifacts to main
```

Per bout, one transaction, three idempotent upserts on `(bout_id, model_version)`:
`bout_simulation` (prob_a/prob_b, predicted winner, confidence, market prob,
edge), `bout_simulation_features` (top-**8** SHAP from the serving LightGBM —
SHAP only makes sense per single tree model, not per blend), and
`bout_simulation_rounds` (six cells, `avg_finish_seconds`, per-round finish
probabilities, `distribution` jsonb).

Confidence bands on `|p − 0.5|`: low 0–0.08, medium 0.08–0.18, high 0.18+.

Pricing (`src/lib/sportsbook.ts`) derives four markets from one reconciled
distribution — winner (margin 0.04), method, total_rounds O/U 2.5 and distance
(0.08) — after an edge guard of ±0.15 against the devigged line, with odds clamped
to [1.02, 25]. Debut bouts are only bettable when a line exists.

---

## 7. How anything gets measured

| basis | what it is | n |
|---|---|---|
| static test | one model frozen at `TRAIN_END` vs 18 months of later fights | 664 / 582 |
| rolling retrain | production semantics, per-origin refit | 417 main / 94 debut |
| walk-forward OOF | 32 quarterly origins, 2017-01 → 2025-01 | 3,087 |
| per-leg pools | method 3,081 (543 subs), debut 798, debut-method 793 | — |

Walk-forward stops at `VAL_END`, so the 2025+ window stays untouched by
construction. Verified against an independent implementation: 0.6481 vs 0.64808.

**The detection floor** (`--stage power`, five seeds on the 3,087-row pool:
0.64892 / 0.64945 / 0.64808 / 0.64791 / 0.64998): sd across seeds 0.00088, paired
SE 0.00116, **one-sided 80% MDE 0.00363 single-seed, 0.00288 at infinite seeds**.
`RESIDUAL_CORRECTION` is worth **−0.0026** — below both. It shipped because three
independent legs agreed on its sign, not because any one reading resolved it.
Corollary: **more seeds cannot rescue an underpowered arm.**

**Calibration.** The conclusion — better calibrated than the closing line — holds;
the statistic that carried it does not. Model−market reliability is sign-stable
across seeds **only at 5 bins**; at 10/20/40 it flips, because ~30 bouts per bin
makes the statistic measure the market's dispersion. Bin-free CORP miscalibration
is sign-stable on all five seeds: **model 0.01014–0.01321 vs market 0.01537**.

**Where the gap sits** (OOF pool, 1,186 bouts with a line, total +0.0306):
market-0.72+ bucket +0.0760 (49% of it), layoff >400d +0.0511 (33%), exactly one
ranked +0.0906 (27%) — while both-ranked is +0.0044 and five-round bouts are
**−0.0057**, i.e. we beat the book there. The elite end is not where we lose.

**Sharper vs wrong in a direction.** Layoff carries a third of the gap with no
bias at all (+0.003 against the book's +0.014) — pure sharpness, untouchable
without new information. Age is the opposite (+0.207), and is the only probe big
enough to correct.

---

## 8. What did not ship

**Winner batch** — eleven levers at zero: both-ordering symmetry (+0.0015),
symmetry incl. val (+0.0002), dropping `is_title_fight` (+0.0004), recency
weighting 8y/4y (+0.0010/+0.0019), regularised LGB (−0.0004), deeper LGB
(−0.0002), 5-seed bagging (−0.0001), removing the age throttle (+0.0005/+0.0001/
+0.0000), raising it to 0.75 (+0.0009/+0.0004/−0.0002). Official rankings failed
twice: as a 16-column block, val +0.002 and test **−0.004 on all five seeds**; as
a 3-column correction, OOF −0.0008 / forward +0.0006 / test **+0.0020**. The
8-column correction block was best on the pool it was fitted on and worst on the
held-out window — the shape of overfitting at eight parameters.

**Accuracy batch** — five of six failed: nationality on `country_code`
(held-out +0.0010), nationality on `sherdog_flag_code` (three legs pass, rolling
**+0.0022** → refused), sub-vs-dec temperature (spends +0.0104 of the decision
cell), the corrector transferred to the debut specialist (+0.00218, z = +0.83),
absolute levels in the debut matrix (+0.00187 / −0.00123 / −0.00187, sign not
stable). The sixth is v0.14.0.

**Method leg** — hierarchical re-shape 0.8969 vs 0.8870 (worse than a flat
softmax); the submission axis at −0.0033/+0.0038/−0.0081; a discriminative
round-of-finish model at 0.0113 nats with a bootstrap of [−0.0060, +0.0280] — the
fitted hazard beats a per-length **constant** by only 0.0035, which is all the
per-bout signal round timing contains.

**Other labs** — tail resolution: 9.6% of the gap is recalibration, 1% is Jensen
compression, **~89% is information we do not have**; booking circumstance started
accruing 2026-07-23 and cannot be backfilled (`bout.created_at` is a scrape
timestamp — 8,695 of 8,784 rows were created *after* their own event). Graded
target: nothing ships; `weighted α=0.5` passed a–e on seed 42 and flipped sign on
7/13. Regional regime: kill test passes, the blend does not (leg weight 0.065,
reliability 0.00296 → 0.00410; propensity AUC between populations 0.9992).

### 8.1 The `is_title_fight` leak

The parser read *any* `<img>` in the weight-class cell as a belt; UFCStats puts
post-fight bonus icons there. Among three-round bouts the flag marks an **84.1%**
finish rate against 41.3% unflagged, and 1,855 three-round "title fights" cannot
be titles. It sits on 26–34% of completed bouts per year against a real rate near
5%, and on 3% of un-fought bouts — a train/serve skew on top of a leak. Worth
0.132 nats on val to the method model, where it was the largest feature.

The GATE-0 label shuffle **passed with the leak present** — shuffling the target
destroys the feature's usefulness along with everything else. What caught it was a
serving-time sanity check: 62% predicted decisions on the upcoming slate against
54% on test.

Parser fixed and pinned; the column is excluded from the method matrix. The 1,855
rows are **not** repaired, `is_title_fight` remains one of the 118 winner features
(rank 114/118, gain 0.0%, removal +0.0004), and it is still a live covariate of
the served `finish_hazard.json`.

### 8.2 The nationality refusal (v0.15.0, shipped then reverted)

The bias is real and does not drift: A-American/B-not, n=485, model 0.4927 vs
actual 0.4124 (**+0.0804**); B-American/A-not, n=551, 0.5165 vs 0.5644
(**−0.0479**); stable across 2017-20 / 2020-23 / 2023-26. The mechanism is roster
composition, not travel or crowd — an event-geography variant is dominated by
plain citizenship.

Attempt 1 on `country_code` failed its third leg on coverage skew: 71.1% of the
fit pool against **41.7%** of the test window, fitted where it was visible and
scored where it was not. The substrate was rebuilt (migration `0094`, scraper step
18, `sherdog_flag_code` filled for 4,136 of 4,171 fighters), coverage went
41.7% → **99.1%**, and all three legs passed: −0.00145 / −0.00201 / −0.00129
incremental over age, reproduced end to end on a retrain (test 0.613663 →
0.612374).

Then the **rolling** basis — production semantics, per-origin refit, identical
origins — came back **+0.0022 against age alone**. Every one of those four
readings is under the 0.0036 floor, so the honest verdict is not "three bases beat
one" but "nothing is resolved", and a sign that flips between bases is condition
(g) applied across bases. A mechanism also explains the rolling sign: the
coefficients are fitted on models trained on *less* data than the rolling ones,
and a correction sized for a weaker model can overshoot a stronger one.

The substrate shipped anyway; the fitted block sits commented in `config.py`.
Also on the record: `country_code` (Wikidata P27, citizenship) and
`sherdog_flag_code` (birthplace) agree only 0.86 of the time, and 9 of 21
disagreements are the Home Nations, where Sherdog ships `en` for England (`EN` is
not ISO; `SC` is — for Seychelles).

---

## 9. Version history

| version | date | change |
|---|---|---|
| v0.1.0–v0.5.0 | 2026-05-30 | LGB baseline → MC simulator → Optuna → ensemble → odds backfill |
| — | 2026-06-25 | no bump: market leak removed (71→69 features), draw ≠ loss, `stable_hash`. Test acc 0.648 → **0.633** |
| v0.6.0 | 2026-07-08 | Elo + durability trio; weight-class specialists dropped |
| v0.7.0 | 2026-07-09 | opponent-adjusted ratings. Test 0.651 / 0.628 / 0.706 |
| v0.8.0 | 2026-07-09 | debut specialist at row weight 0.2 |
| v0.9.0 | 2026-07-10 | 14 `preufc_*` columns. Test 65.1 → 65.6%, LL 0.628 → 0.623 |
| v0.10.0 | 2026-07-10 | Glicko-2, trajectory, CatBoost replaces XGBoost |
| v0.11.0 | 2026-07-23 | fitted hazards + decision model; fixed an inverted round curve live since v0.5.0 |
| v0.12.0 | 2026-08-02 | conditional method model; `is_title_fight` leak found; λ swept to 0.00 |
| v0.13.0 | 2026-08-02 | `ResidualCorrector`. Test LL 0.6131 → **0.6078**, gap 0.0248 → **0.0196** |
| **v0.14.0** | 2026-08-04 | debut method model, **−0.048 nats** |
| v0.15.0 | 2026-08-04 | shipped then **reverted** — the nationality term |

---

## 10. Where the README disagrees with the artifacts

Checked file by file against `artifacts/`. The README is a changelog and has
drifted; these are the claims to distrust until it is rewritten.

| README | committed truth |
|---|---|
| "LightGBM + isotonic calibration" | no calibrator ships; `save()` unlinks stale ones |
| "LGB + **XGB** + LogReg" | CatBoost since v0.10.0 |
| "112 main / 114 specialist columns" | **118 / 120** |
| static 0.6632 acc / 0.6118 LL on 582 | `metadata.json` v0.14.0: **0.6753 / 0.6171** (the README quotes v0.13.0 order-averaged lab readings) |
| rolling 0.6451 / 0.6159 / 0.6103 | no committed artifact yields these; the age arm is **0.6547 / 0.6168 / 0.6115** |
| "rolling 0.6218 → 0.6159" | committed: 0.6238 → 0.6168 (all), 0.6199 → 0.6115 (odds subset) |
| reliability 0.00186, resolution 0.03826 | current `lab_accuracy_batch.json`: **0.00171 / 0.04058** |
| age throttle "+0.0000 on the OOF pool" | +0.00046 / +0.00008 / +0.00001; "+0.0000" is the seed-13 reading only |
| predict "both fighters have ≥1 prior UFC bout" | superseded since v0.8.0 — debuts are scored whenever the specialist exists |
| cron "03:30", "`run_train.py` stays manual" | predict at **05:15**; retrain is a Sunday cron that **auto-commits and pushes to main** |
| `git add artifacts/model.lgb artifacts/calibrator.pkl` | `model.lgb` is dead (pre-ensemble, 2026-05-30); `calibrator.pkl` is never written |

Numbers that do check out exactly: the "82% of 0.106 nats" decomposition, the
v0.12.0 method table, −0.2939, "0.048 nats on 793 bouts", "1.0524 vs 1.0091", the
three nationality legs, "+0.0022", the pool sizes (543 submissions / 71 val;
798 bouts / 84 val), the MDE floor, "118-feature", "rank 114 of 118".

---

## 11. Open debts

1. **Branch vs production diverge.** `origin/main` carries `MODEL_VERSION
   v0.13.0` with artifacts retrained 2026-08-09 (`n_test 673`, data through
   2026-08-08), because the weekly cron retrains and commits **without bumping the
   version**. Merging the accuracy batch collides on binary artifacts, and main's
   are six days fresher in data.
2. **`finish_hazard.json` / `decision_winner.json` are frozen.** They are fitted by
   `lab_fit_hazard.py` / `lab_fit_decision.py`, which neither `run_train.py` nor
   the cron invokes: `trained_through 2026-07-18` against the ensemble's
   2026-08-01. The MC timing and the decision model silently drift with every
   auto-retrain.
3. **CatBoost is fragile to data drift.** Two days of incremental scraping (89
   updated bouts, 3 new, 48 new Sherdog rows) moved LightGBM by 4.5e-6, LogReg by
   6.6e-5 and CatBoost by **4.5e-3**. The thread-nondeterminism hypothesis was
   tested and refuted (an idle machine reproduces to seven decimals).
4. **`metadata.json` records no provenance** — no library versions, git SHA,
   dataset hash, or winner-leg iteration counts, which is exactly why (3) is
   undiagnosable from the artifact alone. `requirements.txt` is lower bounds only.
5. **No CI.** Five test files, hand-run, no pytest dependency.
6. **`bout_simulation` is never pruned** — one row per bout per model version,
   forever. Only `bout_simulation_features` does a DELETE-then-upsert.
7. `use_sub_axis: true` is recorded in all four method metas although the matrices
   were built with the flag off (the dataclass default is written, not the module
   constant). Harmless at serve — the extra columns are discarded by
   `X[model.feature_columns]` — but the flag lies.
8. UI strings still say "isotonic calibration" and "LightGBM + XGBoost".
