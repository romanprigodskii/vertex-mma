# Method-leg lab — the mix, not the model

Branch `lab/method-leg`. Question: the fixed-odds book has been losing to the
closing method line by ~0.10 nats since the market was first backtested. Six
labs had been spent on the WINNER leg and all six closed at zero. Was the
method leg ever the smaller problem?

**Headline: it was the bigger one, and a partial fix shipped.** The deficit
is 82 % conditional mix and 18 % winner level. A discriminative fit on the
winner model's own feature matrix takes **0.066 nats** off the 6-cell
log-loss on the held-out window — about two thirds of the gap to the closing
line. The book is still ahead. Flat-stake ROI against the closing method
lines improves from −26.5 % to −16.7 % and stays negative. Two of the other
three legs move with it: `distance` by 0.014 nats, `total_rounds` by 0.017.
The winner leg moves by exactly 0.0000, which is the check that this is a
mix change and not a re-scoring of the book. The round SHAPE turns out to
have no lever at all (§8) — the simulator's fixed per-length curves beat a
constant by 0.0035 nats, and a per-bout model cannot clear the gate.

**And the lab caught itself.** The first pass reported roughly triple those
numbers and a model that overtook the market. Its largest feature by gain was
`is_title_fight`, which turns out to be a scraped post-fight BONUS flag —
`§7` below. Everything here is the post-removal re-gate.

Shipped as v0.12.0: `src/method_model.py`, `artifacts/method_model/` (+ the
split-trained twin), and an optional `method_mix` on
`monte_carlo.simulate_bout` that replaces `METHOD_ANCHOR_LAMBDA` on the
non-debut segment.

Reproduce:

```bash
cd scripts/simulation && source venv/bin/activate
python scripts/lab_method_leg.py --stage all      # decompose → gate0/1/2 → legs → leak → rounds
python scripts/eval_method_market.py              # from shipped artifacts
python scripts/eval_method_market.py --legacy     # pre-round-lab config
python tests/test_method_leg.py
scripts/scraper/venv/bin/python scripts/scraper/tests/test_title_belt.py
```

---

## 1. What the round lab left behind

`docs/round_lab.md` re-fitted two things inside the simulator — the finish
timing hazards and the decision-winner split — and closed the method gap from
0.121 to 0.096 nats. Both fixes were real (the incumbent decision logit was
six times worse than a coin flip). Neither touched the shape of the problem:
the method mix is still produced by `monte_carlo.simulate_bout` from the ten
hand-shrunk fields of `FighterMC`, pushed through hand-set lift formulas, and
then shrunk 40 % toward the UFC base rates.

Ten fields. The winner ensemble consumes 118. Nothing in `FighterMC` is
weight class. Nothing in it is gender. No reach, no opponent-adjusted rating,
no Elo, no Glicko, no pre-UFC record.

That is a plumbing hypothesis, not a modelling one, and it is falsifiable.

---

## 2. Stage 0 — split the deficit before spending anything

Every 6-cell distribution factorises exactly:

```
LL(6-cell) = LL(winner side) + LL(method | winner side)
```

so the gap to the book splits cleanly into a half the ensemble owns and a
half the simulator owns. Held-out test window, n=566 gradeable bouts carrying
a coherent 6-cell book:

| | 6-cell | = winner | + conditional |
|---|---|---|---|
| production, pure | 1.6028 | 0.6172 | 0.9856 |
| production, edge-guarded | 1.5952 | 0.6096 | 0.9856 |
| devigged market | 1.4966 | 0.5989 | 0.8977 |
| **gap (pure)** | **0.1062** | **0.0183** | **0.0879** |

Substituting the market's own mix onto our winner level scores 1.5149 — so
the mix alone is worth 0.088 nats, about 4.8x the winner-leg gap that
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

## 3. GATE 0 — kill test: **PASS**

If the simulator is already extracting what record and stat features hold,
a direct fit cannot help and the lab stops. Discriminative
P(ko/sub/dec | this side wins, X), three learners mirroring `ensemble.py`,
trained strictly before `TRAIN_END`, scored on the 2024 val window (n=428,
train n=5,340), seeds 42/7/13.

| | val log-loss |
|---|---|
| constant base rates | 0.9904 |
| MC production mix (λ=0.40) | 0.9449 |
| diffs only, 119 columns | 0.8966 |
| **with per-side levels, 184 columns** | **0.8870** |

