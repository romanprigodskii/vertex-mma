"""Eval-only: model vs market on the held-out TEST split, with calibration.

Loads the EXISTING trained ensemble (no retrain, no artifact writes), rebuilds
the dataset against the current DB (so 2025+ bouts now carry market odds the
training snapshot lacked), and reports:
  - model vs market headline metrics on test bouts that have odds
  - disagreement analysis (model favourite != market favourite → who's right)
  - reliability / calibration deciles
  - accuracy by confidence band

Usage (from scripts/simulation, venv active):
  python scripts/eval_market.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402

from src.config import ARTIFACTS_DIR, CONFIDENCE_BANDS  # noqa: E402
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.features import build_feature_matrix  # noqa: E402
from src.train import evaluate_probs, temporal_split  # noqa: E402

# Evaluate the EVAL (split-trained) model so the test split is genuinely
# out-of-sample. artifacts/ensemble/ is refit on ALL data (incl. test) for
# serving, so loading it here would be in-sample/optimistic. Fall back to the
# served model (with a warning) only if the eval model isn't present.
_EVAL_DIR = ARTIFACTS_DIR / "ensemble_eval"
ENSEMBLE_DIR = _EVAL_DIR if _EVAL_DIR.exists() else ARTIFACTS_DIR / "ensemble"


def main() -> None:
    # Mirror run_train.main(): the scrape stores A=winner in ~99% of bouts,
    # so we must symmetrize (deterministic A/B flip) before splitting, exactly
    # like training did — otherwise the target is trivially 1 and AUC collapses.
    df = symmetrize_for_training(build_dataset(fetch_raw()))
    X, y, meta = build_feature_matrix(df)

    if ENSEMBLE_DIR.name != "ensemble_eval":
        print("WARNING: eval_market.py: ensemble_eval/ missing — evaluating the "
              "served (all-data) model; test-split numbers are IN-SAMPLE. "
              "Retrain to regenerate the eval model.")
    ensemble = EnsembleModel.load(ENSEMBLE_DIR)
    # Slice to the LOADED model's column list, not the in-code
    # feature_names(): between a feature addition landing and the next
    # retrain, the code list is wider than the trained artifacts and the
    # un-sliced frame would crash (or misalign) the base learners.
    X = X[ensemble.feature_columns]
    Xs, ys, metas = temporal_split(X, y, meta)
    probs = ensemble.predict_proba_a(Xs["test"])
    y_test = ys["test"].to_numpy()
    # market_prob_a rides on `meta` and is reset_index'd off the same mask as
    # Xs["test"] / ys["test"], so it's positionally aligned with `probs`. The
    # old `df.loc[metas["test"].index, ...]` indexed the FULL df by the test
    # split's 0..n reset index → it scored the EARLIEST bouts in history, not
    # the test bouts.
    market = metas["test"]["market_prob_a"].to_numpy(dtype=float)

    n = len(y_test)
    print(f"\n=== TEST split (out-of-sample), n={n} ===")
    m = evaluate_probs(probs, ys["test"], metas["test"]["market_prob_a"])
    print(
        f"model   acc {m['accuracy']*100:.1f}%  brier {m['brier']:.3f}  "
        f"logloss {m['log_loss']:.3f}  auc {m['roc_auc']:.3f}"
    )
    if "market_brier" in m:
        print(
            f"market  acc {m['market_accuracy']*100:.1f}%  brier {m['market_brier']:.3f}  "
            f"logloss {m['market_log_loss']:.3f}  (n with odds = {m['market_n']})"
        )

    # ── Head-to-head on the SAME bouts that have odds ──────────────
    has_odds = ~np.isnan(market)
    pm = probs[has_odds]
    mk = market[has_odds]
    yy = y_test[has_odds]
    if has_odds.sum() > 0:
        model_fav_a = pm >= 0.5
        market_fav_a = mk >= 0.5
        disagree = model_fav_a != market_fav_a
        nd = int(disagree.sum())
        model_right = int(((pm[disagree] >= 0.5) == (yy[disagree] == 1)).sum())
        print(
            f"\n=== DISAGREEMENTS (model fav != market fav): {nd}/{has_odds.sum()} "
            f"({nd/has_odds.sum()*100:.0f}%) ==="
        )
        if nd > 0:
            print(
                f"when they disagree → model right {model_right}/{nd} "
                f"({model_right/nd*100:.0f}%), market right {nd-model_right} "
                f"({(nd-model_right)/nd*100:.0f}%)"
            )

    # ── Calibration deciles (model) ────────────────────────────────
    print("\n=== CALIBRATION (model prob_a, test) ===")
    print("bin        n    pred%   actual%")
    for b in range(10):
        lo, hi = b / 10, (b + 1) / 10
        sel = (probs >= lo) & (probs < hi if b < 9 else probs <= hi)
        cnt = int(sel.sum())
        if cnt == 0:
            print(f"{lo:.1f}-{hi:.1f}    0")
            continue
        print(
            f"{lo:.1f}-{hi:.1f}  {cnt:4d}  {probs[sel].mean()*100:5.1f}%  "
            f"{y_test[sel].mean()*100:6.1f}%"
        )

    # ── Accuracy by confidence band ────────────────────────────────
    print("\n=== ACCURACY BY CONFIDENCE BAND (test) ===")
    margin = np.abs(probs - 0.5)
    for label, blo, bhi in CONFIDENCE_BANDS:
        sel = (margin >= blo) & (margin < bhi if bhi < 1.0 else margin <= bhi)
        cnt = int(sel.sum())
        if cnt == 0:
            print(f"{label:7s} n=0")
            continue
        acc = ((probs[sel] >= 0.5) == (y_test[sel] == 1)).mean()
        print(f"{label:7s} n={cnt:4d}  acc {acc*100:.1f}%")


if __name__ == "__main__":
    main()
