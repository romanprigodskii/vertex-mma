# Winner-leg batch — the recipe, not the information

Branch `lab/rank-signal` (it began as the rankings lab and outgrew the name).
Winner model only; `monte_carlo.py`, `finish_hazard.py` and `decision_model.py`
are untouched. The method book moves anyway, because the 6-cell factorises as
winner + conditional and the winner term is shared.

**Headline: the winner leg moves, for the first time in nine labs.** One
coefficient, applied after the blend: −0.2939 logits per ten years of age
advantage. Held-out test log-loss **0.6131 → 0.6078**, the gap to the closing
line **0.0248 → 0.0196**, rolling retrain **0.6218 → 0.6159** on identical
origins. Everything else tested here — eleven levers, including every one that
sounded more promising than this — closed at zero.

The lever is not information. `ranking_snapshot`, the one genuinely new
information source left in the database, failed its gate twice (§7). What
moved the number was noticing that a segment where we lose to the book is not
merely a segment where the book is *sharper*, and that the two have different
fixes.

Shipped as v0.13.0: `ResidualCorrector` in `src/ensemble.py`,
`RESIDUAL_CORRECTION` in `src/config.py`, attached by `train.py`, applied
inside `predict_proba_a` and therefore inside the order averaging.

---

## 1. The instrument came first, and it had to

Every lab before this one selected on the 429-row val split. That instrument
has a documented failure: in `tail_resolution.md` it *picked* the 3-parameter
piecewise calibrator, which turned out to be the worst of the five families on
test. A lever worth 0.003 nats is not measurable on 429 rows at all — the
standard error of a log-loss difference there is larger than the effect.

So selection moved to walk-forward out-of-fold, the same construction
`lab_oof_calibration` used, generalised into `scripts/lab_winner_common.py`:

```
per quarterly origin, 2017-01 .. 2025-01
  train   event_date <  origin − 12mo
  val     [origin − 12mo, origin)     early stop + blender + blend mode
  score   [origin, origin + 3mo)      never seen, never fit
```

3,087 scored bouts, refit 30 times, and it stops at `VAL_END` — so the 2025+
test window stays untouched by construction and can still be read once, at the
end, as a held-out number.

Verified against the independent implementation before being trusted: this
harness reports baseline OOF log-loss **0.6481**; `lab_oof_calibration`'s own
pool reports **0.64808** for the same period.

---

## 2. Eleven levers that closed at zero

All on the OOF pool, seed 42, paired bootstrap by bout against the same-seed
baseline. Negative = better.

| lever | Δ OOF | 95 % CI | improves |
|---|---|---|---|
| symmetry: train on both orderings | +0.0015 | [−0.0012, +0.0042] | 14 % |
| symmetry: both orderings, train + val | +0.0002 | [−0.0022, +0.0027] | 42 % |
| drop the leaked `is_title_fight` | +0.0004 | [−0.0018, +0.0026] | 37 % |
| both of the above together | +0.0009 | [−0.0017, +0.0035] | 25 % |
| recency weighting, 8y half-life | +0.0010 | [−0.0013, +0.0033] | 19 % |
| recency weighting, 4y half-life | +0.0019 | [−0.0009, +0.0046] | 8 % |
| LightGBM, regularised | −0.0004 | [−0.0015, +0.0006] | 80 % |
| LightGBM, deeper | −0.0002 | [−0.0015, +0.0012] | 60 % |
| seed bagging, 5 seeds | −0.0001 | [−0.0015, +0.0014] | 53 % |
| age throttle removed (`feature_contri` = {}) | +0.0005 / +0.0001 / +0.0000 | — | 3 seeds |
| age throttle raised to 0.75 | +0.0009 / +0.0004 / −0.0002 | — | 3 seeds |

Three of these deserve a note, because the reasoning that motivated them was
sound and the result still came back empty.

**Symmetry.** `predict.py` averages both fighter orderings because the model is
not antisymmetric — scoring the raw scrape order costs ~2.1 pp of accuracy.
Training on both orderings states that symmetry instead of leaving it to be
learned, and it should be free. It is not free: +0.0015. Duplicating every row
halves the diversity of the bagging without adding a bout, and the averaging at
serve time was already collecting the benefit.

**Seed bagging.** Five seeds land between 0.6479 and 0.6500; their average
lands at 0.6480. That is a real −0.0009 against the EXPECTED single seed and
−0.0001 against the seed production happens to ship, which is not worth ×5
artifacts in a repository that commits them on every weekly retrain.

**The age throttle.** `FEATURE_CONTRI_OVERRIDES` caps how much gain LightGBM
may claim from `diff_age`, added for explainability after a Phase 2 audit found
age topping the SHAP list on nearly every upcoming bout. Removing it entirely
changes nothing (+0.0000 on the best of three seeds). Keep it — and remember
this number, because §6 is about exactly the bias this throttle looks
responsible for and is not.

