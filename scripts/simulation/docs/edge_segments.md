# Where does the model beat the book — 87 slices, one survivor, and a scraper that is lying

Branch `lab/edge-segments`. The question: the model's probabilities differ
from the closing line constantly, so there ought to be pockets — a boxer
against an all-rounder, an ageing striker against a younger one, style
matchups with age constraints — where our number is the better one.

**Headline. Against bouts the book priced with equal confidence, exactly one
pre-registered segment out of 84 beats the closing line after multiplicity:
a fighter on a win streak of 4 or more** (Δ_adj −0.064, se 0.018, BH
q = 0.016; seed-stable at −0.045 to −0.052 over five seeds; on 2025-26 the
sign holds at −0.030 with ROI +8.1 %). **None of the 20 style or style×age
segments survives** — the best, a wrestler against elite takedown defence,
reaches p = 0.079 and q = 0.52. The largest effect in the lab is not a
segment at all but a direction: the model under-rates the market's
favourite by 6.4 pp on average, and on the ~16 % of priced bouts where it
nevertheless gives that favourite ≥5 pp more than the book, flat-staking
the favourite returned **+11.5 % over 281 bets across 163 events**
(bootstrap CI [+2.3 %, +20.4 %], P(ROI ≤ 0) = 0.007).

Every claim was then handed to an independent skeptic told to refute it.
That pass **changed the headline twice** and is the reason this document
reads the way it does — §8 is the list of what it cost. The short version:
one statistic in this lab was computed wrong (§8.1), the odds are not the
closing line the repo says they are (§8.3), and the project's own odds
backfill is currently writing *upcoming* fights' prices into historical
rows (§8.4).

---

## 0. The ceiling, first

`accuracy_batch.md` §0 established the habit of stating what an instrument
can see before reporting what it saw. Here the instrument is small, and
saying so up front changes how every table below reads.

| quantity | value |
|---|---|
| walk-forward OOF bouts, 2016-2026, 5 seeds | 4,141 |
| …of which have an archived market price | **1,787** (225 events) |
| discovery window (< 2025-01-01) | 1,191 |
| confirmation window (2025-2026) | 596 |
| segments scored | 87 (84 pre-registered + 3 post-hoc) |
| median segment size | 213 bouts |

A paired log-loss gap of 0.045 nats on a 200-bout slice means being about
**15 percentage points closer to the truth than the market** on those
bouts. Nothing that large exists in a liquid market. On the money side, a
flat-stake ROI on 200 bets has a cluster-robust standard error near 7 %, so
the detectable return is **+17.6 %**.

The consequence, quantified by the verification pass: with an *oracle*
model that knows the mispricing exactly, the paired test has **10-15 %
power against a 3 pp edge and 18-31 % against 5 pp — falling to 0-1 % once
BH multiplicity is charged.** Detecting a 3 pp edge this way needs ~89,900
bouts. There are 1,787.

So the raw per-segment log-loss comparison — the intuitive test, and the
one this lab was opened to run — was underpowered by construction. What
found something was the composition-adjusted contrast (§3) and the money
column, not the raw Δ.

**The ceiling is not a scraping gap.** Running the full history backfill
(682 events) added **20 bouts** — and revealed why (§8.4).

---

## 1. The de-vig overstates longshots

`export.py` turns two decimals into `market_prob_a` by splitting the
overround proportionally: `pa / (pa + pb)`. Books load margin onto the
longshot instead, and on this sample they demonstrably do:

| where | implied | actual | miss | z |
|---|---|---|---|---|
| underdog, raw vigged price | | | +2.9 pp | +2.55 |
| underdog, proportional de-vig | | | +1.2 pp | +1.05 |
| underdog, power de-vig | | | +0.1 pp | +0.07 |
| **proportional, genuine longshots (p < 0.30, n = 480)** | 22.9 % | 18.3 % | **+4.5 pp** | +2.51 |

Flat-backing those sub-0.30 dogs returns −26 % against a 4.8 % overround.
This lab scores against the power de-vig and keeps `market_prop` in the
frame so the numbers reconcile with the rest of the repo.

