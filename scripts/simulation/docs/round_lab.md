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
python scripts/run_rolling_backtest.py --cache
python scripts/lab_round_scorer_probe.py
python scripts/lab_round_redundancy_probe.py
```

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
| 1 finish hazards | proceeding | needs no scorecards; the method mix is the real hole |
| 2 decision-winner model | proceeding | replaces four hand-set weights |
| 3 round shape / cardio | **not built** | GATE 0c |
| 4 round scorer features | **not built** | GATE 0b |

The permutation control of §7 in the lab brief is moot: it exists to catch a
Stage 3/4 gain that came from slot order rather than judging signal, and
neither stage produced a gain to test.

<!-- STAGE_1_AND_2_RESULTS -->