---

## 3. The blend rule looks broken and is not

The served `weighted_mean` weights come from `softmax(−val_logloss / std)`
where the std is taken over THREE numbers. That makes the softmax temperature
depend on how close the three learners happened to land, and on the current
model it produces **0.07 / 0.17 / 0.76** — three quarters of the blend on the
LogisticRegression leg, decided by 429 rows. It reads like a bug.

Every fixed replacement is worse:

| blend rule | Δ OOF | improves |
|---|---|---|
| plain mean | +0.0006 | 25 % |
| fixed 0.2 / 0.5 / 0.3 | +0.0003 | 36 % |
| GBTs only (0.5 / 0.5 / 0) | +0.0057 | 0 % |
| the LogReg blender (`logreg` mode) | +0.0268 | 0 % |

The adaptive rule wins because it is adaptive: each origin re-picks, and the
learner that deserves the weight in that era gets it. The scale-free softmax is
doing "trust whoever is winning right now, smoothly", and on this problem that
beats every constant. Left alone.

---

## 4. Where the gap sits — measured on 1,186 bouts, not 664

Every previous slice of this deficit was cut on the test split, where a segment
with 80 bouts has a standard error near ±0.05 nats and any story fits. On the
OOF pool (1,186 bouts carrying a closing line over eight years):

| segment | n | model | market | gap | share of total gap |
|---|---|---|---|---|---|
| ALL | 1186 | 0.6496 | 0.6190 | +0.0306 | 100 % |
| both ranked | 335 | 0.6218 | 0.6174 | **+0.0044** | 4 % |
| exactly one ranked | 110 | 0.6625 | 0.5719 | **+0.0906** | 27 % |
| neither ranked | 741 | 0.6603 | 0.6267 | +0.0336 | 69 % |
| 5-round | 147 | 0.6403 | 0.6459 | **−0.0057** | −2 % |
| 3-round | 1039 | 0.6510 | 0.6152 | +0.0358 | 102 % |
| women | 219 | 0.6373 | 0.6094 | +0.0280 | 17 % |
| LHW + HW | 186 | 0.6576 | 0.6162 | +0.0414 | 21 % |
| layoff > 400d | 236 | 0.6574 | 0.6064 | +0.0511 | 33 % |
| market conf < 0.60 | 425 | 0.6916 | 0.6833 | +0.0083 | 10 % |
| market conf 0.60–0.72 | 527 | 0.6651 | 0.6366 | +0.0285 | 41 % |
| market conf 0.72+ | 234 | 0.5387 | 0.4627 | **+0.0760** | 49 % |

Two of these corrected an earlier belief. We are at **parity on ranked-vs-ranked
bouts** (+0.0044) and we **beat the book in five-round fights** (−0.0057) — the
elite end is not where we lose. A read of the same slice on the 1,093-row
val+test pool had said the opposite; it was noise, and the bigger instrument is
why it did not become a lab.

---

## 5. From "sharper" to "wrong in a direction"

A log-loss gap on a slice says the book is sharper there. It does not say we
are wrong in a fixable direction, and only the second one is actionable without
new data. So: inside each slice, orient every row so the side the slice is
*about* sits in slot A, then compare what we say, what the book says, and what
happened.

| probe | n | model p | market p | actual | model − actual | market − actual |
|---|---|---|---|---|---|---|
| layoff >400d vs <200d | 133 | 0.462 | 0.472 | 0.459 | **+0.003** | +0.014 |
| layoff >600d vs <200d | 41 | 0.457 | 0.468 | 0.439 | +0.018 | +0.029 |
| ranked vs unranked | 110 | 0.506 | 0.552 | 0.618 | **−0.112** | −0.067 |
| champion vs non-champ | 47 | 0.608 | 0.596 | 0.617 | −0.009 | −0.021 |
| 10+ bouts vs ≤2 | 60 | 0.456 | 0.456 | 0.417 | +0.040 | +0.039 |
| **35+ yrs vs ≤28** | **61** | **0.371** | **0.343** | **0.164** | **+0.207** | +0.179 |

The layoff segment carries a third of the total gap and has **no bias at all**
— we are off by +0.003 where the book is off by +0.014. That is a pure
sharpness deficit inside a segment where the book knows about the injury and we
do not, and nothing in this lab can touch it. Worth writing down, because
"biggest gap" and "most fixable gap" turned out to be different segments.

The age probe is the opposite. A 35-year-old facing someone 28 or younger wins
16 % of the time; we say 37 %. The book is barely better (34 %), which is why
this survived nine labs unnoticed — it is not a place where we lose badly to the
market, it is a place where we are BOTH wrong and we are wronger.

---

## 6. GATE — the correction

