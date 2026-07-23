# Graded target lab — a continuous training label for the tail

Branch `lab/graded-target`. Winner model only; the MC path (`monte_carlo.py`,
`finish_hazard.py`, `decision_model.py`) is untouched, `MODEL_VERSION` stays
v0.11.0, the served artifacts are unchanged, and `EnsembleModel.calibrator`
stays `None`.

**Result: nothing ships.** The premise survives Stage 0 — but only weakly, and
only once the market's own confidence is controlled for. None of the three ways
to spend the label passes GATE 1. The soft target, the main candidate, is
stably *worse*; the two variants that improve overall log-loss do it away from
the tail and fail on the split you are allowed to select on; the one static
pass flips sign across seeds.

The lab that came before this one (`docs/tail_resolution.md`) attacked `X` —
features, recalibration, blend selection — and closed at most 0.0022 of the
0.0229 log-loss gap to the closing line. This one is the first to touch `y`.
It closes less.

---

## 0. GATE 0 — does under-confidence coincide with blowouts?

The premise: the binary label spends one bit on a 90-second knockout and a
split decision alike, so the model has no gradient separating matchups that
produce blowouts from matchups that produce coin-flips-for-the-favourite.
A graded label can only supply that gradient if the bouts we are timid about
are in fact the more one-sided ones.

