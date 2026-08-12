# Round-level signals lab

Branch `lab/round-level-signals`. Question: does anything at ROUND
granularity — judge scorecards, per-round stat shape, round-level survival
timing — improve the bout model, the Monte Carlo method mix, or the fixed-odds
book that prices off them?

The lab is gated. Stage 0 is two kill tests whose job is to stop work that
would otherwise look productive. Both failed, and that is written up here as
the result, not routed around.

Reproduce everything below with:

```bash
cd scripts/simulation && source venv/bin/activate
python scripts/run_rolling_backtest.py --cache      # Stage 0a
python scripts/lab_round_scorer_probe.py            # GATE 0b
python scripts/lab_round_redundancy_probe.py        # GATE 0c
python scripts/lab_fit_hazard.py                    # Stage 1
python scripts/lab_fit_decision.py                  # Stage 2
python scripts/calibrate_method_mix.py --start 2024-01-01
python scripts/eval_method_market.py                # held-out, fitted
python scripts/eval_method_market.py --legacy       # held-out, pre-lab
```

**Headline.** Both Stage 0 gates failed, so Stages 3 and 4 were not built.
Stage 1 and Stage 2 shipped, and between them they found two defects that had
nothing to do with round-level signals: the simulator's per-round finish
distribution was monotonically backwards, and its decision-winner split was six
times worse than a coin flip.

---

## Stage 0a — rolling-retrain backtest harness

`scripts/run_rolling_backtest.py`, report at `artifacts/rolling_backtest.json`.

The README's headline numbers came from ad-hoc code that was never committed.
This harness commits the procedure: quarterly origins across 2025-07..2026-07,
at each origin the ensemble retrains from scratch on bouts strictly before it
(val = the preceding 12 months, mirroring `TRAIN_END` → `VAL_END`), scoring only
the next quarter. Main and debut segments are separate because production
serves them with two different models. Scoring is order-invariant,
`P(A) = ½·[p(A,B) + 1 − p(B,A)]`.

| segment | n   | acc    | ±SE    | log-loss | brier  | AUC    |
|---------|-----|--------|--------|----------|--------|--------|
| main    | 417 | 0.6475 | 2.34pp | 0.6218   | 0.2158 | 0.7168 |
| debut   | 94  | 0.6170 | 5.01pp | 0.6534   | 0.2305 | 0.6521 |

Model vs market on the identical odds-covered bouts:

| segment | n odds | model acc | market acc | model LL | market LL |
|---------|--------|-----------|------------|----------|-----------|
| main    | 394    | 0.6497    | 0.6929     | 0.6183   | 0.5928    |
| debut   | 84     | 0.6310    | 0.7262     | 0.6412   | 0.5378    |

### Acceptance against the README (v0.10.0, main segment)

| metric              | README | harness | verdict |
|---------------------|--------|---------|---------|
| n                   | 417    | 417     | exact   |
| log-loss            | 0.623  | 0.6218  | matches |
| AUC                 | 0.717  | 0.7168  | matches |
| market acc (subset) | 0.693  | 0.6929  | matches |
| market LL (subset)  | 0.593  | 0.5928  | matches |
| **accuracy**        | 0.669  | 0.6475  | **−2.15pp** |

The bout set is identical (n=417, and the market numbers — which depend only on
the bout set — reproduce to four decimals). The accuracy gap is 9 bouts, 0.92
SE. **The window was not tuned to close it.** Two things explain it, and both
are reported by the harness itself rather than hidden:

1. Accuracy is not a stable statistic here. The `raw_order_diagnostic` field
   shows that scoring the raw scrape order instead of order-averaging gives
   acc 0.6547 / LL 0.6292 / AUC 0.7008 — **35 of 417 picks flip on fighter-slot
   order alone.** Neither convention lands on 0.669. A metric that moves 8.4%
   of its picks under a relabelling that cannot change the fight is not
   something to reconcile to three digits.
2. The data moved. 112 `bout_round_stats` rows have been written since
   v0.10.0 was trained on 2026-07-10, and `fighter_score_history` (the source
   of the point-in-time `vertex_score` features) is recomputed by the daily
   cron. The dataset is no longer byte-identical to the one that produced the
   README figure.

