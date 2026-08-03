# Accuracy batch — six levers, one ships, and a README number that was wrong

Branch `lab/accuracy-batch`. Everything here was gated on walk-forward
out-of-fold pools rather than on a val window, and the reason is the first
result in the report: **the instrument this repository selects on cannot
resolve the effects it is routinely asked about.**

**Headline: nothing moves the winner leg, and the one thing that ships is
coverage, not sharpness.** Five of six levers failed their gate. The sixth
— v0.14.0 — gives the conditional method model to the ~19 % of the slate
that had no method model at all, and beats what production serves there by
**0.048 nats**, sign-stable over three seeds with every interval excluding
zero. That is an order of magnitude above the detection floor in §0,
because it is not an improvement to a model: it is a model where there was
none.

The five failures are not filler. Three of them close a question rather
than leaving it open, one of them dissolves the diagnosis that motivated
it, and one corrects a number in the README. And the batch's other product
is the machinery that made all of that legible: a walk-forward pool for the
method leg (543 submissions instead of 71), one for the debut specialist
(798 rows instead of 84), and a measured detection floor to put at the top
of every future lab report.

---

## 0. The floor, first

`winner_batch.md` §1 moved winner-leg selection off the 429-row val split
because "a lever worth 0.003 nats is not measurable on 429 rows". It never
said what IS measurable on the 3,087-row pool that replaced it. Five
baseline seeds:

| seed | OOF log-loss |
|---|---|
| 7 | 0.64892 |
| 13 | 0.64945 |
| 42 | 0.64808 |
| 99 | 0.64791 |
| 2024 | 0.64998 |

| quantity | value |
|---|---|
| sd across seeds | 0.00088 |
| paired SE (same recipe, different seed) | 0.00116 |
| one-sided 80 % MDE, single seed | **0.00363** |
| one-sided 80 % MDE, infinite seeds | **0.00288** |

`RESIDUAL_CORRECTION` — the only lever this repository has ever shipped on
the winner leg — is worth **−0.0026**, which is *below* the single-seed
floor and below the infinite-seed floor too.

That is not an argument against v0.13.0. It is a statement about why it was
shippable: three independent legs agreed on its sign (cross-fit, forward,
held-out), and agreement across legs is doing work that no single reading's
power can do. It also means **more seeds cannot rescue an underpowered
arm** — the floor only falls from 0.0036 to 0.0029 as the seed budget goes
to infinity, because the paired SE, not the seed noise, is what dominates.

Every gate below therefore reports three legs and refuses to read any one
of them alone.

---

## 1. The three pools

| pool | what production selects on | what this batch selects on |
|---|---|---|
| main (both-experienced) | 429 val rows | 3,087 bouts *(existing)* |
| conditional method | 428 val rows / **71 submissions** | **3,081 bouts / 543 submissions** |
| debut specialist | **84 val rows** | **798 bouts** |

`iter_origins` in `scripts/lab_winner_common.py` is the walk-forward
schedule lifted out of `walk_forward` unchanged — verified origin by origin
and mask by mask against the pre-refactor loop, 32 origins, identical. Both
new pools run on it, so their numbers stay comparable with the winner leg's
rather than being measured by a re-implementation.

Two details that are contracts, not conveniences:

* the debut pool guards on the **debut** counts, not the full ones. An
  origin whose val window holds four debutants would pick an early-stopping
  round from noise and the pool would inherit it silently. With the guard,
  each origin's own selection window averages **103** debut rows — already
  larger than the 84 production ships on.
* the method pool is per-bout in the **winner-first** orientation, because
  that is the orientation the conditional is defined in. It measures
  `LL(method | winner)`, the term this leg owns; the winner term belongs to
  the ensemble and is measured on its own pool.

---

## 2. Nationality in the corrector — **GATE FAIL (third leg)**

The bias is real, large, and stable. On the seed-42 pool:

