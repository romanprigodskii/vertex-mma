# Tail resolution lab — closing the gap to the closing line

Branch `lab/tail-resolution`. Winner model only; the MC path (`monte_carlo.py`,
`finish_hazard.py`, `decision_model.py`) is untouched — it builds its own winner
probability from fighter snapshots and never reads the ensemble's.

**Result: nothing ships.** All three levers were measured; lever 1 produces a
real but small effect that fails its gate, lever 2's two hypotheses are refuted,
and lever 3a has no data to stand on. `MODEL_VERSION` stays v0.11.0 and
`calibrator` stays `None`.

---

## 0. Baseline (reproduced, not re-derived)

`scripts/eval_tail_buckets.py` reproduces every number in the brief exactly, on
the served basis (symmetrized frame, order-averaged, split-trained
`ensemble_eval`, test = 2025-01-01+, 568 of 650 bouts with a closing line):

|              | acc    | log-loss | AUC    | sd     | max p |
| ------------ | ------ | -------- | ------ | ------ | ----- |
| model        | 0.6690 | 0.6198   | 0.7220 | 0.1549 | 0.868 |
| market       | 0.6778 | 0.5968   | 0.7436 | 0.1966 | 0.909 |
| **gap**      |        | **+0.0229** |     |        |       |

Murphy decomposition (10 equal-width bins, odds subset):

|        | reliability | resolution | uncertainty | brier  |
| ------ | ----------- | ---------- | ----------- | ------ |
| model  | 0.00296     | 0.03812    | 0.2495      | 0.2149 |
| market | 0.00303     | 0.04580    | 0.2495      | 0.2057 |

Calibration is not the problem — ours is fractionally better than the book's.
The entire deficit is resolution, and it is one bucket:

| market conf | n   | model  | market | gap     |
| ----------- | --- | ------ | ------ | ------- |
| 0.50-0.55   | 83  | 0.6688 | 0.6873 | −0.0185 |
| 0.55-0.62   | 121 | 0.6853 | 0.6759 | +0.0093 |
| 0.62-0.72   | 184 | 0.6569 | 0.6582 | −0.0013 |
| **0.72+**   | 180 | 0.5152 | 0.4392 | **+0.0759** |
| weighted    | 568 |        |        | +0.0229 |

Everything below is gated on this table, never on the weighted number.

---

## 1. Lever 1 — tail-aware recalibration → **GATE 1 FAILED (condition c)**

`src/ensemble.py::ProbabilityCalibrator` (five monotone families) is wired into
`predict_proba_a`, so it applies per fighter ordering, inside the order
averaging that `predict.py` and `custom.py` wrap around it. Both serving paths
and the debut specialist go through that one call — verified. Persisted as JSON
rather than a pickle. The slot is left empty.

### The 429-row val split cannot afford two parameters

`scripts/lab_tail_calibration.py`, fit on val against the served quantity
(`logloss(y, ½·[g(p) + 1 − g(p_swapped))]`):

| family     | val ll | test ll | test acc | 0.50-0.55 | 0.72+  | bootstrap beats baseline |
| ---------- | ------ | ------- | -------- | --------- | ------ | ------------------------ |
| identity   | 0.6203 | 0.6198  | 0.6690   | 0.6688    | 0.5152 | —                        |
| temperature| 0.6171 | 0.6165  | 0.6690   | 0.6701    | 0.4954 | 89.6%                    |
| cubic      | 0.6170 | 0.6173  | 0.6690   | 0.6703    | 0.4972 | 55.0%                    |
| beta       | 0.6164 | 0.6181  | 0.6690   | 0.6665    | 0.5006 | —                        |
| beta_c0    | 0.6166 | 0.6171  | 0.6690   | 0.6656    | 0.4987 | 61.6%                    |
| **piecewise (val winner)** | **0.6163** | **0.6193** | 0.6690 | 0.6724 | 0.5030 | **36.5%** |

Val's argmin is the 3-parameter piecewise family, and piecewise is the worst
candidate on test. Bootstrapping val (500 resamples, refit, re-score the same
test set) shows why: 1 parameter is stable, 2 parameters are a coin flip, 3 are
worse than doing nothing. This is the isotonic failure from `ensemble.py:24-29`
recurring at three parameters instead of unbounded — the brief's assumed
two-parameter budget is not actually affordable here.

### Give it 3,087 honest rows instead

