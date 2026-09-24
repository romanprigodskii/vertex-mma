# CLV lab — does the line move toward the model between the open and the close?

`scripts/lab_clv_open.py` → `artifacts/lab_clv_open.json`. Nothing about the
served model changes; this measures it against a price it has never been
measured against: Bet365's **opening** line.

**Result: the main model knows something the opening line does not, the market
prices it in by the close, and it is still not a bet on its own.** Between the
open and the close Bet365's line moves toward the main model's probability —
about a fifth of the model-to-open gap in logit, far outside anything a
shuffled model produces, and not explained by Bet365's open being stale
against the other books. The debut model shows no such drift at all. Yet the
main model is so much less sharp than even the opening line (log-loss 0.625
against 0.587 on these bouts) that betting its disagreements at the open loses
money. Its information is real and **complementary**: combined with the
opening line it improves on the line; alone it does not beat the book.

## Why this question

Every "beats the market" number in the repo is measured against a CLOSING line
(`export.py`, `/model`, both papers). The close is the sharpest price there is
and the wrong yardstick for a bettor, who meets the open. If the model carries
information the market has not priced when it opens, the market's own later
move shows it: the line drifts toward the model. That drift — closing-line
value — settles an edge at a fraction of the sample a ROI needs.

The opening line did not exist here until the BetsAPI archive
(`bout_odds_quote`, source `betsapi`, 2026-09-23): Bet365's full winner history,
a timestamp on every move. It is real only lately — the share of bouts with a
single Bet365 quote is 76% in 2023, 61% in 2024, 23% in 2025, 1% in 2026 — so
the sample is bouts whose recorded history spans at least 24 hours.

## Data

- **Model:** `run_rolling_backtest.py --start 2023-01-01 --end 2026-10-01
  --predictions data/rolling_predictions.parquet --report
  artifacts/rolling_backtest_clv.json` — production's recipe retrained every
  quarter on bouts strictly before it, main and debut models both, scored
  order-invariant. 1,935 out-of-sample bouts (main 1,551, debut 384).
- **Market:** Bet365's first and last pre-bell winner price per bout, de-vigged
  proportionally. Prices are put in the prediction's fighter order (the
  dataset's order differs from the bout table's on about half the bouts).
- **Sample:** 639 of 1,694 priced, decided bouts have a history of 24 h or more
  (2023: 28, 2024: 93, 2025: 166, 2026: 352); median span 250 h.

## Tests, fixed before the run

| | n | estimate | 95% CI (cards resampled) |
|---|---|---|---|
| PRIMARY: drift toward the model, β on logit(model) − logit(open), controlling for logit(open) | 639 | **+0.140** | +0.106 … +0.174 |
| PLACEBO: same β, model shuffled within quarter (1,000×) | 639 | mean +0.005, 95th pct +0.025 | p < 0.001 |
| CONTROL: + other books' opening price | 435 | +0.135 | +0.094 … +0.174 |
| BETS: EV > 0 at the open, flat stakes | 568 | CLV +1.09%, beat the close 50% / lost to it 42% | ROI **−13.0%** (−22.4% … −3.3%) |

The control for the open's own level matters: an open that is merely noisy
reverts toward the middle, and a regressor containing −logit(open) would
"predict" that reversion with no information at all. Without the control the
slope is +0.052; with it +0.140, and the shuffled model gets +0.005.

By year the drift is positive everywhere it can be measured (2024 +0.22, 2025
+0.09, 2026 +0.14, each CI above zero); with the history floor raised to 72 h
it is +0.145. By segment it is **all main model**: main +0.191 (+0.157 …
+0.224), debut −0.003 (−0.072 … +0.065).

## Exploratory — added after the first run, not tests

| | n | result |
|---|---|---|
| bets at the open, main model | 447 | CLV +2.59%, beat the close 55%, ROI −6.2% (−16.8% … +4.8%) |
| bets at the open, debut model | 121 | CLV −4.46%, beat the close 32%, ROI −38.1% (−58.2% … −16.9%) |
| y ~ logit(open) + logit(model), main | 509 | model coefficient **+0.589** (+0.239 … +1.024), open +0.883 |
| y ~ logit(open) + logit(model), debut | 130 | model −0.415 (−1.239 … +0.360) |

The pre-registered bet rule loses because a third of its bets come from the
debut model, which has nothing the market lacks. On main-model bouts the bets
beat the close more often than not and land about where the bookmaker's margin
puts a break-even rule. The encompassing regression says the same thing from
the other side: on main-model bouts the opening line alone is improved by
adding the model.

## What it means

- **Do not feed the odds into the model.** The model's value is precisely that
  it is independent of the market (`features.py`); what this lab finds is
  information the market lacks, which a model trained on the market would
  learn to suppress.
- **The model is not a standalone bet at the open**, and the debut model is
  not a bet at all.
- **The combination is the open question worth asking next**: a
  market-anchored estimate (opening line + main model), kept separate from the
  pure model, for decisions that face a price. It needs its own out-of-sample
  test; the coefficients above were fitted and scored on the same 509 bouts.
- **The sample grows only forward.** The opening line exists for 639 bouts,
  most of them 2026. `08_scrape_bestfightodds.py` now appends every book's
  winner price to `bout_odds_quote` on each 6-hourly pass, so the history no
  longer depends on a BetsAPI token.

## Caveats

- 639 bouts, 55% from 2026: one year's market dominates the sample.
- One book's open. The control uses the other books' first prices where the
  feed has them (435 bouts), not a true market-wide open.
- "Open" is the first price BetsAPI recorded, which can trail the book's real
  opening by hours or days on the thinner years; a later "open" is closer to
  the close, which biases the drift toward zero, not away from it.