The MC reference reproduces the round lab's own number for this window
(0.9456 at λ=0.40) to three decimals, so this is the real production path
rather than a re-derivation of it.

Where the gain comes from, run as ablations rather than asserted:

| | val log-loss |
|---|---|
| constant base rates | 0.9904 |
| MC production mix | 0.9449 |
| context only — 13 columns, no fighter stats at all | 0.9577 |
| random instead of winner-first orientation | 0.9226 |
| full, winner-first | 0.8870 |

Context alone — weight-class one-hots, gender, `scheduled_rounds`,
main-event — does **not** beat the simulator (0.9577 vs 0.9449). It is worth
0.033 nats over a constant, which is real but modest; the simulator's
blindness to weight class costs it less than the first pass of this lab
claimed. Conditioning on the winner is worth 0.035. The rest, ~0.036, is
fighter style read through a learned functional form instead of a hand-set
lift formula — and that is where the per-side levels earn their place.

**Falsification.** Shuffling the method labels within train collapses the fit
to 0.9910 against the constant's 0.9904. No residual slot artefact, no leak
of the kind a shuffle can detect (it cannot detect §7 — see there).

---

## 4. GATE 1 — held out: **PASS**

Same recipe, scored on bouts it has never seen (≥ 2025-01-01, n=664
gradeable, 566 with a coherent book). The new mix is reconciled to the SAME
ensemble winner level production uses, so the comparison isolates the mix.

| | 6-cell | = winner | + conditional |
|---|---|---|---|
| production, pure | 1.6028 | 0.6172 | 0.9856 |
| production, edge-guarded | 1.5952 | 0.6096 | 0.9856 |
| **new, pure** | **1.5372** | 0.6172 | **0.9200** |
| **new, edge-guarded** | **1.5295** | 0.6096 | **0.9200** |
| devigged market | 1.4966 | 0.5989 | 0.8977 |

On all 664 gradeable bouts (not just the odds-covered subset) the conditional
mix goes 0.9708 → 0.9106.

Paired bootstrap by bout, 4,000 resamples:

* production − new (pure): **+0.0656 nats [+0.0385, +0.0937]**, improves in
  100.0 % of resamples.
* new (guarded) − market: **+0.0330 nats [+0.0039, +0.0629]**.

The second line is the honest limit. The interval excludes zero **in the
book's favour** — we are measurably still behind it, having closed about two
thirds of the gap (0.0986 → 0.0330).

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
| 0.00 | −26.5 % [−39.0, −13.8] | −16.7 % [−29.4, −2.8] |
| 0.20 | −23.3 % [−39.7, −6.5] | −10.8 % [−29.4, +10.1] |

Better, still losing. Against a bet-every-cell baseline of −22.8 % (the
overround), the model at EV>0 is no longer clearly worse than blind betting
but is not beating it either. Per method at EV>0.05, from the shipped
artifacts: decisions −5.7 %, KOs −11.6 %, submissions −49.5 %. The
submission cell is the weakest by a distance, consistent with everything
Stage 0 found.

---

## 5. GATE 2 — the marginal deviation is drift

| window | | ko | sub | dec |
|---|---|---|---|---|
| train | pred | 0.330 | 0.190 | 0.480 |
| | actual | 0.331 | 0.190 | 0.479 |
| val | pred | 0.326 | 0.178 | 0.496 |
| | actual | 0.273 | 0.166 | 0.561 |
| test | pred | 0.339 | 0.164 | 0.497 |
| | actual | 0.318 | 0.184 | 0.498 |

The model reproduces its own training base rate to three decimals, so there
is no class shrink to correct. The two out-of-sample deviations point in
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
| prior correction, val-fitted | 0.8775 | 0.9157 | circular |
| prior correction, train-fitted | 0.8872 | 0.9096 | no-op (w = 1.000) |
| recency weighting, 4 / 6 / 8 / 12y | 0.8876+ | 0.9106+ | val says no, and test agrees |

The val-fitted prior correction is the trap this gate exists to catch: it
improves val by 0.010 and costs test 0.006, because it fits 2024's outlier
mix and 2025–26 reverts. It is recorded but can never be *selected* by val —
weights chosen to make the val marginal exact make a val improvement
arithmetic, not evidence.

The selection margin is 0.005 nats. The first run of this gate "selected" a
0.0004 val wobble, which at n=428 is a coin landing the right way up.

Per-cell reliability holds across the range (predicted
3.3/7.5/12.4/17.4/24.5/34.2/44.8 % against actual
2.3/7.1/11.7/14.6/25.5/36.8/53.9 %); the top bin has one cell in it and says
nothing.

