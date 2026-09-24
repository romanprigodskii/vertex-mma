"""LAB — does the line move toward the model between Bet365's open and close?

Every "beats the market" number in this repo is measured against a CLOSING
line, the sharpest price there is. The question a bettor actually faces is
earlier: at the OPENING price, does the model know something the market has
not priced yet? If it does, the market's own later move is the evidence —
the line drifts toward the model between open and close — and closing-line
value (CLV) settles it at a fraction of the sample a ROI needs.

The opening line exists since the BetsAPI archive (bout_odds_quote, source
'betsapi'): Bet365's full winner history with a timestamp on every move. It
is REAL only from 2025 on — in 2023 76% of bouts carry a single Bet365 quote,
in 2024 61%, in 2026 1% — so the sample is bouts whose recorded history spans
at least MIN_SPAN_H hours.

Model probabilities are OUT-OF-SAMPLE: run_rolling_backtest.py --predictions,
production's own recipe retrained each quarter on bouts strictly before it,
main and debut models both, scored order-invariant.

Fixed before the first run on this data (the scratch probe of 2026-09-24 used
a different frame, the paper's 5-seed pool, and the simple slope):

  PRIMARY    Δ = logit(close) − logit(open) regressed on
             x = logit(p_model) − logit(open), CONTROLLING for logit(open).
             The control matters: an open that is merely noisy reverts toward
             the middle, and any x containing −logit(open) would "predict"
             that reversion with no information at all. β_x is the part of
             the move the MODEL explains beyond the open's own level.
             95% event-clustered bootstrap CI (cards resampled whole).
  PLACEBO    the same coefficient with p_model shuffled within each quarter,
             1,000 times: what the regression finds with the model's
             per-bout information removed. p = share of placebo β ≥ real β.
  CONTROL    on bouts where another book also posted an opening price: add
             logit(other open) − logit(Bet365 open). If β_x survives, the
             model is not just spotting a stale Bet365 number.
  BETS       one rule, EV > 0 at the open (p_model × open decimal > 1), flat
             stakes: mean CLV (open / close − 1), share of bets that beat the
             close, ROI with an event-clustered CI. No other threshold.

EXPLORATORY, added after the first run and labelled so in the output — not
tests, and not to be quoted as such:
  * the bet rule per segment (main / debut), because the primary split by
    segment showed the debut model carries no drift at all;
  * an encompassing regression, y ~ logit(open) + logit(p_model): does the
    model add to the opening line when the two are COMBINED, the only way the
    market could enter a decision without entering the model.

De-vig is proportional, as in export.py (memory: the power de-vig changes no
ROI and moves segment effects by < 0.4 SE).

Usage (scripts/simulation, venv active; needs the DB tunnel):
  python scripts/run_rolling_backtest.py --start 2023-01-01 --end 2026-10-01 \\
      --predictions data/rolling_predictions.parquet \\
      --report artifacts/rolling_backtest_clv.json
  python scripts/lab_clv_open.py            # writes artifacts/lab_clv_open.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.db import get_connection  # noqa: E402

PREDICTIONS = DATA_DIR / "rolling_predictions.parquet"
OUT_PATH = ARTIFACTS_DIR / "lab_clv_open.json"
MIN_SPAN_H = 24.0
B_BOOT = 5000
B_PLACEBO = 1000
SEED = 42
CLIP = 0.01

QUOTES_SQL = """
WITH w AS (
  SELECT * FROM bout_odds_quote
  WHERE source = 'betsapi' AND market = 'winner' AND book = 'Bet365'
), op AS (
  SELECT DISTINCT ON (bout_id) bout_id, price_a AS oa, price_b AS ob, quoted_at AS ot
  FROM w ORDER BY bout_id, quoted_at ASC
), cl AS (
  SELECT DISTINCT ON (bout_id) bout_id, price_a AS ca, price_b AS cb, quoted_at AS ct
  FROM w ORDER BY bout_id, quoted_at DESC
), other AS (
  -- every other book's FIRST price, averaged in probability space
  SELECT bout_id, avg((1/price_a) / (1/price_a + 1/price_b)) AS p_other_open
  FROM (
    SELECT DISTINCT ON (bout_id, book) bout_id, book, price_a, price_b
    FROM bout_odds_quote
    WHERE source = 'betsapi' AND market = 'winner' AND book <> 'Bet365'
    ORDER BY bout_id, book, quoted_at ASC
  ) f GROUP BY bout_id
)
SELECT op.bout_id::text AS bout_id, oa, ob, ot, ca, cb, ct, o.p_other_open,
       b.fighter_a_id::text AS fa_db