| segment | n | model says | actually | bias |
|---|---|---|---|---|
| A is American, B is not | 485 | 0.4927 | 0.4124 | **+0.0804** |
| B is American, A is not | 551 | 0.5165 | 0.5644 | **−0.0479** |

and it does not drift:

| era | d_us = +1 | d_us = −1 |
|---|---|---|
| 2017–2020 | +0.0798 | −0.0094 |
| 2020–2023 | +0.0709 | −0.0806 |
| 2023–2026 | +0.1008 | −0.0639 |

One coefficient on `d_us = 1[A is US] − 1[B is US]`, applied after the
blend where nothing competes with it:

| block | cross-fit | forward | coefficients |
|---|---|---|---|
| age only | −0.00243 | −0.00291 | −0.2940 |
| US only | −0.00274 | −0.00310 | −0.2755 |
| age + US | **−0.00475** | **−0.00539** | −0.2698 / −0.2572 |

Incremental over the shipped age term: **−0.00232** cross-fit, **−0.00248**
forward — about the size of all of v0.13.0, and above the detection floor
in §0. Then the held-out window:

| block | test log-loss | Δ |
|---|---|---|
| baseline (corrector stripped) | 0.6131 | — |
| age only | 0.6078 | −0.00535 |
| US only | 0.6141 | +0.00096 |
| age + US | 0.6095 | −0.00364 |

**+0.00172 incremental on test.** Best on the pool it was fitted on, worse
on the window it was not — the signature that killed the 8-column block in
`winner_batch.md` §6, reappearing at two parameters.

### Why this is not closed

`country_code` covers **71.1 %** of the OOF pool and **41.7 %** of the test
window. The column is Wikidata-sourced through an English-Wikipedia article
title, so the hole is the low-profile and newly-signed end of the roster —
and the test window is the recent end of the calendar, where that end of the
roster is over-represented. The term is fitted where it is visible and
applied where it mostly is not.

That was stated before the run, not after it, which is what makes the
re-run legitimate rather than a second bite: migration `0094` adds
`fighter.sherdog_flag_code` / `sherdog_nationality`, and step 18
(`scripts/scraper/scripts/18_backfill_country_sherdog.py`) fills it from
Sherdog for the 4,171 fighters (**91.1 %**) that carry a verified
`sherdog_id`. One definition across the whole population, instead of one
that is present exactly where the model was fitted.

Both readings are in this document. The `country_code` arm failed.

### The two sources are not the same fact

A 150-fighter read-only comparison (`--validate`) puts agreement at
**0.8600**, and the disagreements are structural:

* **definition** — `country_code` is Wikidata P27 (citizenship); Sherdog's
  block is `.item birthplace`. Adesanya reads NG against NZ, Uriah Hall JM
  against US, Karo Parisyan US against AM.
* **vocabulary** — 9 of the 21 disagreements are the Home Nations, where
  Sherdog ships `en` for England. `EN` is not ISO at all, and `SC` *is*
  ISO — for Seychelles.

So the flag code is stored raw and `country_code` is left alone (it is
rendered on live fighter pages). The lever itself is untouched by the
vocabulary problem: it only ever reads the US indicator, and `US` means the
same thing in both.

---

## 3. Sub-axis temperature — **GATE FAIL**, and the diagnosis dissolves

`method_leg.md` §4 named the submission cell as carrying the whole residual
gap to the book, and §9 then failed to move it twice — a hierarchical
re-shape was *worse* than the flat softmax (shape), and nine columns of
genuinely new submission information moved the val cell by 0.002 with
per-seed deltas that did not agree in sign (information). Both on 71 val
submissions.

The third possibility those two do not rule out is **dispersion**, and the
motivating read was a submission cell under-dispersed at both ends: q1
predicted 0.060 against 0.027 actual, q5 0.364 against 0.402. On 543
submissions instead of 71:

| quintile | n | predicted | actual |
|---|---|---|---|
| 1 | 616 | 0.0456 | 0.0390 |
| 2 | 616 | 0.0781 | 0.0925 |
| 3 | 616 | 0.1190 | 0.1201 |
| 4 | 616 | 0.1888 | **0.2403** |
| 5 | 617 | 0.3730 | 0.3890 |

The ends are close. What is left is a **bump in q4**, and a one-parameter
temperature is the wrong shape for a bump — it can only tilt the whole
axis. The fit says so itself: τ = 0.9335 on the full pool (flattening, not
sharpening) and 1.0021 forward, the identity to three decimals.

| leg | Δ | verdict |
|---|---|---|
| cross-fit | +0.00023 | FAIL |
| forward | +0.00007 | FAIL |
| held-out 2025+ | −0.00011 | pass |
| decision cell not degraded | **+0.01042** | FAIL |

The side condition earned its place. The decision cell is the one place
this model is ahead of the book (−0.0920), and the full-fit arm spends
+0.0104 of it to buy −0.0438 on submissions. A gate on the submission cell
alone would have called that a win.

**So the method leg's residual gap is not shape, not information, and not
dispersion** — three of the four things it could have been, the last two
ruled out on a pool 7.6× the size of the one that ruled out the first.

---

## 4. The age correction on the debut specialist — **GATE FAIL**

The open question at the end of `winner_batch.md`. The correction was
fitted and gated on the both-experienced population; `train.py` assigns
`.corrector` only at :365, on the main ensemble. One uncontrolled
observation had moved the debut segment 0.6534 → 0.6380 on 94 bouts.

A mechanistic argument was recorded **against** the lever before the run:
v0.13.0's entire justification was that `diff_age` is *diluted* among 117
partly collinear columns. A debut row has 27 of its 67 diffs at NaN — less
to dilute it — so the correction should be worth **less** there, not more.

| | |
|---|---|
| n | 798 (`diff_age` live on 100 %) |
| declared MDE before the run | unpaired SE 0.00848 → 0.02111 |
| baseline | 0.66379 |
| corrected | 0.66597 |
| **Δ** | **+0.00218** (paired SE 0.00261, z = +0.83) |

Not a significant negative — not significant in either direction, which is
the honest reading. What it does establish is that the observation this
question came from does not reproduce: the point estimate has the opposite
sign, and the effect it claimed is 6× the paired SE, so the pool would have
seen it.

Applying the corrector post-hoc to the stored pool is exact, not an
approximation: it runs after the blend and does not touch fitting, so
re-serving `p_raw` / `p_sw` under the antisymmetric shift is what
`predict_proba_a` would have returned.

---

## 5. Absolute levels in the debut matrix — **GATE FAIL**

Measured rather than assumed: of the 67 diffs, **27 are 100 % NaN on a
debut row**, and 22 of them have no `abs_*` companion (`prior_win_rate`,
`prior_finish_rate`, `slpm`, `sapm`, `str_acc`, `td_per15`, `td_acc`,
`td_def`, `sub_per15`, `control_per_min`, `control_absorbed_per_min`,
`reversals_per_fight`, `finish_against_per_bout`, `avg_bout_seconds`, the
four `avg_opp_elo_*` / `max_opp_elo_beaten` / `sos_weighted_winrate`, and
the three `traj_*`).

The hole is not the debutant's own level, which is genuinely unknown. It is
the **opponent's**: when one side is NaN the diff is NaN, so the model
cannot see whether the experienced fighter is a 5.2-slpm volume striker or
a 1.8-slpm grinder. Every debut bout looks identical on those 22 axes.

Deliberately excluded: `str_off/def`, `grap_off/def`, `ctrl_off/def`,
`elo`, `glicko_cons`. A debutant's snapshot gives those real initial values
(0 = league mean for the opponent-adjusted ratings, elo 1500, glicko 800),
so the diff already carries the opponent's level and a level column would
be redundancy.

Three seeds on the 798-row debut pool:

| seed | baseline | + levels | Δ | 95 % CI | improving |
|---|---|---|---|---|---|
| 42 | 0.66379 | 0.66566 | **+0.00187** | [−0.00328, +0.00715] | 25 % |
| 7 | 0.66724 | 0.66600 | −0.00123 | [−0.00758, +0.00488] | 66 % |
| 13 | 0.66787 | 0.66600 | −0.00187 | [−0.00759, +0.00412] | 73 % |

Median −0.00123, **sign not stable across seeds**, every interval straddles
zero. That is condition (g) — the one that has cleanly killed three
variants in this directory before — and it fails here for the ordinary
reason: 44 new columns against a paired SE near 0.0026 on 798 rows. The
diagnosis may still be right; the pool cannot say so.

`DEBUT_LEVEL_COLUMNS`, `add_debut_levels` and
`build_debut_matrix(levels=True)` stay in the tree with the flag off, on
the reasoning that kept `regional_export.py` and the submission axis after
their labs failed: building the data is the expensive part, and the next
lab should not have to re-derive which 22 columns they are.

---

## 6. A method model for the debut segment

**GATE PASS — the only one in this batch. Ships as v0.14.0.**

`train_method_model` is handed `exp_df` (`train.py:604`), so it has never
seen a debut row, and `predict.py` passed `method_mix=None` for those
bouts. About 19 % of the priced slate took its method / distance /
total_rounds numbers from the simulator's own hazards, whose entire
per-fight input is ten hand-shrunk `FighterMC` fields — every one of them
a router default when one side has no UFC record.

### The baseline was not the straw man it looked like

The gate was designed around a prior that turned out to be wrong, and the
refutation is the most useful thing in this section. The plan was to gate
against a per-scheduled-length CONSTANT on the debut base rates
(ko/sub/dec 0.3597 / 0.2292 / 0.4111 against the experienced
0.3257 / 0.1877 / 0.4866), on the reasoning that most of the available
gain was a marginal that is simply wrong for the segment, and that beating
the MC anchor would therefore prove nothing.

On 793 walk-forward bouts:

| arm | 3-class log-loss |
|---|---|
| per-length constant on debut base rates | 1.05242 |
| **MC anchor — what production serves today** | **1.00910** |

The constant is **worse than the anchor by +0.04332** ([+0.02102,
+0.06468], improving in 0 % of resamples). The simulator is carrying real
per-bout signal on this segment even on router defaults, so the anchor was
never a straw man and the marginal was never the story. The gate is
therefore against the anchor — against what production actually serves —
and the constant stays in the report as the diagnostic that says the win
is a model win and not a corrected base rate.

### The gate

| seed | model | vs MC anchor | 95 % CI | improving | vs constant |
|---|---|---|---|---|---|
| 42 | 0.96085 | **−0.04825** | [−0.07582, −0.01967] | 100 % | −0.09157 |
| 7 | 0.95625 | **−0.05285** | [−0.08054, −0.02484] | 100 % | −0.09616 |
| 13 | 0.96302 | **−0.04608** | [−0.07363, −0.01859] | 100 % | −0.08940 |

Median **−0.04825**, sign stable, every interval excludes zero, every
resample improves. This is an order of magnitude above the §0 floor —
which is what a segment with *no model at all* should look like, and is
the reason this is the one lever in the batch that did not need the floor
argued about.

### What ships

`train_debut_method_model` (`src/train.py`), artifacts in
`artifacts/method_model_debut{,_eval}/`, routing through `mix_for(i)` in
`src/predict.py`. Same transfer recipe as the v0.8.0 winner-leg
specialist and for the same reason — ~2.2k gradeable debut rows is not
enough alone, so both-experienced rows enter at `DEBUT_EXP_ROW_WEIGHT`
while early stopping and the simplex blend are selected on debut val rows
only.