---

## 6. Stage 3 — three legs move, not one

`computeSportsbookOutcomes` prices winner, method, `total_rounds` and
`distance` from ONE reconciled distribution. P(distance) *is* the method
market's P(decision), and the per-round finish curve is rescaled to the
reconciled finish total so the three cannot be arbitraged against each other.
Each leg graded exactly as `settleSelection` grades it, held-out, n=664:

| leg | constant | production | new | Δ |
|---|---|---|---|---|
| winner | 0.6931 | 0.6066 | 0.6066 | **+0.0000** |
| distance_yes | 0.6939 | 0.6734 | 0.6595 | +0.0139 |
| under_2_5 | 0.6783 | 0.6590 | 0.6416 | +0.0174 |

Note what this says about WHERE the gain lives. The conditional mix improves
by 0.066 nats but `distance` — the finish-vs-decision split — improves by
only 0.014. Most of the model's edge over the simulator is in reallocating
between KO and submission GIVEN a finish, not in knowing whether the fight
ends at all. The "goes the distance" market remains close to what the
simulator already knew.

The winner leg moves by exactly 0.0000. That is the control.

Only the method leg has a scraped closing line, so `distance` and
`total_rounds` are scored against the train base rate. Those are internal
improvements and are labelled as such.

---

## 7. Stage 4 — the leak this lab found in its own result

`is_title_fight` was the method model's single largest feature by gain in the
first pass. It is not known before the fight.

`scripts/scraper/src/parsers/event_details.py` read
`cells[6].css_first("img") is not None` as "this bout has a belt". UFCStats
renders the belt icon **and the post-fight bonus icons** — Performance of the
Night, Fight of the Night — in that same weight-class cell. So the column
marks bonuses:

| rounds | flag | n | finish % |
|---|---|---|---|
| 3 | false | 6,054 | 41.3 % |
| 3 | **true** | **1,854** | **84.1 %** |
| 5 | false | 218 | 40.4 % |
| 5 | true | 682 | 65.7 % |

A title fight is five rounds, always, so 1,855 three-round "title fights"
cannot be titles. The flag sits at 26–34 % of completed bouts per year
against a real title rate near 5 %. And bouts that have not happened yet
carry it at 3 % — no bonus has been awarded to them — so it is a train/serve
skew on top of a leak.

It is a leak of **this** target specifically: bonuses go to finishes.

| arm | val | test conditional |
|---|---|---|
| with the leak | 0.7642 | 0.8613 |
| without (ships) | 0.8966 | 0.9293 |
| MC production | — | 0.9708 |
| constant base rates | — | 1.0234 |

Worth 0.132 nats on val and 0.068 on test, none of it available at serve
time. **The result survives its removal** — but it shrank by about two
thirds, the variant choice flipped (per-side levels had nothing to explain
while a finish oracle was in the matrix), and the claim that the model
overtook the closing line was withdrawn.

Two things worth recording about how it was found. The label-shuffle
falsification in GATE 0 **passed** with the leak present, because shuffling
the target destroys the feature's usefulness along with everything else — a
shuffle test cannot detect a legitimate-looking feature that encodes the
outcome. What caught it was a serving-time sanity check: the model predicted
62 % decisions on the upcoming slate against 54 % on the test window, and the
only input that differed that much between them was this flag.

And the winner ensemble is unaffected: `is_title_fight` ranks 114 of 118 by
gain there, at 0.0 %. "This bout ended in a finish" says almost nothing about
WHO won, which is why the corruption survived six labs and only surfaced when
a model was pointed at the method.

Fixed at the source in `utils/weight_classes.is_belt_image` (match the belt
by filename, not "any image"), pinned by
`scripts/scraper/tests/test_title_belt.py`, and excluded from the model by
`method_model.LEAKING_COLUMNS` so the two cannot drift apart. The 1,855
existing rows are **not** repaired — that needs a re-scrape or a rewrite from
`src/lib/title-fights.ts`, the curated list `derive_title_fights.ts` already
builds precisely because the scraped flag "can't be trusted".

---

## 8. Stage 5 — the round leg has no lever: **FAIL**

The round market looked like the obvious next target, and for a structural
reason. Every covariate in `finish_hazard.py` is time-constant, so
`_normalize_shape` divides it back out: the served timing is **two fixed
curves per scheduled length, identical for every bout on the card**. Flipping
`is_title_fight` on an otherwise identical bout moves the curves by 1.7e-18
(pinned in `tests/test_method_leg.py`). A per-bout model should have
resolution the hazard structurally cannot express.