`scripts/lab_oof_calibration.py` fits on walk-forward out-of-fold predictions:
32 quarterly origins over 2017-2024, each training on bouts before origin−12mo,
validating on the 12-month tail and scoring the next quarter — production's own
rolling recipe, all strictly before the test boundary.

**A. OOF-internal (test never touched).** Fit on 1,850 rows before 2022,
evaluate on the 1,237 after: every family lands on the same map and buys
−0.0007 log-loss. Holdout buckets, best candidate vs identity: 0.72+ improves
0.5222 → 0.5166, 0.55-0.62 degrades 0.7030 → 0.7049. Same shape as below, a
tenth the size the val fit advertised.

**B. Fit on all 3,087 OOF rows, apply to test.** All five families converge
(T≈0.89; cubic a=1.105 b=0.022; piecewise s_in 1.04 / s_out 1.19):

| bucket    | n   | identity | OOF-fit temperature | market |
| --------- | --- | -------- | ------------------- | ------ |
| 0.50-0.55 | 83  | 0.6688   | 0.6689              | 0.6873 |
| 0.55-0.62 | 121 | 0.6853   | 0.6885              | 0.6759 |
| 0.62-0.72 | 184 | 0.6569   | 0.6576              | 0.6582 |
| 0.72+     | 180 | 0.5152   | 0.5052              | 0.4392 |
| overall   | 568 | 0.6198   | **0.6175**          | 0.5968 |

Murphy after: reliability 0.00452, resolution 0.03994 (from 0.00296 / 0.03812).
The transform buys resolution by spending reliability — which is what a
sharpening transform does, and why it runs out.

**C. Stability.** Bootstrapped over OOF (150 resamples, the OOF-winning `beta`
family), the fit beats the uncalibrated model in **90.7%** of resamples (median
test ll 0.6178, p05-p95 0.6163-0.6201) — the opposite of the val fit's 36.5%.
The effect is real. It is just small.

### Gate readout

| condition | requirement | measured | verdict |
| --------- | ----------- | -------- | ------- |
| a | fit-set log-loss improves | 0.6481 → 0.6476 (OOF); 0.6203 → 0.6171 (val) | **pass** |
| b | 0.50-0.55 bucket not degraded | 0.6688 → 0.6689 (OOF fit) | **pass** |
| c | 0.72+ clearly beats the 0.4850 mechanical ceiling | **0.5052** — does not reach it | **FAIL** |
| d | accuracy not down | 0.6690 → 0.6690 | **pass** |

The mechanical ceiling is an oracle: it sharpens only the bouts the market has
already labelled heavy-favourite. A transform keyed on our own probability
cannot reproduce that, because our confidence and the market's bucket are not
the same set — sharpening the tail necessarily sharpens the coin-flips we are
already winning. **0.0022 of 0.0229 closed (9.6%). Not shipped.**

Note the val-fit temperature (T=0.777) scores better on test (0.6165) than the
OOF-fit one (0.6175). That is luck, not a better estimate: it also degrades the
0.50-0.55 bucket (0.6688 → 0.6701), failing condition b on top of c. The two
fits do agree on direction, and the drift T=0.948 (early OOF) → 0.889 (all OOF)
→ 0.815 (2022+ OOF) → 0.777 (val, 2024) is monotone, which is consistent with
the model needing slightly more sharpening as it gets more data.

---

## 2. Lever 2 — compression at the source → **GATE 2 FAILED (both)**

`scripts/lab_blend_age.py`. Two bases, because n=568 cannot resolve a 0.002
effect: the static test split, and 32-origin quarterly walk-forward pooling
3,087 out-of-sample bouts (1,186 with odds). Seeds 42/7/13, LightGBM **and**
CatBoost seeds both swept.

### 2a. The blender is not the compressor

Five modes from one fit per config — the three shipped ones plus averaging the
learners in **logit** space, which is the same weights minus the Jensen pull
toward 0.5 that `ensemble.py`'s docstring flags as the under-dispersion source.
(Distinct from the brief's §1 rejection, which was averaging over fighter
*order* in logit space.)

| mode (static, seed 42) | ll | acc | sd | 0.50-0.55 | 0.72+ |
| ---------------------- | ------ | ------ | ------ | ------ | ------ |
| logreg blender         | 0.6598 | 0.6637 | 0.0486 | 0.6808 | 0.6185 |
| mean                   | 0.6199 | 0.6585 | 0.1394 | 0.6702 | 0.5129 |
| **weighted_mean (shipped)** | **0.6198** | 0.6690 | 0.1549 | 0.6688 | 0.5152 |
| logit_mean             | 0.6194 | 0.6585 | 0.1411 | 0.6701 | 0.5114 |
| weighted_logit_mean    | 0.6197 | 0.6690 | 0.1561 | 0.6688 | 0.5144 |