**What is NOT evidence for this, and was the first draft's evidence:** the
regression slope of the outcome on the market logit — 1.163 (proportional)
vs 1.063 (power) vs 1.096 (Shin). `logit(p_power) = 1.101 · logit(p_prop)`
with R² = 0.99944; the two are the same estimate rescaled (bootstrap
correlation 0.9998), and the p-value contrast is the
difference-in-significance fallacy. A null simulation in which the
proportional de-vig is TRUE by construction still returns a power slope of
0.908 ± 0.068. The direction survives on the tail measurement above; the
slope argument does not.

**And it changes nothing here.** Recomputing all segments under both
de-vigs shifts Δ by at most 0.30 of one clustered SE, and `roi_at_close`
never touches the de-vig — every ROI in this document is de-vig-invariant.
The finding matters for `src/export.py`'s edge display, `eval_market.py`
and the sportsbook, which all consume `market_prob_a`.

---

## 2. The grid

86 segments were declared in `lab_edge_registry.py` before any was scored —
84 after two pairs of identical expressions proposed by different lenses
were collapsed. Nine families: style matchups, style×age, physical
durability, market microstructure, activity and layoff, experience and
pedigree, form and momentum, division and context, plus a completeness pass
on what the others missed. Every entry carries a mechanism: why a market
that is very good would be systematically wrong in that exact place.

Three mechanical decisions keep the grid honest:

* **Segments are swap-invariant by construction.** Each is written once for
  the A side; the B-side twin is derived by swapping `_a`/`_b` suffixes and
  membership is the union. A segment that depends on scrape order measures
  slot order.
* **The style taxonomy is point-in-time and fitted on discovery only.** Two
  axes (`strike`: slpm, kd/fight, distance share, accuracy; `grapple`:
  td/15, control/min, sub/15, ground share), median split, four archetypes:
  striker 1,461 / grappler 868 / universal 780 / low-output 462
  fighter-sides. Two axes rather than one spectrum, because "all-rounder"
  is a claim about being high on *both*, which a single striker↔grappler
  axis cannot express. Construct validity was checked adversarially: method
  of victory by the *winner's* archetype is striker 39.8 % KO / 10.7 %
  submission, grappler 22.5 % / 25.9 %, universal 32.9 % / 19.4 %. The
  labels mean what they say, and sharpening them to terciles or quartiles
  strictly loses power.
* **Multiplicity is charged to the pre-registered family only.** The three
  `post_hoc__` rows are excluded in both directions.

---

## 3. The result

Two Δ columns, and the difference between them is the whole section.

**Raw paired Δ** compares the segment to the closing line on its own bouts.
It is dominated by composition: the model is at parity with the book on
coin-flips and loses nearly all of its deficit above 0.72
(`tail_resolution.md`), so any slice heavy in favourites looks bad and any
slice short of them looks good, regardless of merit.

**Composition-adjusted Δ** is the segment against bouts the book priced
with *equal confidence* — a segment dummy plus market-confidence fixed
effects, cluster-robust by event.

| statistic | segments better than the book, BH q < 0.05 | worse |
|---|---|---|
| raw Δ | **0** of 84 | 30 |
| **composition-adjusted Δ** | **1** of 84 | 3 |
| incremental information c₁ | 0 of 84 | 0 |

The raw row is the one that reads as a verdict and is not one: 30 of 84
segments "significantly worse" is mostly the model's known tail deficit
showing up wherever a slice contains heavy favourites.

### The one survivor

`form_momentum__long_win_streak_4plus` — a fighter carrying a win streak of
four or more (`current_streak_a >= 4`, either side).

| | n | events | Δ_adj | se | q | bets | ROI |
|---|---|---|---|---|---|---|---|
| discovery ≤2024 | 198 | | **−0.0637** | 0.0179 | **0.016** | 166 | +9.8 % |
| confirmation 2025-26 | 110 | | −0.0303 | | p = 0.30 | 90 | +8.1 % |
| pooled, seed 42 | 308 | 165 | −0.0521 | 0.0156 | | 256 | +9.2 % |

