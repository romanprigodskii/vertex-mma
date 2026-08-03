# Accuracy batch — five levers, three new instruments, and a README fix

Branch `lab/accuracy-batch`. Everything here was gated on walk-forward
out-of-fold pools rather than on a val window, and the reason is the first
result in the report: **the instrument this repository selects on cannot
resolve the effects it is routinely asked about.**

**Headline: nothing ships on the winner leg, and that is the honest answer.**
Five levers, five gate failures — but three of the five failed in ways that
close a question rather than leave it open, and the batch's real product is
the machinery that made those failures legible: a walk-forward pool for the
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

<!-- RESULTS: debutmethod -->

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
| 1 | Nationality term in `RESIDUAL_CORRECTION` (`country_code`) | Two legs pass (−0.0023 / −0.0025), held-out +0.0017. Coverage 71 % on the fit pool against 42 % on test. §2 |
| 2 | Sub-vs-dec temperature | τ = 0.9335 full / 1.0021 forward; cross-fit +0.00023, forward +0.00007; spends +0.0104 of the decision cell. §3 |
| 3 | The under-dispersion diagnosis behind it | Does not reproduce at 543 submissions — the ends are calibrated, the defect is a q4 bump a one-parameter tilt cannot reach. §3 |
| 4 | `RESIDUAL_CORRECTION` on the debut specialist | +0.00218, z = +0.83 on 798 rows. The 94-bout observation does not reproduce. §4 |
| 5 | Quoting 10-bin reliability as evidence of calibration | Not sign-stable across seeds; use the bin-free CORP number. §7 |
| 6 | Absolute levels for `str_off/def`, `grap_off/def`, `ctrl_off/def`, `elo`, `glicko_cons` on debut rows | Not NaN on a debut row — the snapshot gives real initial values, so the diff already carries the opponent's level. §5 |
| 7 | More seeds to rescue an underpowered arm | The MDE floor falls only from 0.0036 to 0.0029 as the seed budget goes to infinity. §0 |

## What is NOT changed

* The served feature matrix — same 118 columns. `DEBUT_LEVEL_COLUMNS` and
  `build_debut_matrix(levels=True)` exist but are off; `debut_feature_names()`
  returns the v0.8.0 list unless asked otherwise.
* The three learners, the blend rule, `FEATURE_CONTRI_OVERRIDES`,
  `RESIDUAL_CORRECTION`.
* `monte_carlo.py`, `finish_hazard.py`, `decision_model.py`,
  `method_model.py` — `USE_SUB_AXIS` stays False.
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