Removing the Jensen compression *entirely* is worth 0.0001-0.0002 (pooled:
0.6502 → 0.6500, tail 0.5444 → 0.5431). The sign is stable across three seeds
and both bases — and it is ~1% of the gap. The brief's premise for
re-selection also does not hold: there is no near-tie on val to break with a
secondary criterion (weighted_mean 0.6203, logit variant 0.6200, mean 0.6279,
logreg blender 0.6616).

The per-learner rows explain it. The legs *are* more dispersed than the blend
and each beats it in the tail on one basis — but never the same leg on both:

| leg | static tail | pooled tail | static sd | pooled sd | overall Δ vs blend |
| --- | ----------- | ----------- | --------- | --------- | ------------------ |
| solo lgb    | 0.5037 | 0.5679 | 0.1441 | 0.1076 | +0.0003 / +0.0082 |
| solo cb     | 0.5277 | 0.5533 | 0.1257 | 0.1217 | +0.0092 / +0.0040 |
| solo logreg | 0.5172 | 0.5220 | 0.1641 | 0.1685 | +0.0016 / +0.0042 |
| blend       | 0.5152 | 0.5444 | 0.1549 | 0.1260 | — |

Every leg pays for its tail sharpness in the 0.50-0.55 bucket and overall. The
blend is not hiding recoverable tail resolution; it is trading sharpness for
coin-flip accuracy and winning that trade. **Refuted.**

### 2b. The age throttle is load-bearing, not cosmetic

`FEATURE_CONTRI_OVERRIDES` is a LightGBM-only parameter and LightGBM carries 8%
of the blend, so the prior was "this moves the SHAP display, not the
probability". Measured, it is worse than neutral:

| config (weighted_mean) | seed 42 | seed 7 | seed 13 | pooled |
| ---------------------- | ------- | ------ | ------- | ------ |
| overall ll — current   | 0.6198  | 0.6195 | 0.6197  | 0.6502 |
| overall ll — age_off   | 0.6218  | 0.6197 | 0.6188  | 0.6516 |
| 0.72+ — current        | 0.5152  | 0.5145 | 0.5140  | 0.5444 |
| 0.72+ — age_off        | 0.5220  | 0.5158 | 0.5131  | 0.5484 |

The sign on overall log-loss flips with the seed (+0.0020 / −0.0000 / −0.0010),
which fails GATE 2's stability condition by itself, and the larger basis says
the tail gets *worse*. Mechanism: the throttle regularizes the LGB leg. Its
tail log-loss across seeds is 0.5037 / 0.5272 / 0.5157 with the throttle and
0.6420 / 0.5480 / 0.5082 without — removing it lets LightGBM over-commit to age
and early-stop erratically (leg sd collapses to 0.035 on seed 42, and to 0.026
at the intermediate 0.7/0.75 setting).

**Refuted, and there is no trade-off to escalate.** The override stays; the SHAP
attribution aesthetics it was set for are free.

---

## 3. Lever 3a — is there a short-notice signal in the DB? **No.**

Not undertaken as modelling work (levers 1 and 2 did not pass), but the data
question was answered so it does not have to be asked again.

**`bout.created_at` is a scrape timestamp, not an announcement date.**
- 8,736 of 8,784 completed bouts were created on 2026-05-12 (the bulk backfill).
- 8,695 of 8,784 were created **after** their own event date.
- The 89 with a pre-event `created_at` span 2026-05-16 → 2026-07-18 only, and
  their lead-day histogram clusters on cron cadence (11 bouts at 4 days, 10 at
  18, 11 at 25, 9 at 55) — it measures when the scraper ran, not when the fight
  was booked.

**The news pipeline is too young.** 1,472 items, 2026-05-13 → 2026-07-23. 550
carry a `related_bout_id`; only **88 distinct completed bouts** have any linked
news at all, and 171 items were published before their bout's event. Zero
overlap with the 2025+ evaluation window in any usable density.

**3b weight misses / 3c injury withdrawals** have no substrate either: UFCStats
does not publish weigh-in results, and the withdrawal record is 10 rows — the
entire `status='cancelled'` population (vs 8,784 completed). Bouts that never
happened are never scraped, so this cannot be backfilled.