Seed-stable: Δ_adj −0.0521 / −0.0501 / −0.0470 / −0.0449 / −0.0478 over
seeds 42 / 7 / 13 / 99 / 2024, every one at z ≈ 3. The ROI is +5.2 % to
+9.9 % across seeds, and its cluster bootstrap CI includes zero on every
one of them.

What it is **not**: a streak-fade. On the streaked side both forecasters
overrate the fighter, and the book slightly less — model 0.607, market
0.589, actual 0.581. The gain is discrimination within equally-priced
bouts, not a level correction. Whatever the model knows here, "the market
overvalues momentum" is not a description of it.

### The style hypothesis

Twenty style and style×age segments, none surviving. On the
composition-adjusted statistic 8 of the 20 are on the right side of zero
and none reaches significance:

| segment | n | Δ_adj disc | p | Δ conf | c₁ conf |
|---|---|---|---|---|---|
| wrestler vs elite TDD | 217 | −0.0330 | 0.079 | −0.0200 | +0.22 |
| southpaw vs orthodox | 296 | −0.0189 | 0.232 | +0.0072 | +0.13 |
| ageing grappler vs younger | 125 | −0.0160 | 0.540 | +0.0232 | −0.45 |
| **striker vs universal** (the ask) | 156 | −0.0017 | 0.94 | +0.0045 | +0.31 |
| striker vs grappler | 225 | +0.0229 | 0.19 | +0.0186 | +0.12 |
| **strike-axis gap** | 298 | +0.0207 | 0.13 | +0.0509 | −0.83 |

The pairing the lab was opened for lands at Δ_adj = −0.002 — indistinguishable
from the bouts around it in every direction.

The one style segment that replicates anything is the strike-axis gap, and
it replicates *against* us: on both windows independently and after
composition adjustment, the wider the striking mismatch, the further behind
the market we fall (Δ_adj +0.021 and +0.028, c₁ −0.69 and −0.83; over all
436 such bouts the raw model loses 12.8 % flat-staking). The mechanism is
plausible — a large stylistic mismatch is exactly what film study and a
market's collective read are good at, and our features are
opponent-adjusted *averages* with no interaction term — but it is one
segment out of 84 and it is not significant after multiplicity either.

**And the null is a bound on large effects only.** See §0: at these sample
sizes a 3-5 pp edge would have been invisible. The correct statement is not
"the style hypothesis is refuted" — it is *no style effect large enough to
be seen was seen, and the instrument could not have resolved the sizes that
matter.*

---

## 4. Incremental information

Comparing two log-losses on 200 bouts throws away 95 % of the sample. The
same question with every bout participating:

```
y ~ sigmoid( b·logit(market) + c·logit(model) )        no intercept
```

`c > 0` says the model carries information the market price does not.

| window | n | model | market | c | p |
|---|---|---|---|---|---|
| discovery ≤2024 | 1,191 | 0.6480 | 0.6177 | +0.215 | 0.126 |
| confirmation 2025-26 | 596 | 0.6092 | 0.5892 | +0.469 | **0.012** |
| all | 1,787 | 0.6350 | 0.6082 | **+0.302** | **0.006** |

Per year, fixed-effect pooled: c = +0.315 (se 0.110, z = 2.87).

**Robust to everything that could have faked it.** The walk-forward split
is clean — an independent outside-in replay from the raw DB reproduced
prior record and Elo exactly for all 4,141 pool bouts, no feature carries a
leak-sized univariate AUC (max is `diff_age` at 0.625), the market price is
not a model input, and the model *loses* to the market on both windows,
which is not what leakage looks like. The served age corrector is not the
cause: dropping it makes c **larger** (+0.310). The hand-rolled cluster
sandwich matches a 1,000-replication bootstrap to 2 %. An intercept moves c
by 0.0008. All five seeds give +0.303 to +0.328.