Log-loss, brier and AUC are the metrics to read, and all three reproduce.

---

## GATE 0b — round scorer: **FAIL**

`scripts/lab_round_scorer_probe.py`, report at
`artifacts/lab_round_scorer_probe.json`.

Gate: the learned scorer must reach **≥ 0.86 accuracy under GroupKFold** AND
clearly beat the hand rule on split rounds.

10,472 judged (bout, round) pairs with a binary judge majority (41 tied rounds
dropped, 45 legacy-format bouts dropped, 7–10 score guard applied). 2,237 of
them — 21.4% — are rounds the judges themselves disagree on.

| rung | segment | n | accuracy |
|------|---------|---|----------|
| 0 · always pick A (slot control) | all judged | 10,472 | 0.8128 |
| 1 · round winner == bout winner | decisive bouts | 10,336 | 0.8186 |
| 2 · four-term hand rule | all judged | 10,472 | 0.8276 |
| 2 · four-term hand rule | split rounds | 2,237 | 0.6053 |
| 3 · LightGBM scorer (GroupKFold) | all judged | 10,472 | 0.8430 ±0.36pp |
| 3 · LightGBM scorer (GroupKFold) | unanimous | 8,235 | 0.9022 ±0.33pp |
| 3 · LightGBM scorer (GroupKFold) | **split rounds** | 2,237 | **0.6249 ±1.02pp** |
| 3 · LightGBM scorer (GroupKFold) | 10-8 rounds | 326 | 0.9877 ±0.61pp |
| 3b · LightGBM scorer (temporal holdout ≥2025-01-01) | | 1,190 | 0.8370 ±1.07pp |

**Verdict: FAIL.** 0.8430 < 0.86.

The reference numbers reproduce: the hand rule on split rounds lands at 0.6053
against an expected 0.6063, and the full-population rule at 0.8276 against
0.8314 (measured here on 10,472 rounds rather than 9,980, so a small shift is
expected).

Three observations that matter more than the gate arithmetic:

* **Rung 0 and rung 1 are the same number.** "Always pick slot A" scores
  0.8128 and "the round went to whoever won the fight" scores 0.8186 — a 0.6pp
  spread. The scrape puts the winner in slot A in 99.6% of carded bouts, so on
  this data the bout-outcome baseline and pure slot order are nearly
  indistinguishable. Any round-scorer headline accuracy in the low 80s is
  mostly restating the bout result.
* **All the lift is on rounds nobody disputes.** 0.9022 on unanimous rounds,
  0.6249 on split rounds. The +2.0pp the scorer gains over the hand rule on
  split rounds is 1.9 SE — suggestive, not a result, and split rounds are the
  only ones where a scorer could tell you something the fight result doesn't.
* **The learned scorer is the hand rule with extra terms.** Gain shares:
  `total_str_landed` 28.3%, `sig_str_landed` 21.3%, `control_time_seconds`
  15.1%, `sig_str_head_landed` 6.2%, `takedowns_landed` 3.1%, `knockdowns`
  1.8%. That is the four-term rule plus a strike-location split, recovering
  1.5pp for a fitted model and a versioned artifact.

**Consequence: Stage 4 (round-scorer features in the bout model) is not built.**

---

## GATE 0c — feature redundancy: **FAIL**

`scripts/lab_round_redundancy_probe.py`, report at
`artifacts/lab_round_redundancy_probe.json`.

Gate: a point-in-time round aggregate must add **≥ 0.02 out-of-fold R²** on top
of the 118 production features when predicting a bout's judged round share.

Control hypothesis: `str_off/str_def`, `grap_off/grap_def`, `kd_off/kd_def`,
`ctrl_off/ctrl_def` are online opponent-adjusted ratings over
`RATING_METRICS = ("str", "grap", "kd", "ctrl")` — the same four metrics the
round rule uses — so the aggregate should be a re-packaging.

Target: judged round share for side A, n = 3,283 bouts, variance 0.1355. The
aggregate is built by chronological replay (snapshot pre-bout, update after),
covering 74.6% of dataset rows. R² is out-of-fold (5-fold, RidgeCV).