This signal can only be accrued forward, at scrape-cadence granularity
(~45 bouts/month with a real first-seen date). Reaching the ~1,000 graded bouts
a tail-bucket feature would need is a multi-year wait, and no retroactive source
can shorten it. Anyone picking this up should decide whether to start recording
first-seen dates deliberately rather than inferring them from `created_at`.

---

## 4. Rejected, with reasons

Keeping the list, because it is the expensive part.

| # | Idea | Why rejected |
| - | ---- | ------------ |
| 1 | Isotonic post-blender calibration | Pre-existing (`ensemble.py:24-29`): 430 val rows, test ll 0.65 → 0.72. Not retried. |
| 2 | Order-averaging in logit space | Pre-existing: +0.0001. Compression is inside the model, not at the output. |
| 3 | Global temperature fit on val | The brief's baseline, reproduced (T=0.777, 0.6198 → 0.6165). Degrades the 0.50-0.55 bucket (0.6688 → 0.6701) — fails gate b — and sharpens everything indiscriminately. |
| 4 | 2-3 parameter transforms fit on val | Val picks the worst one. Bootstrap: 55-62% (2 params), 36.5% (3 params). Not affordable at n=429. |
| 5 | Same transforms fit on 3,087 OOF rows | Robust (90.7%) and real, but +0.0022 — never approaches the 0.4850 tail ceiling. Fails gate c. |
| 6 | Beta calibration with a≠b | Asymmetric on a symmetrized frame, so any a≠b is noise-fitting by construction. Fits confirm it (a=0.83 b=1.64 on OOF, a=1.04 b=3.22 on val — no stable value). |
| 7 | Blend re-selection with tail log-loss as tiebreak | No tie to break; and the best possible re-selection (logit-space averaging) is worth 0.0002. |
| 8 | Dropping the age contribution override | Tail degrades on the larger basis; sign flips across seeds; the override is regularizing LightGBM. |
| 9 | Serving a single leg instead of the blend | Sharper tails, but no leg wins the tail on both bases, and all of them lose the 0.50-0.55 bucket and overall. |

---

## 5. Scoreboard

Of the **0.0229** log-loss gap to the closing line:

- **0.0022 (9.6%)** is reachable by monotone recalibration fit on out-of-fold
  data — real, robust, and below the gate.
- **0.0002 (1%)** is Jensen compression in the blend — real, stable in sign,
  negligible.
- The remaining **~0.0205 (89%)** is information. The tail bucket is the whole
  of it: we agree with the market on the favourite in 92% of the 180 bouts where
  it is ≥0.72 confident, and we are right 81.7% of the time to its 83.9% — we
  are not wrong about who wins, we do not know *how much* more likely it is.
  No transform and no reweighting of what we already compute will supply that.

Two footnotes that are not edge, and should not be sold as edge:

- The market is itself under-confident in that bucket (79.1% stated vs 83.9%
  actual, 1.7 SE at n=180 — not established). Matching the empirical rate would
  beat it there, but the 4.53% overround eats it. That is a pricing improvement.
- Accuracy is not the metric and was never the gap: 0.6690 vs 0.6778 measured
  here (0.6796 in the brief — the difference is rounding on tied lines) is under
  half a paired SE, McNemar exact p = 0.72. Every candidate in this lab left
  accuracy at exactly 0.6690.

## 6. Reproducing

```
cd scripts/simulation
./venv/bin/python scripts/eval_tail_buckets.py                     # baseline table (17s)
./venv/bin/python scripts/lab_tail_calibration.py --bootstrap 500 \
    --bootstrap-families temperature,cubic,beta_c0                 # lever 1, val fit
./venv/bin/python scripts/lab_oof_calibration.py --rebuild-oof     # lever 1, OOF fit (~2min)
./venv/bin/python scripts/lab_blend_age.py --seeds 42,7,13         # lever 2 (~2min)
```

`--cache` on any of them reuses `data/dataset.parquet` instead of rebuilding
from the DB; the cached and live builds were verified identical. Results land in
`artifacts/lab_tail_calibration.json`, `artifacts/lab_oof_calibration.json`,
`artifacts/lab_blend_age.json`.

Untouched by this lab: `CLIP_ANCHOR_DATE`, `stable_hash`,
`symmetrize_for_training`, `ROUND_STATS_SQL`, the whole MC path, and
`MODEL_VERSION`. `run_train.py` was run end-to-end to confirm the Sunday retrain
cron is unaffected — identical metrics, only the `trained_at` stamp moved, and
the artifacts were restored.