It does not. Discriminative P(round | a finish happened, X) over the same
184-column matrix, three seeds, both orientations averaged, scored on 333
held-out finishes:

| | val | test |
|---|---|---|
| constant — train rate by scheduled length | 1.1073 | 1.0437 |
| production hazard curves | 1.1025 | 1.0402 |
| discriminative model | 1.0938 | 1.0289 |

**Read the first two lines before the third.** The fitted hazard beats a
constant — one number per scheduled length, no per-bout input whatsoever — by
0.0035 nats. That is the entire per-bout signal the round distribution
contains. The round lab's headline (1.0218 fitted vs 1.4585 incumbent) was a
fix for a curve that pointed the wrong way, not evidence that round timing is
predictable.

The model's 0.0113-nat edge fails on both counts: below the 0.02 val margin,
and a paired bootstrap of [−0.0060, +0.0280] straddling zero. At 333 test
finishes an effect that size is not resolvable.

| 3-round finishes (n=291) | R1 | R2 | R3 |
|---|---|---|---|
| actual | 54.3 % | 30.6 % | 15.1 % |
| hazard | 49.0 % | 32.1 % | 18.9 % |
| model | 50.2 % | 33.5 % | 16.3 % |

The model moves toward the truth by about two points in round 1 and stops.

So `total_rounds` has no lever left on the round SHAPE. Its remaining loss is
the finish-vs-decision TOTAL — which the method model already moves (§6) and
which is bounded by the same ceiling as everything else.

---

## 9. What shipped, and what it replaced

| | before | after |
|---|---|---|
| method mix source | `_ko_total_loghaz` / `_sub_total_loghaz` lift formulas over 10 `FighterMC` fields | `MethodModel.predict_cond` over 184 features |
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
| **`is_title_fight` as a feature** | removed | A post-fight bonus flag, not a belt. §7 |
| **Repairing the 1,855 corrupted rows** | not done here | Needs a re-scrape or a rewrite from the curated title list, with its own verification. The parser fix stops the bleeding |
| **Val-fitted class-prior correction** | refused | Improves the window it was fitted on by 0.010 and costs test 0.006. Circular by construction |
| **Train-fitted class-prior correction** | no-op | Weights come out at 1.000; the model already reproduces its training base rate exactly |
| **Recency weighting (4–12y half-life)** | refused | Val declines to select it and, once the leak was removed, test agrees |
| **Keeping any anchor** | refused | λ swept 0.00–0.60 on val, selected 0.00 on all three seeds |
| **Serving the model on debut bouts** | not done | Never fitted on a row where one side's career columns are entirely NaN, and that segment already routes to its own specialist |
| **Claiming we beat the method book** | refused | +0.0330 nats [+0.0039, +0.0629] is measurably behind it |
| **Claiming an ROI edge** | refused | −16.7 % is an improvement on −26.5 % and still a loss |
| **A discriminative round-of-finish model** | GATE 5 fail | 0.0113 nats on 333 test finishes, bootstrap [−0.0060, +0.0280]. The hazard already beats a per-length CONSTANT by only 0.0035 — there is almost no per-bout signal in round timing to find. §8 |
| **Re-fitting `finish_hazard.py` without the leaked flag** | not done | Its covariate value is provably divided out of the served shape (1.7e-18, pinned by test). Whether its presence during FITTING moved the shared time-basis is untested, and §8 shows the whole covariate block is worth 0.0035 nats, so the upside is bounded by roughly that |

## What is NOT changed

* The winner ensemble — same features, same recipe, same blend. Stage 3
  measures its leg at Δ 0.0000.
* `finish_hazard.py`, `decision_model.py` — the decision model is now dead
  weight on the non-debut serving path, but it still runs the fallback and
  the debut segment, so it stays. Note that `finish_hazard.py` takes
  `is_title_fight` as a covariate and therefore inherits §7; its timing
  curves are time-constant per scheduled length, so the exposure is small,
  but it has not been re-fitted here.
* `_anchor_methods`, `METHOD_ANCHOR_LAMBDA`, `LEGACY_ANCHOR_LAMBDA` — live
  module-level floats on the no-artifact path, unchanged.
* `stable_hash`, `symmetrize_for_training`, `CLIP_ANCHOR_DATE`.