**And overstated in three ways:**

* **One year carries the significance.** Leave-one-year-out leaves c at
  +0.27 to +0.37 (p ≤ 0.025) for every year except one — **dropping 2025
  gives c = +0.188, p = 0.139.**
* **The discovery window alone is not significant** (p = 0.126). The pooled
  p mixes the window the search ran on with the window meant to test it.
* **"No heterogeneity across years" is a power statement.** Simulated power
  of Cochran Q against exactly the spread the yearly estimates show is
  15-31 %.

Meanwhile the model loses outright when the two disagree on the winner: on
the 23 % of bouts where we name a different favourite, the book is right
58.6 % of the time and we are right 41.4 %. Both facts hold at once, and
the resolution is §5.

---

## 5. The blend

Fit `z = b·logit(market) + c·logit(model)` on discovery only, apply
untouched to 2025-2026:

| window | model | market | blend | blend − market | se |
|---|---|---|---|---|---|
| discovery (out-of-fold, folds cut by event) | 0.6480 | 0.6177 | 0.6180 | +0.0003 | 0.0017 |
| confirmation 2025-26 (prospective) | 0.6092 | 0.5892 | **0.5852** | **−0.0040** | 0.0021 |

The unconstrained fit lands at `b + c ≈ 1.2` — the best available forecast
is *more* extreme than the market price, in the direction the model points.
That is the mechanism behind §6.

Verification put a fence around how much of a result this is. No fold
leakage (zero events straddle the boundary). The placebos behave, which is
the strongest evidence the machinery is not manufacturing anything:
replacing the model probability with logit noise gives +0.0016 and −6.5 %
ROI. But **only the pre-declared seed reaches p < 0.05** (z by seed: 42
→ −1.96, 2024 → −1.78, 99 → −1.66, 7 → −1.65, 13 → −1.61); the ROI's own
cluster bootstrap CI is [−1.3 %, +14.9 %] with P(≤0) = 0.051; the +6.8 % is
3.4× the +2.0 % the blend itself predicts, and 47 % of the profit comes
from 27 of 273 bets; the discovery/confirmation contrast is **not** a
regime change (interaction p = 0.27) but an artefact of a discovery window
that is 65 % 2021-22; and run fully out-of-fold over the whole pool the
blend's gain is **−0.0009 nats, CI [−0.0034, +0.0015]**, i.e. nothing.

---

## 6. The largest effect is a direction, not a segment

Oriented on the market's favourite, the model's mean lean is **−6.4
percentage points**: it systematically gives the favourite less than the
book does. Splitting on that lean:

| our lean on the favourite | n | model | market | actual | bet the favourite |
|---|---|---|---|---|---|
| fade hard (≤ −0.10) | 662 | 0.509 | 0.690 | 0.687 | −3.7 % |
| fade (−0.10 … −0.03) | 429 | 0.607 | 0.672 | 0.655 | −6.1 % |
| ~agree | 326 | 0.652 | 0.654 | 0.635 | −6.1 % |
| back (+0.03 … +0.10) | 246 | 0.684 | 0.624 | 0.675 | +4.2 % |
| **back hard (≥ +0.10)** | 124 | 0.728 | 0.577 | 0.685 | **+15.6 %** |

Where we fade the favourite the book is exactly right and we are 18 points
low. Where we back it harder, we are right and the book is 11 points low.
The asymmetry is the model's own under-dispersion: a deviation *against*
its bias is informative, a deviation *along* it is the bias.

| rule: back the favourite when lean ≥ 0.05 | n | events | market | model | actual | ROI | cluster se |
|---|---|---|---|---|---|---|---|
| discovery | 193 | 107 | 0.595 | 0.701 | 0.679 | **+10.0 %** | 5.6 % |
| confirmation 2025-26 | 88 | 56 | 0.621 | 0.732 | 0.727 | **+14.7 %** | 8.2 % |
| **pooled** | **281** | **163** | | | | **+11.5 %** | **4.6 %** |