Measured as under-confidence `u = market_fav_prob − model_fav_prob` (for the
market's favourite) against five outcome measures of one-sidedness.

**On the static test tail alone (n=180) the premise does not show.** Every
measure lands within 1 SE and the sweep measure points the wrong way:

| measure | close-to-market | most-timid | diff | p |
| --- | --- | --- | --- | --- |
| blowout (finish or sweep) | 0.633 | 0.656 | +0.022 (0.3 SE) | 0.76 |
| favourite finished | 0.444 | 0.500 | +0.056 (0.8 SE) | 0.46 |
| favourite swept (decisions) | 0.436 | 0.368 | −0.067 (−0.6 SE) | 0.55 |

n=180 splits into ~90 a side; a 10 pp effect there is ~1.3 SE. So the probe
also rebuilds the walk-forward pool the recalibration lab used (quarterly
origins 2017–2024, ~3.1k bouts scored strictly before the test boundary) and
pools it with test. That is ~3× the tail rows and turns the raw correlation
significant — but the enlarged basis also exposes **two confounds that most of
the raw signal is made of:**

1. **It is largely the book's number, not our shortfall.** `u` is
   mechanically larger where `market_fav` is larger (our blend is
   under-dispersed, so it falls further behind the further out the book goes),
   and heavier favourites finish more often anyway. Over the whole confidence
   range, `u`'s marginal effect on blowouts (+3.00 z alone) collapses to
   **−0.73 z** once `market_fav` is in the regression.
2. **The winner-conditioned measures have a collider.** Conditional on the
   price, higher `u` predicts the favourite winning *less* (that is our model
   adding real information about *who* wins — `fav_won` vs `u`, −0.73 z), so
   "how the favourite won, given they won" is conditioned on a collider and its
   coefficient is partly induced.

**The gate is therefore read on direction-free one-sidedness — was the bout
lopsided, no matter which way — with `market_fav` controlled.** On the pooled
tail (n=414) that survives both objections:

| measure (market_fav controlled) | `u` coef | z | p |
| --- | --- | --- | --- |
| any_blowout | +4.37 | **+3.23** | 0.001 |
| any_finish | +2.66 | **+2.44** | 0.015 |
| any_sweep (decisions) | +4.57 | **+2.46** | 0.014 |
| any_finish_r1 | +2.20 | +1.88 | 0.060 |
| fav_won | −1.00 | −0.73 | 0.468 |

Both routes to a lopsided bout — the striker's finish and the grappler's sweep
— move together, and `fav_won` stays flat, so this is a genuine
one-sidedness signal and not "finishers finish". **GATE 0 passes**, with the
caveat stated plainly: on the honest static split it is invisible, and it needs
the confound controlled to appear at all. That is a thin mandate, and the
downstream results are consistent with a thin mandate.

Reproduce: `./venv/bin/python scripts/lab_dominance_probe.py --cache --oof`
(~2 min), artifact `artifacts/lab_dominance_probe.json`.

---

## 1. The label

`dominance_a ∈ [0,1]` — how convincingly the raw-DB fighter A won, 0.5 = draw.
Emitted in `export.build_dataset` **beside** `target_a_wins`, never instead;
`src/dominance.py` builds it.

Two anchors fix the whole scale and it is **continuous between them** rather
than a step per bucket, so the learner gets a gradient inside each rung:

- a finish interpolates on elapsed fight-time from 0.95 (instant) to 0.85
  (final horn): R1 finishes mean 0.93, R2 0.90, R3 0.87;
- a decision interpolates on a `0.65·round-margin + 0.35·judge-margin` mix from
  0.85 (unanimous shutout) down: 2-1 unanimous 0.70, majority 0.66, split 0.62.

Round share is the **majority of judges per round**, not points — the 10-8 rate
swings 0.27 % (2010) → 6.34 % (2017) → 2.14 % (2025) and points would import
that drift wholesale.

Three obligations from the brief, all met:

- **Draws and no-contests → exactly 0.5**, not dropped, and `validate()`
  asserts their `winner_id` is still NULL (the 2026-07 repair). 92 NCs + 2
  method-NULL draws + the 62 winner-NULL draws never reach a training row
  (`target_a_wins` is None) but are scored so the column is complete.
- **760 decisions with no card** (881 including pre-2011, where cards are
  *dropped* not flagged): the round term is imputed from the **mean margin of
  the carded decisions of the same method** — unanimous-no-card gets 0.714, not
  a 1.0 shutout, landing at 0.785 between a 2-1 card and a real sweep. Flagged
  `dominance_estimated`.
- **8 bouts** with `scheduled_rounds=3` but five judged rounds: the elapsed
  fraction uses `max(scheduled, judged)` as the horizon, so they never exceed 1.

One case the brief did not anticipate: on **64 split decisions the per-round
majority favours the loser** (three judges each give the winner two rounds
while picking *different* rounds). That is real structure, but a label that put
the recorded winner below 0.5 would contradict `target_a_wins` on its own row,
so a win floors at 0.55 in the winner's orientation (`dominance_floored`).

**Era trend.** Mean dominance drifts down −0.00176/yr (p<0.0001, r²=0.60), but
that is the well-known **finish-rate decline** (76 % of bouts finished in 2005,
~50 % since 2014), not judging drift: decisions-only the slope is −0.00054/yr
(p=0.035) and within the cards era (2012+) it is not significant (p=0.099).
Left un-normalized and recorded as a limitation — normalizing by era would
smear the genuine finish-rate signal the label is meant to carry.

**Symmetrization** is the one place a bug would hide. `symmetrize_for_training`
flips ~50 % of rows to break the scrape convention (winner in slot A ~95 % of
the time); `dominance_a` has no `dominance_b` partner so the generic pair-swap
never sees it and it is mirrored by hand in both `symmetrize_for_training` and
`swap_sides`, with in-code asserts on mean-0.5 and sign-agreement. Measured on
the built frame: **mean 0.5022, corr with target 0.9549**, and after
`swap_sides` the mean mirrors to 0.4978.

**The ban.** `tests/test_dominance.py` pins that no feature is named for the
label *and* that no feature correlates with the label **residual**
(dominance − target — the only thing a leak could carry): worst honest feature
is `diff_vertex_score` at |r| 0.14.

---

## 2. GATE 1 — the three variants

Every variant trains three legs and blends them exactly as `EnsembleModel`
does (best of logreg / mean / softmax-weighted-mean on **binary** val
log-loss), is scored order-averaged on the binary target, and is compared to a
baseline that received the **same treatment** — because a soft model's output
must be remapped to P(A wins) and the previous lab already measured what that
remap alone buys (+0.0022); crediting the graded label for it would be double
counting. Seeds 42/7/13, static split and rolling retrain.

Learner support was measured, not assumed: LightGBM `cross_entropy` takes a
continuous label; **CatBoost `Logloss` does not** on 1.2.10 ("Target with
classes must contain only 2 unique values") — the probabilistic loss is
`CrossEntropy`; sklearn `LogisticRegression` refuses continuous labels, and it
carries 0.80 of the blend, so both escapes were tried (keep it binary, or
row-duplicate `(y=1,w=d)+(y=0,w=1−d)`).

### Per-bucket, seed 42, model log-loss (lower is better)

| bucket | n | market | **binary base** | base+cal | soft s=1 +cal | ordinal +cal | weighted α0.5 +cal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.50–0.55 | 83 | 0.6873 | 0.6688 | 0.6701 | 0.6701 | 0.6645 | 0.6699 |
| 0.55–0.62 | 121 | 0.6759 | 0.6853 | 0.6939 | 0.6955 | 0.6898 | 0.6943 |
| 0.62–0.72 | 184 | 0.6582 | 0.6569 | 0.6600 | 0.6606 | 0.6589 | 0.6599 |
| **0.72+** | 180 | 0.4392 | **0.5152** | 0.4954 | 0.4966 | 0.4955 | 0.4934 |
| overall | 568 | 0.5968 | 0.6198 | 0.6165 | 0.6175 | 0.6145 | 0.6159 |

The tail-bucket movement in the calibrated columns (0.5152 → ~0.495) is the
**recalibration** from the previous lab, present in *every* column including the
plain binary baseline. The graded label's own contribution is the difference
between a variant and `base+cal`, and it is small and mostly the wrong sign.

### Murphy decomposition (odds subset, seed 42)

| model | reliability | resolution | brier |
| --- | --- | --- | --- |
| binary base (raw) | 0.00296 | 0.03812 | 0.2149 |
| binary base +cal | 0.00355 | 0.03902 | 0.2133 |
| soft s=1 +cal | 0.00262 | 0.03785 | 0.2138 |
| ordinal +cal | 0.00275 | 0.03942 | 0.2140 |
| weighted α0.5 +cal | 0.00330 | 0.03966 | 0.2131 |

No variant lifts resolution beyond what recalibration already does, and none
buys resolution at the cost of reliability — reliability stays ~0.003
throughout. There is simply no resolution to add: the label does not sharpen
the tail, it compresses it.

### Which won on val — none

| variant | val ll (cal) | test ll (cal) | vs base+cal | tail sign across seeds |
| --- | --- | --- | --- | --- |
| binary base | 0.6038 | 0.6165 | — | — |
| **soft s=1 logreg=binary** | 0.6023 | 0.6175 | **+0.0010** | stable, WORSE |
| soft s=1 logreg=duplicate | 0.6038 | 0.6175 | +0.0009 | flips |
| ordinal 6-level | 0.6090 | 0.6145 | −0.0020 | **flips** |
| weighted α=0.5 | 0.6030 | 0.6159 | −0.0006 | **flips** |
| weighted α=1.0 | 0.6028 | 0.6162 | −0.0003 | flips |

- **soft target (the main candidate) is stably worse.** The label tops out at
  0.85, so a model fit to it under-commits *further*; the tail bucket degrades
  by +0.007 to +0.10 raw and, after the remap that undoes most of that,
  still +0.0010 to +0.0030 overall on all three seeds. The `logreg=duplicate`
  escape is far worse raw (tail +0.10) and collapses to the binary escape after
  calibration — the map exactly undoes the compression the duplication caused.
- **ordinal** is the only variant to improve overall test log-loss
  (−0.0020 static vs base+cal, −0.0045 rolling), but: (a) its gain is **diffuse,
  not in the tail** — the tail-bucket sign *flips* across seeds; (b) it is
  **worse on val** (0.6090 vs 0.6038), so it could never be selected
  prospectively; (c) accuracy drops 0.6690 → 0.6655. It fails GATE 1 on a, c,
  d, and e.
- **weighted α=0.5 +cal** is the single configuration that passes all of
  a–e on seed 42 — and its overall sign **flips** across 42/7/13
  (−0.0006 / +0.0006 / +0.0013). GATE 1(g) is the honest killer: it was
  sampled, not measured.

### Gate readout

| condition | requirement | best candidate | verdict |
| --- | --- | --- | --- |
| a | val log-loss improves | ordinal worse on val; soft/weighted improve only via the shared remap | **FAIL** (ordinal) / not-from-label (soft) |
| b | 0.50–0.55 bucket held | ordinal holds it; soft/weighted degrade it | mixed |
| c | 0.72+ improves clearly | tail sign flips across seeds for every candidate | **FAIL** |
| d | accuracy not down | ordinal 0.6690 → 0.6655 | **FAIL** (ordinal) |
| e | reliability not up | soft holds it; ordinal/weighted raise it on rolling | mixed |
| f | holds on rolling too | ordinal/weighted improve overall, still not in the tail | partial |
| g | sign stable over seeds | the one static pass flips | **FAIL** |

Not one candidate clears every condition at once. The lab does not ship.

---

## 3. §4 — style confound: is any effect a striker premium?

Dominance is entangled with style: a grappler wins 3-0 without threatening a
finish, a striker wins by knockout, and two equally decisive wins get different
labels. The risk is that a soft model learns "trust finishers" rather than
"bigger class gap", which on serving would be a new skew — over-confidence in
punchers, under-confidence in grapplers.

Measured directly (`lab_graded_style.py`): the soft-vs-binary confidence shift
on the favourite, split by the favourite's career finish rate.

| favourite style | n | mean finish-rate | conf. shift | Δ log-loss |
| --- | --- | --- | --- | --- |
| grappler (low fr) | 181 | 0.207 | −0.0006 | +0.0017 |
| mixed | 210 | 0.604 | +0.0013 | −0.0000 |
| finisher (high fr) | 151 | 0.955 | +0.0002 | +0.0012 |

**corr(favourite finish-rate, confidence shift) = +0.04.** The shift is tiny
(mean |shift| 0.005) and even across the finish-rate range. So the label is
**not** paying strikers a premium — the confound the brief feared did not
materialise. But the same table says why: after calibration the label is barely
doing anything at all, in any style bucket.

---

## 4. Scoreboard against the 0.0229 gap

Comparing each candidate to the **same-treatment** baseline (the only honest
comparison), on the two bases:

| candidate | static Δ overall | rolling Δ overall | share of 0.0229 | ships? |
| --- | --- | --- | --- | --- |
| soft s=1 +cal | +0.0010 (worse) | +0.0030 (worse) | negative | no |
| ordinal +cal | −0.0020 | −0.0045 | ~9–14 % | no — fails a/c/d/g |
| weighted α0.5 +cal | −0.0006 | −0.0016 | ~3–6 % | no — sign flips |

The most favourable reading — ordinal on the rolling basis — closes about the
same fraction of the gap as the previous lab's recalibration did, and it does
it **away from the tail** (the tail bucket's sign is unstable), at the cost of
accuracy and val log-loss. It is not the resolution win the lab set out to find.
The ~89 % of the gap that `docs/tail_resolution.md` attributed to information
the model does not have is still information the model does not have: a
relabelling of the same 6,429 rows does not create it.

---

## 5. Rejected, with reasons

| # | Idea | Why rejected |
| - | ---- | ------------ |
| 1 | Soft target (LGB/CB cross-entropy), logreg kept binary | Stably worse on all three seeds; label tops at 0.85 so the model under-commits further, tail degrades. |
| 2 | Soft target, logreg via row-duplication | Worse raw (tail +0.10), identical to #1 after the remap — duplication's compression is exactly undone by calibration. |
| 3 | Sharpening the label (s = 0.5 / 0.75 / 1.0) | Every setting worse than the calibrated binary baseline; more sharpening → more tail degradation, not less. |
| 4 | Ordinal 6-level multiclass | Only overall-improving variant, but improvement is diffuse (tail sign flips), it is worse on val so unselectable, and accuracy drops. |
| 5 | Row weighting by \|dominance−0.5\| | α=0.5 passes a–e on seed 42 and flips sign across seeds; α=1.0 degrades the coin-flip bucket. |
| 6 | Reading GATE 0 on the static tail (n=180) | Underpowered — every measure within 1 SE; the premise needs the pooled basis to appear. |
| 7 | Reading GATE 0 on raw `u` correlation | It is mostly the market's confidence; controlling `market_fav` collapses it. Only direction-free one-sidedness survives. |
| 8 | Winner-conditioned dominance measures | Conditioning on `fav_won` is conditioning on a collider (u predicts fav-won-less at fixed price); coefficient partly induced. |

---

## 6. Reproducing

```
cd scripts/simulation
./venv/bin/python scripts/lab_dominance_probe.py --cache --oof   # Stage 0 (~2min)
./venv/bin/python scripts/lab_graded_target.py  --cache --seeds 42,7,13 --rolling
./venv/bin/python scripts/lab_graded_style.py   --cache          # §4
./venv/bin/python tests/test_dominance.py                        # the ban + the scale
```

Artifacts: `artifacts/lab_dominance_probe.json`,
`artifacts/lab_graded_target.json`, `artifacts/lab_graded_style.json`. The
graded frame is cached at `data/dataset_dominance.parquet` (gitignored,
rebuildable); the production `data/dataset.parquet` and the served ensemble
were restored bit-for-bit after the run, and `run_train.py` was exercised
end-to-end to confirm the Sunday retrain is unaffected — the `dominance_a`
column rides on the frame but `build_feature_matrix` selects features by name,
so training metrics are identical (test ll 0.621).

Untouched: `CLIP_ANCHOR_DATE`, `stable_hash`, `ROUND_STATS_SQL`, the MC path,
`bout_change_event`, the scrapers, and `MODEL_VERSION`.

## 7. Next lever (context, not done here)

If the tail is genuinely information-starved rather than gradient-starved, the
remaining lever is the training regime, not the label: 19,386 non-UFC bouts
where both sides are known (~9,700 pairs vs 6,429 UFC rows), 72 % finish rate
vs 53 % in the UFC. UFC matchmaking builds competitive fights by design, so the
blowout regime is structurally under-represented exactly where the model is
weak. The graded label built here would carry straight over to those rows —
which is the one durable thing this lab leaves behind.