One coefficient, on `(age_a − age_b) / 10`, added to the blended logit. Three
independent conditions, each of which has killed a lever in this directory
before:

| block / mode | k | Δ OOF cross-fit | improves | Δ forward (fit pre-2022) | improves | Δ test | improves |
|---|---|---|---|---|---|---|---|
| **age, pure** | **1** | **−0.0026** | **97 %** | **−0.0029** | **94 %** | **−0.0054** | **97 %** |
| age, + intercept | 1 | −0.0026 | 97 % | −0.0019 | 81 % | −0.0053 | 97 % |
| age, + free slope | 1 | −0.0025 | 97 % | −0.0014 | 76 % | −0.0052 | 97 % |
| age + old-flag | 2 | −0.0023 | 95 % | −0.0019 | 80 % | −0.0047 | 95 % |
| age + mean-age | 2 | −0.0021 | 94 % | −0.0018 | 80 % | −0.0053 | 97 % |
| rank | 3 | −0.0008 | 80 % | +0.0006 | 36 % | +0.0020 | 16 % |
| rank + age | 5 | −0.0037 | 98 % | −0.0020 | 75 % | −0.0039 | 86 % |
| rank + age + layoff/exp | 8 | −0.0035 | 96 % | −0.0025 | 79 % | −0.0012 | 62 % |

Read the last two rows before the first one. The 8-column block is the BEST on
the pool it was cross-fitted on and the worst on the held-out window — the
shape of overfitting, at eight parameters, visible only because there were
three conditions instead of one. The 1-column block is the only one that is
best everywhere.

Re-fitted on the OOF pools of seeds 7 and 13, the shipped variant lands at
−0.0025 / −0.0025 on cross-fit, −0.0020 / −0.0020 forward, −0.0047 / −0.0046 on
test. Seed-independent to the fourth decimal.

Reported against it, because it is real: the test gain is not uniform in time.
Split the 19-month test window in half and it is −0.0007 on the first half and
−0.0100 on the second. Every basis agrees on the sign; the honest expectation
is the OOF number (−0.0026), not the test number.

### Why after the blend, and not inside it

This is the part that made it shippable rather than a curiosity. If the model
under-uses age, the obvious fix is to let it use more — and §2 shows that
removing the throttle entirely does nothing (+0.0000). The signal is not
missing from the feature matrix. It is diluted: `diff_age` competes with 117
partly collinear columns, three learners disagree about how to spend it, and
the blend averages that disagreement toward zero. A single coefficient applied
after all of that is not competing with anything.

Which also bounds the claim. This is a correction to an aggregation artefact,
not a discovery about MMA. Its coefficient is a property of the current recipe
and must be refit when the recipe changes; `config.RESIDUAL_CORRECTION` says
so, and the two commands to do it are in the same comment.

---

## 7. The rankings, twice

`ranking_snapshot` is 47,019 rows of the official UFC rankings as published —
279 fortnightly snapshots since 2017-01-06, rank 0 = champion, 532 fighters —
and no model had ever read them. Not record-shaped, a panel's judgement rather
than a fight statistic, and concentrated exactly where §4 says a quarter of the
gap lives. It was the best remaining idea in the database.

It fails on both instruments. As a 16-column feature block (`lab_rank_signal.py`
stage 1) it improves val by 0.002 and degrades test by 0.004 on all five seeds
— buying the 2024 window by spending the 2025 one. As a 3-column correction
block here it is −0.0008 on the pool it is fitted on, +0.0006 forward and
+0.0020 on test. A minimal 3-column feature version is a wash in both
directions.

The bias probe explains the shape of the failure: we ARE wrong about
ranked-vs-unranked (−0.112), but so is the book (−0.067), and the residual we
could correct is small, rare (110 of 1,186 bouts) and does not generalise
forward. The export and its point-in-time test stay in the tree on the same
reasoning that kept `regional_export.py` after its lab failed: building the
data is the expensive part, and the contract it pins — a rank is read from the
snapshot published strictly BEFORE the bout, and falling out reads as unranked
rather than as a stale number — is the part a future lab must not get wrong.

---

## 8. What shipped, and what it is worth

| | before (v0.12.0) | after (v0.13.0) |
|---|---|---|
| test log-loss, all bouts | 0.6131 | **0.6078** |
| test log-loss, odds subset | 0.6170 | **0.6118** |
| test accuracy | 0.6777 | 0.6732 |
| test AUC | 0.7332 | **0.7360** |
| gap to the closing line | +0.0248 | **+0.0196** |
| reliability (lower better) | 0.00354 | **0.00186** |
| resolution (higher better) | 0.04081 | 0.03826 |
| market-0.72+ bucket gap | +0.0770 | **+0.0616** |
| rolling 2025-07..2026-07, odds subset | 0.6183 | **0.6103** |
| 6-cell method book, edge-guarded | 1.5273 | **1.5231** |
| method ROI at EV>0 | −18.8 % | −15.9 % |

