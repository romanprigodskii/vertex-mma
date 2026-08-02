# Method-leg lab — the mix, not the model

Branch `lab/method-leg`. Question: the fixed-odds book has been losing to the
closing method line by ~0.10 nats since the market was first backtested. Six
labs had been spent on the WINNER leg and all six closed at zero. Was the
method leg ever the smaller problem?

**Headline: it was the bigger one, and it shipped.** The deficit is 82 %
conditional mix and 18 % winner level. A discriminative fit on the winner
model's own feature matrix takes 0.114 nats off the 6-cell log-loss on the
held-out window, which carries it past the devigged closing line
(1.4807 edge-guarded vs the book's 1.4966). Flat-stake ROI against the
closing method lines goes from −26 % to +6 %. Two of the other three legs
move with it: `distance` by 0.075 nats, `total_rounds` by 0.046. The winner
leg moves by exactly 0.0000, which is the check that this is a mix change
and not a re-scoring of the book.

Shipped as v0.12.0: `src/method_model.py`, `artifacts/method_model/` (+ the
split-trained twin), and an optional `method_mix` on
`monte_carlo.simulate_bout` that replaces `METHOD_ANCHOR_LAMBDA` on the
non-debut segment.

Reproduce:

```bash
cd scripts/simulation && source venv/bin/activate
python scripts/lab_method_leg.py --stage decompose   # Stage 0
python scripts/lab_method_leg.py --stage gate0       # kill test
python scripts/lab_method_leg.py --stage gate1       # held-out
python scripts/lab_method_leg.py --stage gate2       # calibration
python scripts/lab_method_leg.py --stage legs        # Stage 3
python scripts/eval_method_market.py                 # from shipped artifacts
python scripts/eval_method_market.py --legacy        # pre-round-lab config
python tests/test_method_leg.py
```

---

## 0. What the round lab left behind

`docs/round_lab.md` re-fitted two things inside the simulator — the finish
timing hazards and the decision-winner split — and closed the method gap from
0.121 to 0.096 nats. Both fixes were real (the incumbent decision logit was
six times worse than a coin flip). Neither touched the shape of the problem:
the method mix is still produced by `monte_carlo.simulate_bout` from the ten
hand-shrunk fields of `FighterMC`, pushed through hand-set lift formulas, and
then shrunk 40 % toward the UFC base rates.

Ten fields. The winner ensemble consumes 118. Nothing in `FighterMC` is
weight class. Nothing in it is gender. No reach, no opponent-adjusted rating,
no Elo, no Glicko, no pre-UFC record. The simulator cannot know that
heavyweights finish and women's flyweights do not.

That is a plumbing hypothesis, not a modelling one, and it is falsifiable.

---

## 1. Stage 0 — split the deficit before spending anything

Every 6-cell distribution factorises exactly:

```
LL(6-cell) = LL(winner side) + LL(method | winner side)
```

so the gap to the book splits cleanly into a half the ensemble owns and a
half the simulator owns. Held-out test window, n=566 gradeable bouts carrying
a coherent 6-cell book:

| | 6-cell | = winner | + conditional |
|---|---|---|---|
| production, pure | 1.6037 | 0.6182 | 0.9856 |
| production, edge-guarded | 1.5955 | 0.6099 | 0.9856 |
| devigged market | 1.4966 | 0.5989 | 0.8977 |
| **gap (pure)** | **0.1071** | **0.0193** | **0.0879** |

Substituting the market's own mix onto our winner level scores 1.5158 — so
the mix alone is worth 0.088 nats, about 4.5x the winner-leg gap that
`regional_regime.md`, `tail_resolution.md` and `graded_target.md` each closed
at zero.

And the deficit is finish-specific. By the method that actually landed:

| method | n | mc ll | market ll | mc mean p | market mean p |
|---|---|---|---|---|---|
| ko | 189 | 1.1009 | 0.8607 | 0.346 | 0.461 |
| sub | 105 | 1.5798 | 1.3446 | 0.223 | 0.293 |
| dec | 272 | 0.6761 | **0.7508** | 0.516 | 0.502 |

The simulator **beats the book on decisions** and loses badly on both finish
types. When a KO landed it had priced 0.346 against the book's 0.461.
Marginal calibration was near-exact throughout (31.2 % predicted KO vs 31.8 %
actual), so this was never a base-rate error — it is pure resolution. Which
is exactly what a 40 % shrink toward the base rates looks like from outside.

Stage 0 fits nothing. Its job is to decide whether the rest is worth
building.

---

## 2. GATE 0 — kill test: **PASS**

If the simulator is already extracting what record and stat features hold,
a direct fit cannot help and the lab stops. Discriminative
P(ko/sub/dec | this side wins, X), three learners mirroring `ensemble.py`,
trained strictly before `TRAIN_END`, scored on the 2024 val window (n=428,
train n=5,340), seeds 42/7/13.

| | val log-loss |
|---|---|
| constant base rates | 0.9904 |
| MC production mix (λ=0.40) | 0.9449 |
| **discriminative fit** | **0.7627** (median) |

The MC reference reproduces the round lab's own number for this window
(0.9456 at λ=0.40) to three decimals, so this is the real production path
rather than a re-derivation of it.

0.18 nats is twice the entire gap to the closing line, which makes "it is a
leak" the correct first reaction. Two ablations localise it instead, and both
are part of the gate rather than a claim in prose:

| | val log-loss |
|---|---|
| constant base rates | 0.9904 |
| MC production mix | 0.9449 |
| **context only** — 14 columns, no fighter stats at all | **0.8245** |
| random instead of winner-first orientation | 0.8030 |
| full, winner-first | 0.7604 |

Context alone — the weight-class one-hots, gender, `scheduled_rounds`, title
and main-event flags, and not one fighter statistic — already beats the
simulator by 0.12 nats. That is the plumbing hypothesis confirmed
quantitatively: most of what the simulator was missing is four bout facts it
structurally cannot see. Conditioning on the winner is worth a further 0.04.
The learned functional form over the hand-set lift formulas is the rest.

**Falsification.** Shuffling the method labels within train collapses the fit
to 0.9913 against the constant's 0.9904. No residual slot artefact, no leak.

**Variant selection.** Per-side absolute levels (`with_levels`, 185 columns —
the quantities the lift formulas are literally made of) score 0.7633 against
the diffs-only matrix's 0.7627. A tie for 65 extra columns, so the
120-column matrix ships and `USE_LEVELS=False` keeps re-testing it a one-line
change. Both variants pass the gate on all three seeds.

---

## 3. GATE 1 — held out: **PASS**

Same recipe, scored on bouts it has never seen (≥ 2025-01-01, n=664
gradeable, 566 with a coherent book). The new mix is reconciled to the SAME
ensemble winner level production uses, so the comparison isolates the mix.

| | 6-cell | = winner | + conditional |
|---|---|---|---|
| production, pure | 1.6037 | 0.6182 | 0.9856 |
| production, edge-guarded | 1.5955 | 0.6099 | 0.9856 |
| **new, pure** | **1.4898** | 0.6182 | **0.8716** |
| **new, edge-guarded** | **1.4815** | 0.6099 | **0.8716** |
| devigged market | 1.4966 | 0.5989 | 0.8977 |

The conditional half goes 0.9856 → 0.8716 and lands **below the book's own
0.8977**. On all 664 gradeable bouts (not just the odds-covered subset) the
conditional mix goes 0.9708 → 0.8599.

Paired bootstrap by bout, 4,000 resamples:

* production − new (pure): **+0.1140 nats [+0.0737, +0.1556]**, improves in
  100.0 % of resamples.
* new (guarded) − market: **−0.0150 nats [−0.0618, +0.0319]**.

The honest reading of the second line is **parity, not victory**. The
interval straddles zero, so "we beat the book on method" is not established
at n=566. What is established is that we are no longer behind it.

**The anchor answers its own question.** λ was re-swept on val for the new
mix over a 0.00–0.60 grid and selected **0.00** on every seed.
`METHOD_ANCHOR_LAMBDA` existed to hide a mix with no resolution; a mix with
resolution does not want shrinking toward the base rates.

### ROI against the closing method lines

Flat 1u on every cell whose EV clears the threshold, bootstrapped BY BOUT
(six cells of one bout are mutually exclusive — resampling bets
independently understates the variance enough to manufacture a result):

| EV > | production | new |
|---|---|---|
| 0.00 | −26.0 % [−38.3, −13.2] | +7.7 % [−4.8, +20.5] |
| 0.20 | −23.7 % [−40.0, −6.9] | +11.6 % [−4.6, +29.1] |

Again the left half is what is established: production loses to the method
book with the interval nowhere near zero, and the new mix does not. Profit
is **not** established — every interval straddles zero. The claim is "no
longer paying the overround", not "an 8 % edge". 566 bouts against a closing
line cannot resolve 8 %.

Per method at EV > 0.05, from the shipped artifacts: decisions +12.3 %,
KOs +5.3 %, submissions −10.0 %. The submission cell is still the weakest,
which is consistent with everything Stage 0 found.

---

## 4. GATE 2 — the marginal regression is drift

Removing the anchor hands back the marginal accuracy it was buying: the new
mix predicts 15.2 % submissions against 18.4 % actual on test, where the
anchored simulator was near-exact. Before calling that a defect:

| window | | ko | sub | dec |
|---|---|---|---|---|
| train | pred | 0.331 | 0.190 | 0.479 |
| | actual | 0.331 | 0.190 | 0.479 |
| val | pred | 0.311 | 0.173 | 0.516 |
| | actual | 0.273 | 0.166 | 0.561 |
| test | pred | 0.311 | 0.152 | 0.538 |
| | actual | 0.318 | 0.184 | 0.498 |

The model reproduces its own training base rate to three decimals, so there
is no class shrink to correct. And the two out-of-sample deviations point in
**opposite directions** — over-predicting KO on val, under-predicting it on
test — which is the signature of drift rather than bias. The year table says
the same thing plainly:

| year | n | ko | sub | dec |
|---|---|---|---|---|
| 2022 | 419 | 0.332 | 0.205 | 0.463 |
| 2023 | 388 | 0.312 | 0.206 | 0.482 |
| 2024 | 428 | 0.273 | 0.166 | **0.561** |
| 2025 | 425 | 0.311 | 0.174 | 0.515 |
| 2026 | 239 | 0.331 | 0.201 | 0.469 |

2024 — the val window — is the decision-heavy outlier of the decade.

Three corrections, none shipped:

| attempt | val | test | verdict |
|---|---|---|---|
| prior correction, val-fitted | 0.7551 | 0.8700 | circular |
| prior correction, train-fitted | 0.7604 | 0.8610 | no-op (w = 1.000) |
| recency weighting, 4y half-life | 0.7600 | 0.8593 | below margin |
| recency weighting, 6 / 8 / 12y | 0.7612+ | 0.8575+ | val says no |

The val-fitted prior correction is the trap this gate exists to catch: it
improves val by 0.005 and costs test 0.009, because it fits 2024's outlier
mix and 2025–26 reverts. It is recorded but can never be *selected* by val —
weights chosen to make the val marginal exact make a val improvement
arithmetic, not evidence.

Recency weighting is the interesting near-miss. It helps test at **every**
half-life (0.8609 → 0.8575–0.8593) and val declines to select it. Taking it
anyway would be reading the test set. Rejected — and written down here so
that the next person who rediscovers it knows it was seen and refused rather
than missed.

The selection margin was tightened to 0.005 nats in the process: the first
run of this gate "selected" a 0.0004 val wobble, which at n=428 is a coin
landing the right way up.

**So the marginal cost is real and ships.** ~2 SE on a 664-bout window,
bought for 0.114 nats of resolution. Per-cell reliability holds across the
range (predicted 3.0/7.3/12.2/17.4/25.0/34.5/46.6 % against actual
2.7/8.4/11.5/18.3/23.3/32.1/50.7 %); the 0.60–1.00 bin has 15 cells in it
and says nothing.

---

## 5. Stage 3 — three legs move, not one

`computeSportsbookOutcomes` prices winner, method, `total_rounds` and
`distance` from ONE reconciled distribution. P(distance) *is* the method
market's P(decision), and the per-round finish curve is rescaled to the
reconciled finish total so the three cannot be arbitraged against each other.
A better mix therefore moves the other two props whether or not anyone
measures it. Each leg graded exactly as `settleSelection` grades it,
held-out, n=664:

| leg | constant | production | new | Δ |
|---|---|---|---|---|
| winner | 0.6931 | 0.6066 | 0.6066 | **+0.0000** |
| distance_yes | 0.6939 | 0.6734 | **0.5987** | +0.0747 |
| under_2_5 | 0.6783 | 0.6590 | **0.6126** | +0.0464 |

The distance leg is the striking one. Production sat at 0.6734 against
0.6939 for a constant — the book was offering a "goes the distance" market
that knew almost nothing, because P(decision) came out of a decision split
computed from ten fields. It now beats the constant by 0.0952 instead of
0.0205, a 4.6x larger edge over knowing nothing.

The winner leg moves by exactly 0.0000. That is the control: this is a mix
change, not a quiet re-scoring of the whole book.

Only the method leg has a scraped closing line, so `distance` and
`total_rounds` are scored against the train base rate. Those are internal
improvements and are labelled as such — no book has been compared against on
those legs, so no claim is made about one.

---

## 6. What shipped, and what it replaced

| | before | after |
|---|---|---|
| method mix source | `_ko_total_loghaz` / `_sub_total_loghaz` lift formulas over 10 `FighterMC` fields | `MethodModel.predict_cond` over 120 features |
| decision share | `decision_model.py` Bradley-Terry over 10 field diffs | one of three classes, per side |
| base-rate anchor | `METHOD_ANCHOR_LAMBDA = 0.40` | λ = 0.00, val-selected |
| per-side conditionals | one shared logit split both sides | two independent estimates |

`simulate_bout` gained an optional `method_mix`. When absent, every number it
produces is bit-identical to before — the no-artifact fallback, `custom.py`
and `--legacy` all rely on that, and `tests/test_method_leg.py` pins it. When
present it is a pure RESHAPE: each side's win level is preserved exactly as
`_anchor_methods` preserved it, so `sportsbook.ts reconcileMethodProbs` sees
the same invariant from either path, and because the per-round breakdown
distributes each method's total by that method's round share,
`prob_finish_round_*` follows the new totals instead of drifting from them.

Timing is untouched. The fitted hazards still decide WHEN a finish lands;
only HOW MUCH finish mass there is to place changed.

---

## Rejected, and why

| thing | verdict | reason |
|---|---|---|
| **Per-side absolute levels (185 cols)** | not shipped | GATE 0 tie: 0.7633 vs 0.7627 over three seeds, for 65 extra columns. Built and kept behind `USE_LEVELS` |
| **Val-fitted class-prior correction** | refused | Improves the window it was fitted on by 0.005 and costs test 0.009. Circular by construction — it cannot be selected by val |
| **Train-fitted class-prior correction** | no-op | Weights come out at 1.000; the model already reproduces its training base rate exactly |
| **Recency weighting (4–12y half-life)** | refused | Helps test at every half-life and val declines to select it. Taking it would be reading the test set |
| **Keeping any anchor** | refused | λ swept 0.00–0.60 on val, selected 0.00 on all three seeds |
| **Serving the model on debut bouts** | not done | Never fitted on a row where one side's career columns are entirely NaN, and that segment already routes to its own specialist |
| **Claiming an ROI edge** | refused | +6 % with a [−6 %, +18 %] bout-bootstrap interval is "stopped paying the overround", not an edge |
| **Claiming we beat the method book** | refused | −0.0150 nats with a [−0.0618, +0.0319] interval is parity |
| **A discriminative round-of-finish model** | not attempted | The round leg improved 0.046 nats for free via the rescale. A direct fit is the obvious next lab, and it has no scraped market to be judged against — `bout_external_odds` carries winner and the six method cells only |

## What is NOT changed

* The winner ensemble — same features, same recipe, same blend. Stage 3
  measures its leg at Δ 0.0000.
* `finish_hazard.py`, `decision_model.py` — the decision model is now dead
  weight on the non-debut serving path (the mix supplies the decision share),
  but it still runs the fallback and the debut segment, so it stays.
* `_anchor_methods`, `METHOD_ANCHOR_LAMBDA`, `LEGACY_ANCHOR_LAMBDA` — live
  module-level floats on the no-artifact path, unchanged.
* `stable_hash`, `symmetrize_for_training`, `CLIP_ANCHOR_DATE`.