| feature set | cols | CV R² | residual var |
|---|---|---|---|
| rating diffs only | 8 | +0.0770 | 0.1251 |
| round aggregate only | 3 | +0.0529 | 0.1283 |
| production features | 118 | +0.1168 | 0.1197 |
| production + round aggregate | 121 | +0.1173 | 0.1196 |
| production MINUS rating diffs | 110 | +0.1047 | 0.1213 |
| production MINUS rating diffs + round aggregate | 113 | +0.1095 | 0.1207 |

**Incremental R² = +0.0005 against a gate of 0.02 — forty times below.**

The control hypothesis is confirmed directly. The 3-column round aggregate
alone reaches R² 0.0529 on its own; the 8 rating diffs alone reach 0.0770 —
strictly more. Delete the 8 rating diffs and the aggregate recovers +0.0047 of
the 0.0121 they were contributing, i.e. it re-derives about 39% of what those
ratings already carry and finds nothing beyond them.

Worth naming: the whole 118-column production set explains only 11.7% of the
variance in judged round share. Round-by-round scoring is largely not
predictable from pre-fight fundamentals, by any of these features. That is a
statement about the ceiling, not about the aggregate.

**Consequence: Stage 3 (round-shape / cardio features) is not built either.**

---

## What Stage 0 changed about the plan

| stage | status | reason |
|-------|--------|--------|
| 0a rolling backtest | shipped | harness committed, README numbers audited |
| 0b round scorer | **FAIL** | 0.8430 < 0.86; all lift on undisputed rounds |
| 0c redundancy | **FAIL** | ΔR² +0.0005 vs gate 0.02 |
| 1 finish hazards | shipped | needs no scorecards; fixed the round distribution |
| 2 decision-winner model | shipped | the actual cause of the bad method mix |
| 3 round shape / cardio | **not built** | GATE 0c |
| 4 round scorer features | **not built** | GATE 0b |

The permutation control of §7 in the lab brief is moot: it exists to catch a
Stage 3/4 gain that came from slot order rather than judging signal, and
neither stage produced a gain to test.

Worth stating plainly, because it is the lab's most useful outcome: the two
gates were designed to kill round-level features, and they did — but running
them forced a like-for-like comparison against the incumbent simulator, and
that comparison is what surfaced the two real defects. Both were in code that
predates this lab and neither has anything to do with rounds.

---

## Stage 1 — fitted finish hazards

`src/finish_hazard.py`, fitted by `src/round_fit.py` (which `run_train.py` calls
on every retrain — since 2026-08-13; before that the fit ran only when someone
ran the lab by hand) and graded by `scripts/lab_fit_hazard.py`, report at
`artifacts/lab_finish_hazard.json`.

Cause-specific KO and submission hazards, Poisson regression with exposure on a
15-second person-period grid. 8,548 bouts survive the exclusions (23 DQ/NC, 9
with more observed rounds than `scheduled_rounds`, 48 pre-2000 long-round
bouts); train 7,245 / val 506 / test 797; 2,437 KO and 1,458 submission events
in train. Every bout is expanded in **both** directions, so the design matrix
is antisymmetric in the fighter slot by construction. Covariates are
`FighterMC` fields only — no realized in-fight statistics, which would be a
train/serve distribution swap.

The clock is **absolute elapsed time**, not the fraction-of-fight τ the MC
used. `scheduled_rounds`, `is_main_event` and `is_title_fight` are covariates,
so `LENGTH_FINISH_BONUS` is not fitted from the 3r-vs-5r contrast — all 899
five-rounders are main events or title fights, and that contrast is confounded
with fighter quality.

### What the fit disagrees with

| incumbent constant | asserts | fitted |
|---|---|---|
| `ROUND_RAMP = 0.55` | hazard rises 55% across a round | **+0.11 log-hazard**, an 11% rise |
| `DAMAGE_GAMMA = 1.6` | hazard rises with elapsed time (finishes cluster late) | **declines** with elapsed time |
| — | — | `is_title_fight` **+0.29** on both causes, net of everything else |

Coefficients behave where theory has an opinion: attacker `kd_per_fight` +0.112
on KO and −0.102 on submission, attacker `sub_per15` +0.213 on submission,
defender `losses_ko_rate` +0.166 on KO, defender `losses_sub_rate` +0.130 on
submission.