Bootstrap CI on the pooled ROI, resampling events: **[+2.3 %, +20.4 %],
P(ROI ≤ 0) = 0.007.** In the subset the model is calibrated and the book is
not.

**This is the one claim a serious attempt to break did not weaken.** Ten
attacks, five designed specifically to kill it:

* **The decisive control fails.** Betting *every* favourite in the same
  market-confidence band returns −2.4 % / −2.2 %; reweighted to the
  subset's exact confidence distribution, −9.0 % / −7.1 %; favourites in
  that band *excluding* the subset, −5.2 % / −7.3 %. This is not "bet
  favourites in pick-ems".
* **A confidence-matched placebo is MORE extreme, not less** — P = 0.0015
  matched on confidence deciles, against 0.003 unmatched.
* **No single event carries it**: largest is 12 % of profit, dropping the
  best event still returns +9.0 %, and 12 of 107 events must go before ROI
  reaches zero.
* **It is not the blend re-expressed.** All 193 bouts sit inside "the blend
  leans to the favourite", but that larger set returns −3.7 %, and the
  blend's own deployable rule returns −2.5 % where this returns +10.0 %.
* Robust to all five seeds, to dropping the residual corrector, to either
  de-vig, and to excluding the 45 bouts §8.4 re-priced (+9.7 % / +15.6 %).

**What is weak about it:** it is a money result, not a log-loss one (the
paired Δ on the same bouts is p = 0.24 and 0.66); it is post-hoc, chosen
after the shape was visible — though the discovery sweep is positive at
every cut from 0.02 to 0.22, +10.0 % to +29.6 %, peaking at 0.13; and 281
bets over six years is 26 a year.

---

## 7. What is NOT changed

Nothing ships. `RESIDUAL_CORRECTION` untouched, `export.py`'s proportional
de-vig untouched (§1 is a finding; changing the serving path is a separate
decision with its own regression surface), no blend in `predict.py` — it
needs a live price at predict time, which most upcoming bouts do not have.

---

## 8. What adversarial verification cost

Seven independent skeptics, one per claim plus a code audit and a leakage
audit, each instructed to refute and to default to "refuted" when unsure.
Five of six claims came back WEAKENED; the wording above is theirs.

### 8.1 A statistic in this lab was wrong, and it changed the headline

`bucket_residual_delta` centred each bout on a market-confidence-bucket
mean computed over the **whole frame** — putting the segment inside its own
control group and attenuating the contrast by exactly
(1 − share_of_pool). On a synthetic frame with a true edge of −0.1000 it
reported −0.095 at a 5 % share and −0.060 at 40 %. For the two segments
that *are* a confidence bucket the quantity is not estimable, and it
printed −6.7e−18 with q = 1.000000: an undefined statistic dressed as a
measured null.

Replaced by the textbook estimator (segment dummy + bucket fixed effects,
cluster-robust). Unbiased at every share over 200 replications. **The fix
is what produced §3's survivor** — `long_win_streak_4plus` went from
q = 0.070 to q = 0.016.

Four smaller bugs from the same audit, all fixed: the DIRECTION table
double-counted bouts satisfying both sides (36 of 61 side-naming segments);
the detection floor used the iid sd while p-values used the clustered SE;
`seed_sign_stable` counted the primary seed against itself; and
`--stage scan` printed the confirmation window's headline numbers.

### 8.2 The confirmation window is not perfectly virgin

The served `RESIDUAL_CORRECTION` is applied to confirmation rows. Its
coefficient is fitted on pre-2025 OOF data, but the decision to *ship* it
was taken partly on `rolling_backtest.json`, whose window is
2025-07 → 2026-07 — inside the confirmation window. Magnitude, measured on
`p_uncorrected`: confirmation blend − market goes −0.0040 (z 1.96) →
−0.0031 (z 1.71); pooled c goes +0.3025 (p 0.006) → +0.3000 (p 0.022).
Real, and small.

