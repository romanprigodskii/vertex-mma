# Regional-regime lab — non-UFC bouts as training rows

Branch `lab/regional-regime`. Winner model only; the MC path (`monte_carlo.py`,
`finish_hazard.py`, `decision_model.py`) is untouched, `MODEL_VERSION` stays
v0.11.0, the served artifacts are unchanged (restored bit-for-bit; `run_train.py`
re-run end to end → test ll 0.621), and `EnsembleModel.calibrator` stays `None`.

**Result: nothing ships — but this is the different one.** Five levers before it
(`round_lab.md`, redundancy, `tail_resolution.md`, blend re-selection + age
throttle, `graded_target.md`) all reworked `X` or the shape of `y` and closed at
zero without ever adding information. This lever is the only one that changed the
information *set*: it feeds the model 9,067 non-UFC career bouts it had never
seen. And for the first time the kill-test **passes** — the non-UFC rows carry
real blowout-regime information and move the held-out UFC tail (Stage 0b),
survive a label-shuffle falsification, and are not a striker skew. It dies one
stage later, on the served ensemble, for a reason none of the previous five
reached: the information is **redundant**, not absent. The best any record-only
model does in the tail (0.550 log-loss) is strictly dominated by the served
ensemble's 0.515, which already resolves the tail from UFC round-stats and
opponent-adjusted ratings the non-UFC population does not have. A dominated leg
can only make the served number worse — it adds a little discrimination but
breaks more calibration than it buys. Both ways of spending it — a fourth blend
leg and a pretrain/fine-tune transfer — fail GATE 1 on the same conditions,
seed-stably.

The sixth independent confirmation of the ceiling, and the most informative: the
residual tail deficit is not information nobody has, it is information *we already
have*. Relabelling or re-sourcing record-shaped data does not create resolution
the opponent-adjusted model already extracts.

---

## 1. The hard constraint that fixed the whole design

`fighter_sherdog_bout` (is_ufc=false) carries **only** `result`,
`method_class` (ko / submission / decision / other), `round`, `time_seconds`,
`event_date`, `opponent_sherdog_id`. There is **not one row** of
`bout_round_stats` behind a non-UFC bout — no significant strikes, no control,
no takedowns, no knockdowns. So none of the features the served ensemble leans
on exist for a non-UFC bout: not the opponent-adjusted ratings
(`opponent_ratings.py`, computed off UFC round stats), not Elo/Glicko, not the
striking-volume / durability / control features, not `vertex_score`.

**Only record-shaped features exist for both populations.** So this lever is
**not** an extension of the served ensemble — you cannot drop 9k rows into the
served feature matrix, 90 % of the columns would be NaN. It is a **record-only
model on a union sample**: the 60-column subset of the served feature list
computable from a fighter's record (career W-L, finish/sub rates, career length,
layoff, recent form, streak, finish speed, `preufc_*`) plus static attributes
(height, reach, age, stance, gender). The UFC-only context (title / main-event /
scheduled_rounds / weight class) is excluded too — it does not transfer.

Record semantics are kept exactly as the served model uses them: `prior_*` is
the UFC record, `preufc_*` the non-UFC record. For a non-UFC training row
`prior_*` is the (usually empty) UFC record before that date and `preufc_*` the
non-UFC record before it — the same two axes, snapshotted the same point-in-time
way, for both populations. `src/regional_export.py` builds the rows in a **single
chronological replay over both populations**: UFC bouts advance each fighter's
`FighterHistory`, non-UFC bouts never do (they carry no round stats and their
outcomes ride on `preufc_*`), and each non-UFC bout snapshots the UFC + non-UFC
record strictly before its date. The UFC-history walk is a faithful copy of
`build_dataset`, so `prior_*` means the same thing on both row types.