The declining baseline is population selection, not a claim that a fixed pair
gets safer: the at-risk pool at minute 20 is enriched for fighters neither of
whom can finish. It is nonetheless the correct thing to hand the simulator,
because the simulator has no frailty term either.

### The round markets were backwards

This is the largest single result of Stage 1, and it does not go through the
method mix at all.

| 3-round bouts | R1 | R2 | R3 |
|---|---|---|---|
| **actual** (n=4,008 finishes) | 54% | 31% | 15% |
| incumbent MC | 17% | 35% | 49% |
| fitted | 48% | 33% | 19% |

Held-out round-of-finish log-loss over 410 test finishes: **1.0218 fitted vs
1.4585 incumbent**. The incumbent's damage curve is monotonically increasing
where reality is monotonically decreasing. Those numbers are
`bout_simulation_rounds.prob_finish_round_*`, which `src/lib/sportsbook.ts`
prices the round markets from.

### Head-to-head on the method mix (test, n=797)

Two hazard specifications, identical bouts, identical downstream arithmetic,
exact integration rather than sampling. The decision cell is split 50/50 so
the comparison isolates the hazards.

| decision split | fitted | incumbent MC | constant base rates |
|---|---|---|---|
| neutral 50/50 | **0.9077** | 0.9771 | 1.0246 |
| production `_decision_logit` | 3.4190 | 3.4752 | 1.0246 |

The fitted hazards beat both the incumbent and the constant. **But look at the
second row.** Swapping the 50/50 split for the production decision logit sends
*both* specifications to ~3.4, more than three times worse than a constant
predictor. That relocated the problem the lab was chartered to fix: the
per-fight method mix was never finish-heavy because the finish hazards were
wrong.

---

## Stage 2 — fitted decision-winner model

`src/decision_model.py`, fitted by `src/round_fit.py` (see Stage 1) and graded
by `scripts/lab_fit_decision.py`, report at `artifacts/lab_decision_winner.json`.

4,014 decisions with a winner; train 3,350 / val 277 / test 387. Logistic
regression with **no intercept** on A−B differences of all ten `FighterMC`
fields, which makes it antisymmetric as an algebraic identity rather than
something enforced by averaging orderings at serve time. Both orientations are
still emitted (asserted base rate 0.500). `C` and the temperature are swept on
val by the same procedure that produced `METHOD_ANCHOR_LAMBDA`.

### Held out on 387 test decisions

| | fitted | incumbent | coin flip |
|---|---|---|---|
| log-loss | **0.6496** | **4.2238** | 0.6931 |
| accuracy | 0.6253 ±2.5pp | 0.5530 | 0.5 |
| priced beyond 5% / 95% | 0.0% | **88.6%** | — |

The incumbent `_decision_logit` is **six times worse than a coin flip**. It
calls 88.6% of decisions a near-certainty and gets 55.3% of them right.

The mechanism is visible in the weights. The hand rule puts **+0.80** on a
`control_per_min` difference and then divides the whole logit by a temperature
of 0.45 — a 1.8× multiplier on a quantity that routinely differs by more than
1.0 between two fighters. The fit puts **+0.11** there, and moves the weight to
absorbed strikes (−0.29 vs a hand weight of −0.10) and takedowns per 15 (+0.21
vs +0.08).

This matters even though `sportsbook.ts` takes the winner LEVEL from the
ensemble: `reconcileMethodProbs` rescales each side's (ko, sub, dec) to that
side's ensemble probability, so the MC supplies the RATIO. A decision split of
0.95/0.05 leaves the underdog's cells almost pure finish, and that is what the
underdog's method market gets priced from.

### Effect on the anchor

`METHOD_ANCHOR_LAMBDA` existed to absorb exactly this. Conditional method
log-loss with both fitted models loaded from their split-trained twins:

| window | λ=0 (raw mix) | λ=0.80 (old) | λ=0.40 (new) | constant |
|---|---|---|---|---|
| 2021-01..2024-12, n=1,646 | 4.1236 → **0.9993** | 1.0103 | **0.9799** | 1.0183 |
| 2024-01..2024-12, n=428, fully out-of-sample | 0.9628 | 0.9613 | **0.9456** | 0.9769 |