The rolling row is a paired run — same origins, same data, corrector on and off
(`--uncorrected`) — because comparing against the committed report from July
would have mixed in three weeks of new bouts and a recipe change.

**The gain is reliability, not resolution.** We are now better calibrated than
the closing line (0.00186 vs its 0.00301) and still less sharp (0.0383 vs
0.0480). That is exactly what correcting a directional bias should do, and it
leaves the diagnosis from `tail_resolution.md` intact: the remaining deficit is
resolution, and resolution needs information — booking circumstance, which
`bout_change_event` began accruing on 2026-07-23 and which cannot be
backfilled.

Accuracy drops 0.45 pp. Three picks out of 664 flip, all of them near 0.5, and
this is what optimising log-loss rather than accuracy costs. Stated rather than
buried, because the README quotes both.

---

## Rejected, and why

| thing | verdict | reason |
|---|---|---|
| Training on both fighter orderings | rejected | +0.0015 OOF. The order averaging at serve time already collects it; duplicating rows only halves bagging diversity |
| Seed bagging | rejected | −0.0001 against the shipped seed. Not worth ×5 committed artifacts on a weekly retrain |
| Recency weighting | rejected | +0.0010 (8y) and +0.0019 (4y). The sport's drift is already in the features |
| Dropping `is_title_fight` | not done here | +0.0004, a wash. It IS a leaked bonus flag (`method_leg.md` §7) and ranks 114/118; removing it is a correctness change with no measurable effect, and belongs with the row repair rather than in a log-loss lab |
| Any fixed blend rule | rejected | The val-picked softmax beats plain averaging (+0.0006), fixed weights (+0.0003) and the LogReg blender (+0.0268) |
| Raising the age throttle | rejected | +0.0000. The fix is after the blend, not inside it — which is the diagnostic that made §6 shippable |
| The rank block, as features | GATE FAIL | val −0.002 / test +0.004 on five seeds. §7 |
| The rank block, as a correction | GATE FAIL | forward +0.0006, test +0.0020. §7 |
| The 8-column correction block | rejected | Best on the fitting pool, worst on test. Three conditions exist to catch exactly this |
| A free slope on the model logit | rejected | Worse forward (−0.0014 vs −0.0029). It would import the OOF models' sharpness into production, where the served model is trained on more data |
| Applying the correction to the debut specialist | not done | Fitted and gated on the both-experienced population only. An accidental run that did apply it moved the debut segment 0.6534 → 0.6380 on 94 bouts — suggestive, ungated, and left as the open question below |
| Claiming we beat the closing line | refused | +0.0196 nats behind on the winner leg, +0.0265 on the method book |

## What is NOT changed

* The feature matrix — same 118 columns, same `FEATURE_CONTRI_OVERRIDES`.
* The three learners, their hyperparameters and the blend rule.
* `monte_carlo.py`, `finish_hazard.py`, `decision_model.py`, `method_model.py`.
* The debut specialist (`corrector` stays None there).
* `EnsembleModel.calibrator`, which is still empty and still for the reason
  `tail_resolution.md` gives.

## Open

The debut segment. The correction was never gated there, and the one
uncontrolled observation points the same way. Gating it properly needs a
walk-forward OOF pool for the specialist — the same construction as
`walk_forward` but training on all rows with both-experienced rows
down-weighted and scoring debut rows only. That is the next cheap thing anyone
picks up here.

## Reproducing

```bash
cd scripts/simulation && source venv/bin/activate

python scripts/lab_winner_batch.py --stage oof --arms baseline --seeds 42,7,13   # the pool (~2 min/arm)
python scripts/lab_winner_batch.py --stage oof --cache                            # every lever
python scripts/lab_winner_batch.py --stage diag --cache                           # §4
python scripts/lab_winner_batch.py --stage bias --cache                           # §5
python scripts/lab_winner_batch.py --stage correct --cache                        # §6, strips the shipped corrector first
python scripts/lab_rank_signal.py --stage 0 --cache                               # §7 kill test
python scripts/lab_rank_signal.py --stage 1 --cache --seeds 42,7,13,2024,99       # §7 gate

python scripts/run_rolling_backtest.py                    # production semantics
python scripts/run_rolling_backtest.py --uncorrected      # the paired before

python tests/test_residual_correction.py
python tests/test_rank_export.py
```

Artifacts: `artifacts/lab_winner_batch.json`, `artifacts/lab_rank_signal.json`,
`artifacts/rolling_backtest{,_uncorrected}.json`, and the fitted correction in
`artifacts/ensemble/corrector.json` (mirrored in `ensemble_eval/`).