**And it is distinct from v0.9.0.** `preufc_*` already feeds a fighter's non-UFC
career as *features* ("this fighter is 15-0 in the regions") — that is old and
bought almost nothing. This lever adds non-UFC bouts as labelled *rows* ("when a
15-0 regional met a 5-8 journeyman, here is what happened") — it teaches the
P(win | record gap) mapping directly in the blowout regime.

**The data.** 19,386 non-UFC bouts where both sides map to a fighter we know
(`opponent_sherdog_id` → `fighter.sherdog_id`), 100 % mirror-paired = 9,426
unique decisive bouts; 9,067 of them in the training window (< 2024-01-01).
Method mix ko 6,638 / sub 5,330 / decision 6,796 — a **72 % finish rate vs 53 %
in the UFC**, exactly the blowout regime UFC matchmaking under-produces. One row
per bout in the winner orientation (the non-UFC analogue of the scrape
convention, winner in slot A); `symmetrize_for_training` flips ~50 % by
`stable_hash(nonufc_id)`.

---

## 2. GATE 0a — does record-space separate the UFC tail at all?

Before building any union model: if a record-only model trained on UFC-only is
blind to heavy favourites, no amount of non-UFC record rows can create the
signal. Record-only ensemble (60 cols, same LGB+CB+LogReg recipe, same split),
bucketed against the full served ensemble, order-averaged, seeds 42/7/13.

| market conf | n | record-only ll | full ll | market ll |
| --- | --- | --- | --- | --- |
| 0.50–0.55 | 83 | 0.6586 | 0.6688 | 0.6873 |
| 0.55–0.62 | 121 | 0.7043 | 0.6853 | 0.6759 |
| 0.62–0.72 | 184 | 0.6767 | 0.6569 | 0.6582 |
| **0.72+** | 180 | **0.5640** | **0.5152** | 0.4392 |

Record-only is worse than the full ensemble everywhere it matters — but it is
**not blind to the tail**: its 0.72+ log-loss (0.564, seed-stable 0.561–0.564)
is far from the 0.693 coin level, and its own confidence and accuracy rise
monotonically across the market's buckets —

| market conf | record-only mean conf | record-only acc |
| --- | --- | --- |
| 0.50–0.55 | 0.578 | 0.60 |
| 0.62–0.72 | 0.588 | 0.59 |
| 0.72+ | 0.627 | **0.76** |

It tells a heavy favourite apart from a coin-flip on its own. Neither GATE 0a
failure condition (catastrophically worse **and** cannot separate 0.72+ from
0.62) holds. **GATE 0a passes** — record-space carries blowout signal, so
non-UFC record rows *could* add to it.

---

## 3. GATE 0b — do non-UFC training rows move the held-out UFC tail?

Same record-only model, trained on UFC-only vs UFC + 9,067 non-UFC rows
(down-weighted 0.1 / 0.2 / 0.4), evaluated on the held-out UFC test tail. The
UFC-only baseline reproduces 0a exactly (tail 0.5640).

| seed | ufc-only tail | union w0.4 tail | Δtail | Δcoin | Δoverall |
| --- | --- | --- | --- | --- | --- |
| 42 | 0.5640 | 0.5498 | **−0.0142** | −0.0059 | −0.0028 |
| 7 | 0.5607 | 0.5526 | −0.0081 | −0.0054 | −0.0018 |
| 13 | 0.5640 | 0.5542 | −0.0098 | −0.0071 | −0.0021 |

The non-UFC rows move the tail, **seed-stably, in the right direction**, at every
weight (Δtail −0.004…−0.014 across the 0.1/0.2/0.4 sweep); the coin bucket
(0.50–0.55, where we already beat the market) **improves** rather than degrades;
reliability falls; and the gain is ~5× larger in the tail than overall — it
concentrates where the lever aimed. **GATE 0b passes.**

### It is information, not data volume — the falsification

9,067 rows nearly triples the 5,350-row UFC train set, so the obvious objection
is that *any* extra rows would regularise a data-starved model. The decisive
control (`--stage 0bx`): permute the non-UFC labels and re-run. If the tail still
improved with the label→feature link destroyed, the gain would be row count.

| weight | mean Δtail, **real** labels | mean Δtail, **shuffled** labels |
| --- | --- | --- |
| 0.2 | −0.0086 | **+0.0108** |
| 0.4 | −0.0107 | **+0.0161** |

With real labels the tail improves; with shuffled labels it **degrades**. The
gain is the non-UFC label information, not the presence of the rows. This is the
first lever of the six to move the tail with information that survives its own
falsification.

### Population-shift risk (§5) — measured, and it is real

- **Propensity AUC 0.9992.** An LGB separating UFC-train from non-UFC rows on the
  record features is near-perfect. The two populations are structurally far apart
  — mostly because non-UFC rows are pre-debut, so `prior_*` (UFC record) is empty
  and flags them trivially. This is a genuine extrapolation warning and the
  reason the down-weight is mandatory; it also foreshadows the Stage 2 result.
- **Not a striker skew.** The tail gain split by the market-favourite's career
  finish rate: grappler (fr 0.15) −0.0051 (n=37), mixed (fr 0.52) −0.0239
  (n=55), finisher (fr 0.90) −0.0143 (n=81). Broad across styles, largest in the
  middle — resolution, not a punchers' premium.

**After Stage 0 the lever is alive on substance** and proceeds to the real
question: does any of this survive on the served ensemble?

---

## 4. Stage 2 — the union record leg on the served ensemble → **GATE 1 FAILED**

The record-only model is a weak proxy. The lever only matters if the non-UFC
information helps the *served* model, which already resolves the tail to 0.5152.
The 3-leg baseline retrained here reproduces the served ensemble bit-for-bit
(overall 0.6198, tail 0.5152, coin 0.6688, acc 0.6690, reliability 0.00296), so
the comparison is honest.

### 2a — union record model as a fourth blend leg

The union-trained record model joins lgb / cb / logreg on the full feature set;
the blender picks its weight on binary val log-loss, exactly as `EnsembleModel`
does. Seed 42 (7/13 identical in sign):

| market conf | n | 3-leg | union +w0.2 | union +w0.4 | market |
| --- | --- | --- | --- | --- | --- |
| 0.50–0.55 | 83 | 0.6688 | 0.6669 | 0.6668 | 0.6873 |
| 0.55–0.62 | 121 | 0.6853 | 0.6850 | 0.6851 | 0.6759 |
| 0.62–0.72 | 184 | 0.6569 | 0.6574 | 0.6575 | 0.6582 |
| **0.72+** | 180 | **0.5152** | **0.5168** | 0.5165 | 0.4392 |
| overall | 568 | 0.6198 | 0.6201 | 0.6201 | 0.5968 |

The blender gives the union leg **0.065** weight, and it **degrades the tail**
(+0.0016) and overall (+0.0003) and **val** (0.6203 → 0.6209). Murphy shows why
it is not simple dilution: adding the leg *raises* resolution (0.03812 → 0.04029)
— it does add discrimination — but *raises reliability more* (0.00296 → 0.00410),
i.e. the added sharpness is mis-calibrated. On the metric that is gated, log-loss,
the trade is net-negative. Accuracy nudges up (0.6690 → 0.6831) but that is
within a paired SE at n=568 and is not the gap.

### 2b — transfer: non-UFC as a prior, then fine-tune on UFC

Union-pretrain the record legs, then continue on UFC-only (LGB/CB `init_model`,
logreg refit) — the non-UFC region as a prior the UFC data corrects, not as
equal rows. It changes nothing:

| seed | full tail | union standalone | transfer standalone | transfer-as-leg tail | Δval |
| --- | --- | --- | --- | --- | --- |
| 42 | 0.5152 | 0.5498 | 0.5559 | 0.5168 | +0.0007 |
| 7 | 0.5145 | 0.5526 | 0.5576 | 0.5163 | +0.0007 |
| 13 | 0.5140 | 0.5542 | 0.5583 | 0.5160 | +0.0007 |

Transfer is **slightly worse** than the union leg — fine-tuning on UFC undoes
part of the non-UFC prior, pulling the record model back toward the UFC-only
model, which is weaker in the blowout regime.

### The ceiling — why no integration can work

The standalone tails are the whole story. **Every record-only variant tops out
around 0.55 in the tail** (union 0.550, transfer 0.557), **strictly dominated by
the full model's 0.515.** The record leg can never out-sharpen a model that has
the same record features *plus* the ratings and round-stats. A convex blend of a
dominated leg is bounded away from improvement unless its errors are strongly
decorrelated — and the val-optimal blender, free to weight it anywhere, chooses
0.065 and still loses. This is a split-independent fact (it holds on train, val
and test alike), which is why the rolling basis is not separately built: GATE 1
already fails on the static split, seed-stably, for a structural reason a
different split cannot change.

### Gate readout

| condition | requirement | measured (2a, all seeds) | verdict |
| --- | --- | --- | --- |
| a | val log-loss improves | 0.6203 → 0.6208–0.6209 | **FAIL** |
| b | 0.50–0.55 bucket held | 0.6688 → 0.6668 (better) | pass |
| c | 0.72+ improves clearly | 0.5152 → 0.5165–0.5168 (worse) | **FAIL** |
| d | accuracy not down | 0.6690 → 0.68 (up, within SE) | pass |
| e | reliability not up | 0.00296 → 0.00371–0.00410 | **FAIL** |
| f | holds on rolling too | not reached — see the ceiling | n/a |
| g | sign stable over seeds | Δtail +0.0013…+0.0018 all seeds | stable-**WORSE** |

Fails a, c, e; the seed stability (g), the honest killer of three previous
variants, here just makes the negative clean. Nothing ships.

---

## 5. Scoreboard against the 0.0229 gap

**0 of 0.0229 closed on the served model.** The lever's arithmetic is different
from the previous five, and worth stating precisely:

- The non-UFC information is **real** — it moves the record-only tail −0.014 and
  survives label-shuffle falsification. This is not a null result at the
  information layer.
- But it is **redundant** with the served feature set. The best a record-only
  model reaches in the tail (0.550) is 0.035 *worse* than the served ensemble
  already is (0.515). The regional blowout examples teach a class-gap → outcome
  mapping the opponent-adjusted ratings already encode more sharply from UFC
  data. Adding the weaker view can only trade calibration for discrimination at a
  net loss.

`tail_resolution.md` attributed ~89 % of the gap to "information the model does
not have." This lever refines that: at least the record-space slice of it is
information the model *does* have. The 0.9pp residual is not waiting in the
regional record.

---

## 6. Rejected, with reasons

| # | Idea | Why rejected |
| - | ---- | ------------ |
| 1 | Non-UFC rows in the served feature matrix directly | 90 % of columns (ratings, round-stats) are NaN for a non-UFC bout — not an option, forces the record-only design. |
| 2 | Union record model as a 4th blend leg (2a) | Blender weights it 0.065 and it degrades tail / overall / val / reliability, seed-stable. Dominated leg. |
| 3 | Pretrain-on-union, fine-tune-on-UFC transfer (2b) | Same negative; slightly worse than 2a because fine-tuning undoes the non-UFC prior. |
| 4 | Larger non-UFC weight (0.1 → 0.4 sweep) | Monotone in the wrong direction on the served model; the record leg is dominated at every weight. |
| 5 | Graded (`dominance_a`) label on the non-UFC rows | Not attempted: the brief gates it behind the binary version surviving, and the binary version fails Stage 2. `graded_target.md` already showed the graded label fails GATE 1 on UFC; non-UFC decisions have no scorecards, so it would be weaker still. |
| 6 | Reading GATE 0b as a win for the lever | It is a win for the *record-only* model, which is a proxy. The served-model test (Stage 2) is the one that decides, and it fails. |
| 7 | Trusting the Stage 0b tail gain as data volume | Falsified: shuffled non-UFC labels *degrade* the tail (+0.011…+0.018) where real labels improve it. |

---

## 7. Reproducing

```
cd scripts/simulation
./venv/bin/python scripts/lab_regional_regime.py --stage 0a --cache --seeds 42,7,13
./venv/bin/python scripts/lab_regional_regime.py --stage 0b --seeds 42,7,13 --weights 0.1,0.2,0.4
./venv/bin/python scripts/lab_regional_regime.py --stage 0bx --cache --seeds 42,7,13 --weights 0.2,0.4
./venv/bin/python scripts/lab_regional_regime.py --stage 2a --cache --seeds 42,7,13 --weights 0.2,0.4
./venv/bin/python scripts/lab_regional_regime.py --stage 2b --cache --seeds 42,7,13 --weights 0.2,0.4
```

`--stage 0b` (no `--cache`) rebuilds the union frames from the DB into
`data/regional_ufc.parquet` / `data/regional_nonufc.parquet` (gitignored);
`--cache` reuses them so the seed/weight sweeps do not re-replay. Results land in
`artifacts/lab_regional_regime.json`. The export lives in
`src/regional_export.py`.

Untouched: `CLIP_ANCHOR_DATE`, `stable_hash`, `symmetrize_for_training`,
`ROUND_STATS_SQL`, `src/dominance.py`, the whole MC path, `bout_change_event`,
the scrapers, and `MODEL_VERSION`. The served ensemble was restored bit-for-bit
and `run_train.py` was run end to end to confirm the Sunday retrain is
unaffected — test ll 0.621.

---

## 8. The sixth confirmation (context, not action)

Six information levers, six closes at zero on the served model. The first five
never added information; this one did, and the information turned out to be
redundant with what the opponent-adjusted model already extracts. Either way the
served ensemble has reached the ceiling of fundamentals data: the residual 0.9pp
in the heavy-favourite bucket is not reachable by reworking, relabelling, or
re-sourcing record-shaped data.

The one channel still adding genuinely new information over time is
forward-accrual of booking circumstance (`bout_change_event` / `first_seen_at`,
started 2026-07-23) — short notice, replacement opponent, missed weight — which
cannot be backfilled and needs 12–18 months to a first honest test. The right
move is to let that accrue rather than open a seventh lever of the same kind. An
established ceiling with six independent confirmations is a stronger, more honest
result than a fragile +0.5pp.