The raw per-fight mix now beats the base rates **with no anchoring at all** —
0.9993 against 1.0183, where before it scored 4.1236. λ was re-swept to 0.40,
and both windows agree; the curve is flat between 0.35 and 0.45 (0.9800 /
0.9799 / 0.9802), so it is an interior optimum.

The wide window overlaps the fitted models' training data, which is why the
2024-only window is quoted beside it and why `calibrate_method_mix.py` now
warns about the overlap.

### End-to-end on the held-out test window

`scripts/eval_method_market.py`, n=650 test bouts, 552 with all six method
cells priced. `--legacy` reproduces the full pre-lab configuration, so this is
before/after on identical bouts rather than against a remembered number.

| | legacy | with fitted models | devigged market |
|---|---|---|---|
| 6-cell log-loss, pure | 1.6213 | **1.5969** | 1.5005 |
| 6-cell log-loss, edge-guarded | 1.6128 | **1.5884** | 1.5005 |
| gap to market | 0.1208 | **0.0964** | — |

Marginal calibration is near-exact either way (KO 31.2% predicted vs 31.2%
actual) — that is what λ=0.80 was buying, at the price of per-fight
discrimination. The log-loss gain is that discrimination coming back.

**ROI against the closing method lines stays deeply negative** in both
configurations: −22% to −25% at every EV threshold, against a bet-every-cell
baseline of −22.5%. The model does not beat the method market, and nothing in
this lab changed that. The improvement is in calibration and in the round
distribution, not in edge.

---

## Rejected, and why

Keeping this list is the point of a gated lab.

| thing | verdict | reason |
|---|---|---|
| **Stage 4 — round-scorer features** | not built | GATE 0b: 0.8430 GroupKFold vs a 0.86 gate; all lift on rounds nobody disputes (0.9022 unanimous vs 0.6249 split) |
| **Stage 3 — round-shape / cardio features** | not built | GATE 0c: +0.0005 incremental out-of-fold R², 40× below the 0.02 gate |
| **Naive R3−R1 cardio delta** | not attempted | Sign is inverted by survivorship: mean sig strikes RISE R1→R3 (15.85 → 17.98) because fighters who fade get finished and have no R3 row |
| **§7 permutation control** | moot | It exists to catch a Stage 3/4 gain that came from slot order rather than judging signal. Neither stage produced a gain to test |
| **Fitting `LENGTH_FINISH_BONUS` from the 3r-vs-5r contrast** | refused | All 899 five-rounders are main events or title fights; the contrast is confounded with fighter quality. Estimated inside the hazard model with card position as covariates instead |
| **Tuning the backtest window to match the README's 66.9%** | refused | The bout set already matches exactly and log-loss / AUC / market all reproduce. 35 of 417 picks flip on fighter-slot order alone, so accuracy is not a reproducible statistic at this n |
| **Replacing `_anchor_methods` outright** | not done | It is still worth 0.02-0.05 nats at λ=0.40 and it absorbs era drift in the base rates — the fitted hazards are calibrated to their training era (they over-predict KO on the 2024 val window by 7pp) |
| **Post-hoc calibration of the fitted models** | not attempted | Same trap `ensemble.py:24-29` documents: isotonic on a few hundred val rows double-dips noise. The no-intercept logistic is calibrated by construction instead |

## What is NOT changed

* The bout-winner ensemble. The Monte Carlo feeds `bout_simulation_rounds`
  only; `rolling_backtest.json` is unaffected by everything in Stage 1 and 2.
* `MODEL_VERSION` — this is a lab branch, and the brief reserves the bump for
  artifacts that actually ship.
* `CLIP_ANCHOR_DATE`, `stable_hash`, `symmetrize_for_training`, `ROUND_STATS_SQL`.
* Every hand-set constant stays a live module-level float: they are the
  no-artifact fallback path, and `calibrate_method_mix.py` monkey-patches
  `KO_TOTAL_SCALE` / `SUB_TOTAL_SCALE` / `METHOD_ANCHOR_LAMBDA` by module
  attribute, which only works while they are plain floats read at call time.