Two other leaks were found and sized. `vertex_score` is **not**
point-in-time: `compute_opponent_quality.ts` credits opponent tiers for
title reigns that began after the bout, contaminating 755 of 17,644
`bout_opponent_tier` rows and 21.9 % of pool bouts — but decaying to 0 % by
2026, and ablating the whole vertex block costs 0.0011 nats on
confirmation. And `best_params.json` was tuned on the 2024 val window that
the pool later scores (122 of 1,191 discovery bouts).

### 8.3 The prices are not the closing line

`export.py` documents `market_prob_a` as "the CLOSING line" and this lab
inherited the phrase. It is not supported. `bout_external_odds` holds one
row per bout with no history, **2,251 of 2,278 rows have `fetched_at` after
the event date**, and the writer is `run_backfill.py` — whose own docstring
calls what it scrapes "opening lines" and whose parser takes the median
across sportsbook cells of an archived event page. The 6-hourly cron cannot
have written them: it filters `status IN ('scheduled','in_progress')`.

Everything in this document should therefore read "the archived market
price", not "the closing line" — including, by inheritance,
`docs/winner_batch.md`'s gap-to-the-closing-line framing.

### 8.4 `run_backfill.py` is currently corrupting the odds table

Chased down after the leakage audit flagged the provenance. BestFightOdds
no longer serves a historical odds grid on archived event pages. Fetching
`/events/ufc-268-usman-vs-covington-2-2261` (November 2021) and running the
repo's own parser over it returns **132 matchups, none of them from
UFC 268** — they are the sidebar of *currently priced* upcoming events
(UFC 330, UFC Sacramento, ACA 206…), identical on every page. The same
holds for UFC 311.

So the run this lab commissioned fetched 682 pages, harvested the same
upcoming-events sidebar 682 times, and matched it into the DB by name pair
and date proximity. It created 20 rows and touched ~2,000, and **45 of the
1,787 priced bouts now carry a different price than they did before it**
— 42 of them 2026 bouts, 3 pre-2026, two of those moved by more than 18
probability points, which is not a re-scrape of the same fight.

Bounded and measured: every headline number reproduces with those 45
excluded (c = +0.303 p = 0.007; the favourite rule +9.7 % / +15.6 %). But
**do not run `run_backfill.py` again until its parser rejects matchups
whose event does not match the page requested.** As written it will keep
writing today's prices onto historical bouts.

It also clobbers the 6-hourly cron's winner prices with page medians — the
method backfill guards against exactly this with
`UPSERT_PRESERVE_WINNER_SQL`, the winner backfill does not.

---

## 9. What would actually move this

Two of these are cheap and both are about the *price* side, which is where
the measurement is starved — not the model side, which eight prior labs
have already worked over.

1. **Fix the backfill, then stop destroying the line history.**
   `bout_external_odds` is one row per (bout, source) with
   `ON CONFLICT DO UPDATE`, so only one number per bout ever survives.
   Opening line, movement, and therefore closing-line value are
   unrecoverable. An append-only price table would make CLV measurable —
   and CLV separates a real edge from 281 lucky bets on a tenth of the
   sample.
2. **Find out what price we are actually holding.** §8.3 leaves the basis
   genuinely ambiguous, and the difference between beating an opener and
   beating a close is the difference between a business and a curiosity.
   Capturing live prices going forward answers it in one fight week.
3. **A genuine forward test of §6.** The rule is post-hoc; log its picks
   prospectively and read them in a year. At 26 bets a year and an ROI
   standard error near 10 % per 100 bets, that is a two-to-three-year
   answer — worth knowing before anyone sizes a bankroll on it.

---

## Reproducing

```bash
cd scripts/simulation
./venv/bin/python scripts/lab_edge_segments.py --stage pool     # ~10 min, 5 seeds
./venv/bin/python scripts/lab_edge_segments.py --stage scan     # discovery
./venv/bin/python scripts/lab_edge_segments.py --stage confirm  # 2025-2026
```

Artifacts: `artifacts/lab_edge_segments.json` (both windows, every segment,
every statistic). Pools: `data/lab_edge_pool_seed*.parquet`.