A separate artifact rather than the existing model served wider: that one
has never been fitted on a row where one side's career columns are
entirely NaN, and `method_leg.md` refused exactly that widening at the
time. Missing artifact → mix stays `None` → the debut segment keeps
pre-v0.14.0 behaviour bit for bit, the same fallback contract v0.12.0
shipped with.

Three of the four legs `sportsbook.ts` prices move with it — method,
`distance` and `total_rounds` all come off the one reconciled
distribution. The winner leg is untouched at exactly 0.0000: this is a
mix change on a segment, not a re-scoring.

---

## 6b. CatBoost is the one leg that does not reproduce

Found while shipping §6, and it is a reproducibility fact about the repo
rather than a result about the model. Re-running `run_train.py` on the same
dataset (identical split sizes 5,350 / 429 / 664, identical method-model
`n_train` 5,340) does not reproduce the committed artifact:

| leg | previous test log-loss | re-run | Δ |
|---|---|---|---|
| LightGBM | 0.6234925 | 0.6234880 | −0.0000045 |
| LogReg | 0.6212311 | 0.6211650 | −0.0000662 |
| **CatBoost** | 0.6212159 | **0.6256980** | **+0.0044821** |
| blend | 0.6125547 | 0.6136627 | +0.0011079 |

LightGBM reproduces to six decimals and LogReg to five. CatBoost does not,
and it drags the blend with it — the val-picked softmax weights move
0.067/0.172/0.761 → 0.079/0.124/0.797 because CatBoost's val log-loss moved.

`EnsembleModel._cb_params` pins `random_seed=42` but **not**
`thread_count`, and CatBoost's ordered boosting reduces across threads, so
the fit depends on how many cores are actually available. The re-run here
happened while three scraper shards were saturating the machine.

Two consequences worth stating plainly:

* the +0.0011 blend movement in this branch's artifacts is CatBoost
  run-to-run noise, not a cost of v0.14.0. It sits inside the seed band
  measured in §0 (sd across seeds 0.00088, spread 0.0021), and v0.14.0
  cannot touch the winner leg by construction — the method mix is a
  reshape and the winner term of the 6-cell factorisation is shared,
  unmodified.
* every weekly auto-retrain has been drawing a fresh sample from this
  distribution. Pinning `thread_count` would remove it, but that changes
  every committed artifact and therefore needs its own gate rather than a
  drive-by fix in this branch.

---

## 7. The README's calibration number

`winner_batch.md` §8 and the README report reliability 0.00186 (model)
against 0.00301 (market) on a 10-equal-width-bin Murphy decomposition, and
conclude that calibration is now better than the closing line's. **The
conclusion is right. The statistic is not the one to quote.**

Model − market reliability, by bin count, across five baseline seeds
(negative = model better):

| bins | 42 | 7 | 13 | 99 | 2024 | sign-stable |
|---|---|---|---|---|---|---|
| 5 | −0.00067 | −0.00025 | −0.00028 | −0.00019 | −0.00001 | yes |
| 10 | −0.00019 | −0.00041 | −0.00042 | **+0.00021** | −0.00007 | **no** |
| 20 | **+0.00207** | −0.00094 | −0.00142 | −0.00096 | −0.00046 | **no** |
| 40 | **+0.00280** | −0.00138 | +0.00022 | −0.00055 | +0.00039 | **no** |

At 40 bins there are ~30 bouts per bin, and within-bin sampling error
inflates reliability for whichever series is more dispersed — which is the
market, by construction, because it is the sharper one. The high bin counts
are measuring the market's sharpness, not its calibration.

Bin-free CORP miscalibration (PAV recalibration, score improvement it buys;
lower = better calibrated) is sign-stable on all five seeds:

| seed | model | market |
|---|---|---|
| 42 | 0.01321 | 0.01537 |
| 7 | 0.01014 | 0.01537 |
| 13 | 0.01181 | 0.01537 |
| 99 | 0.01286 | 0.01537 |
| 2024 | 0.01240 | 0.01537 |

Better calibrated than the book, confirmed — by an estimator that does not
move when the seed does.