FROM op JOIN cl USING (bout_id)
JOIN bout b ON b.id = op.bout_id
LEFT JOIN other o ON o.bout_id = op.bout_id
"""


def logit(p):
    p = np.clip(np.asarray(p, dtype=float), CLIP, 1 - CLIP)
    return np.log(p / (1 - p))


def devig(a, b):
    return (1 / a) / (1 / a + 1 / b)


def load(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise SystemExit(f"{path} missing — run run_rolling_backtest.py "
                         "--predictions first (see the docstring)")
    pr = pd.read_parquet(path)
    pr = pr[pr["y"].isin([0, 1])].copy()
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(QUOTES_SQL)
        cols = [c.name for c in cur.description]
        q = pd.DataFrame(cur.fetchall(), columns=cols)
    for c in ("oa", "ob", "ca", "cb", "p_other_open"):
        q[c] = pd.to_numeric(q[c], errors="coerce")
    d = pr.merge(q, on="bout_id", how="inner")

    # The predictions are in the DATASET's fighter order, which is not always
    # the bout table's. Put every price in the prediction's orientation.
    flip = (d["fighter_a_id"] != d["fa_db"]).to_numpy()
    for a, b in (("oa", "ob"), ("ca", "cb")):
        d.loc[flip, [a, b]] = d.loc[flip, [b, a]].to_numpy()
    d.loc[flip, "p_other_open"] = 1 - d.loc[flip, "p_other_open"]
    d["flipped"] = flip

    d["p_open"] = devig(d["oa"], d["ob"])
    d["p_close"] = devig(d["ca"], d["cb"])
    d["span_h"] = (pd.to_datetime(d["ct"]) - pd.to_datetime(d["ot"])).dt.total_seconds() / 3600
    d["year"] = pd.to_datetime(d["event_date"]).dt.year
    return d


# --------------------------------------------------------------- statistics
def ols(y: np.ndarray, X: np.ndarray) -> np.ndarray:
    X1 = np.column_stack([np.ones(len(y)), X])
    return np.linalg.lstsq(X1, y, rcond=None)[0][1:]


def design(d: pd.DataFrame, p=None, other: bool = False):
    lo = logit(d["p_open"])
    x = logit(d["p"] if p is None else p) - lo
    cols = [x, lo]
    if other:
        cols.append(logit(d["p_other_open"]) - lo)
    return logit(d["p_close"]) - lo, np.column_stack(cols)


def event_groups(d: pd.DataFrame) -> list[np.ndarray]:
    ev = d["event_id"].astype(str).to_numpy()
    return [np.flatnonzero(ev == u) for u in np.unique(ev)]


def boot_ci(stat, groups, rng, b=B_BOOT):
    draws = []
    for _ in range(b):
        pick = rng.integers(0, len(groups), len(groups))
        draws.append(stat(np.concatenate([groups[i] for i in pick])))
    draws = np.asarray(draws)
    return [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))], draws


def drift(d: pd.DataFrame, rng, *, other: bool = False) -> dict:
    y, X = design(d, other=other)
    beta = ols(y, X)
    ci, draws = boot_ci(lambda ii: ols(y[ii], X[ii])[0], event_groups(d), rng)
    out = {"n": int(len(d)), "beta_model": float(beta[0]),
           "beta_open_level": float(beta[1]), "ci95": ci,
           "boot_share_le_0": float((draws <= 0).mean())}
    if other:
        out["beta_other_books"] = float(beta[2])
    # the raw slope, without the control — what the scratch probe reported
    x = logit(d["p"]) - logit(d["p_open"])
    out["beta_uncontrolled"] = float(np.polyfit(x, y, 1)[0])
    return out


def placebo(d: pd.DataFrame, real: float, rng) -> dict:
    y, _ = design(d)
    q = d["origin"].astype(str).to_numpy()
    p = d["p"].to_numpy()
    idx = [np.flatnonzero(q == u) for u in np.unique(q)]
    betas = []
    for _ in range(B_PLACEBO):
        ps = p.copy()
        for ii in idx:
            ps[ii] = p[rng.permutation(ii)]
        betas.append(ols(y, design(d, p=ps)[1])[0])
    betas = np.asarray(betas)
    return {"mean": float(betas.mean()),
            "p95": float(np.percentile(betas, 95)),
            "p_value": float((betas >= real).mean())}


def bets(d: pd.DataFrame, rng) -> dict:
    rows = []
    for side in ("a", "b"):
        pm = d["p"] if side == "a" else 1 - d["p"]
        po, pc = (d["oa"], d["ca"]) if side == "a" else (d["ob"], d["cb"])
        won = d["y"].eq(1) if side == "a" else d["y"].eq(0)
        m = (pm * po - 1) > 0
        rows.append(pd.DataFrame({
            "ret": np.where(won[m], po[m] - 1, -1.0),
            "clv": (po[m] / pc[m] - 1).to_numpy(),
            "event_id": d.loc[m, "event_id"].astype(str).to_numpy(),
        }))
    r = pd.concat(rows, ignore_index=True)
    ret = r["ret"].to_numpy()
    ci, _ = boot_ci(lambda ii: ret[ii].mean(), event_groups(r), rng)
    return {"n": int(len(r)), "roi": float(ret.mean()), "roi_ci95": ci,
            "mean_clv": float(r["clv"].mean()),
            "beat_close": float((r["clv"] > 0).mean()),
            "lost_to_close": float((r["clv"] < 0).mean())}


def encompassing(d: pd.DataFrame, rng) -> dict:
    from sklearn.linear_model import LogisticRegression

    X = np.column_stack([logit(d["p_open"]), logit(d["p"])])
    y = d["y"].to_numpy()

    def fit(ii):
        m = LogisticRegression(penalty=None, max_iter=1000).fit(X[ii], y[ii])
        return m.coef_[0]

    coef = fit(np.arange(len(d)))
    ci, draws = boot_ci(lambda ii: fit(ii)[1], event_groups(d), rng, b=1000)
    return {"n": int(len(d)), "coef_open": float(coef[0]),
            "coef_model": float(coef[1]), "coef_model_ci95": ci}


def logloss(p, y) -> float:
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--min-span-h", type=float, default=MIN_SPAN_H)
    ap.add_argument("--predictions", type=Path, default=PREDICTIONS)
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)

    all_d = load(args.predictions)
    d = all_d[all_d["span_h"] >= args.min_span_h].reset_index(drop=True)
    y = d["y"].to_numpy()
    res: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "min_span_h": args.min_span_h,
        "sample": {
            "priced_decided": int(len(all_d)),
            "with_real_open": int(len(d)),
            "by_year": {str(k): int(v) for k, v in d["year"].value_counts().sort_index().items()},
            "by_segment": {str(k): int(v) for k, v in d["segment"].value_counts().items()},
            "median_span_h": float(d["span_h"].median()),
            "line_moved": float((d["p_open"] != d["p_close"]).mean()),
        },
        "log_loss": {"model": logloss(d["p"], y), "open": logloss(d["p_open"], y),
                     "close": logloss(d["p_close"], y)},
    }
    res["primary"] = drift(d, rng)
    res["placebo"] = placebo(d, res["primary"]["beta_model"], rng)
    oth = d[d["p_other_open"].notna()].reset_index(drop=True)
    res["control_other_books"] = drift(oth, rng, other=True)
    res["bets_ev_gt_0_at_open"] = bets(d, rng)
    res["by_year"] = {str(yr): drift(g.reset_index(drop=True), rng)
                      for yr, g in d.groupby("year") if len(g) >= 60}
    res["by_segment"] = {str(s): drift(g.reset_index(drop=True), rng)
                         for s, g in d.groupby("segment") if len(g) >= 60}
    res["exploratory"] = {
        "bets_by_segment": {str(sg): bets(g.reset_index(drop=True), rng)
                            for sg, g in d.groupby("segment")},
        "encompassing": {"all": encompassing(d, rng),
                         **{str(sg): encompassing(g.reset_index(drop=True), rng)
                            for sg, g in d.groupby("segment")}},
    }
    long = all_d[all_d["span_h"] >= 72].reset_index(drop=True)
    res["span_72h"] = drift(long, rng)

    args.out.write_text(json.dumps(res, indent=2))
    p, pl, c, bt = res["primary"], res["placebo"], res["control_other_books"], res["bets_ev_gt_0_at_open"]
    s = res["sample"]
    print(f"sample: {s['with_real_open']} of {s['priced_decided']} priced decided bouts "
          f"have a Bet365 history >= {args.min_span_h:.0f} h {s['by_year']}")
    print(f"log-loss  model {res['log_loss']['model']:.4f} | open "
          f"{res['log_loss']['open']:.4f} | close {res['log_loss']['close']:.4f}")
    print(f"PRIMARY  beta_model {p['beta_model']:+.4f}  CI {p['ci95'][0]:+.4f}..{p['ci95'][1]:+.4f}"
          f"  (uncontrolled {p['beta_uncontrolled']:+.4f})")
    print(f"PLACEBO  mean {pl['mean']:+.4f}  95th pct {pl['p95']:+.4f}  p = {pl['p_value']:.4f}")
    print(f"CONTROL  n={c['n']}  beta_model {c['beta_model']:+.4f}  CI "
          f"{c['ci95'][0]:+.4f}..{c['ci95'][1]:+.4f}  beta_other_books {c['beta_other_books']:+.4f}")
    print(f"BETS     n={bt['n']}  CLV {bt['mean_clv']:+.2%}  beat close {bt['beat_close']:.0%} "
          f"(lost {bt['lost_to_close']:.0%})  ROI {bt['roi']:+.1%} CI "
          f"{bt['roi_ci95'][0]:+.1%}..{bt['roi_ci95'][1]:+.1%}")
    for k, v in {**res["by_year"], **res["by_segment"], "span>=72h": res["span_72h"]}.items():
        print(f"  {k:10} n={v['n']:4}  beta_model {v['beta_model']:+.4f}  "
              f"CI {v['ci95'][0]:+.4f}..{v['ci95'][1]:+.4f}")
    print("EXPLORATORY (after the first run; not tests)")
    for sg, v in res["exploratory"]["bets_by_segment"].items():
        print(f"  bets {sg:6} n={v['n']:4}  CLV {v['mean_clv']:+.2%}  beat close "
              f"{v['beat_close']:.0%}  ROI {v['roi']:+.1%} CI {v['roi_ci95'][0]:+.1%}.."
              f"{v['roi_ci95'][1]:+.1%}")
    for sg, v in res["exploratory"]["encompassing"].items():
        print(f"  y ~ open + model  {sg:6} n={v['n']:4}  open {v['coef_open']:+.3f}  "
              f"model {v['coef_model']:+.3f} CI {v['coef_model_ci95'][0]:+.3f}.."
              f"{v['coef_model_ci95'][1]:+.3f}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