---

## 8. Rejected, with reasons

| # | Idea | Why rejected |
|---|---|---|
| 0 | Gating the debut method model against a per-length CONSTANT | The prior was that the MC anchor was a straw man and the win would be a corrected marginal. Measured, the constant is WORSE than the anchor by +0.0433 — the simulator carries real per-bout signal there. The gate moved to the anchor and the constant stayed as the diagnostic. §6 |
| 1 | Nationality term in `RESIDUAL_CORRECTION` (`country_code`) | Two legs pass (−0.0023 / −0.0025), held-out +0.0017. Coverage 71 % on the fit pool against 42 % on test. §2 |
| 2 | Sub-vs-dec temperature | τ = 0.9335 full / 1.0021 forward; cross-fit +0.00023, forward +0.00007; spends +0.0104 of the decision cell. §3 |
| 3 | The under-dispersion diagnosis behind it | Does not reproduce at 543 submissions — the ends are calibrated, the defect is a q4 bump a one-parameter tilt cannot reach. §3 |
| 4 | `RESIDUAL_CORRECTION` on the debut specialist | +0.00218, z = +0.83 on 798 rows. The 94-bout observation does not reproduce. §4 |
| 5 | Quoting 10-bin reliability as evidence of calibration | Not sign-stable across seeds; use the bin-free CORP number. §7 |
| 6 | Absolute levels for `str_off/def`, `grap_off/def`, `ctrl_off/def`, `elo`, `glicko_cons` on debut rows | Not NaN on a debut row — the snapshot gives real initial values, so the diff already carries the opponent's level. §5 |
| 7 | More seeds to rescue an underpowered arm | The MDE floor falls only from 0.0036 to 0.0029 as the seed budget goes to infinity. §0 |

## What is NOT changed

* The winner leg. Same 118 columns, same three learners, same blend rule,
  same `FEATURE_CONTRI_OVERRIDES`, same `RESIDUAL_CORRECTION`. v0.14.0
  moves it by exactly 0.0000 — the method mix is a reshape, and the winner
  term inside the 6-cell factorisation is untouched.
* The non-debut conditional method model, its artifacts and its
  population. `USE_SUB_AXIS` stays False.
* `monte_carlo.py`, `finish_hazard.py`, `decision_model.py`. The debut
  segment's TIMING still comes from the fitted hazards; only how much
  finish mass there is to place changed.
* `DEBUT_LEVEL_COLUMNS` and `build_debut_matrix(levels=True)` exist but are
  off — `debut_feature_names()` with no argument returns the v0.8.0 list,
  and `tests/test_accuracy_batch.py` pins that.
* `fighter.country_code`. The new nationality columns are additive.

## Reproducing

```bash
cd scripts/simulation && source venv/bin/activate

python scripts/lab_accuracy_batch.py --stage pools   --cache --seeds 42
python scripts/lab_accuracy_batch.py --stage power   --cache --seeds 42
python scripts/lab_accuracy_batch.py --stage calib   --cache --seeds 42,7,13,99,2024
python scripts/lab_accuracy_batch.py --stage nat     --cache --nat-source country_code
python scripts/lab_accuracy_batch.py --stage subtemp --cache
python scripts/lab_accuracy_batch.py --stage debutcorr   --cache
python scripts/lab_accuracy_batch.py --stage debutlv     --cache --seeds 42,7,13
python scripts/lab_accuracy_batch.py --stage debutmethod --cache --seeds 42,7,13

# the nationality re-run, once step 18 has filled the column
cd ../scraper && ./venv/bin/python scripts/18_backfill_country_sherdog.py
cd ../simulation
python scripts/lab_accuracy_batch.py --stage nat --cache --nat-source sherdog_flag_code
```

Results land in `artifacts/lab_accuracy_batch.json`; the pools are cached in
`data/lab_accuracy_{debut,method}_oof.parquet` (gitignored).
