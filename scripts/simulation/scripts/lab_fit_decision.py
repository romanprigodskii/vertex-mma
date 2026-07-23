"""Fit the decision-winner model (Stage 2 of the round-level-signals lab) and
grade it against the four hand-set weights it replaces.

Population: bouts that actually went to the scorecards and have a winner —
draws are excluded (no binary target). Splits are the production ones:
train < TRAIN_END, val in [TRAIN_END, VAL_END) for C and the temperature,
test >= VAL_END reported once.

Two things are being measured, and they are not the same:

  1. DECISION-CONDITIONAL log-loss — given the fight went the distance, did
     the model pick the right fighter. This is the direct verdict on the
     replacement.
  2. What that does to the CONDITIONAL METHOD mix, which is what
     `sportsbook.ts` actually prices. The decision split feeds it, so a
     miscalibrated winner split leaks into the KO/sub/dec ratio of both sides.

Usage (from scripts/simulation, venv active):
  python scripts/lab_fit_decision.py
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.table import Table  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR, TRAIN_END, VAL_END  # noqa: E402
from src.decision_model import (  # noqa: E402
    DECISION_FEATURES,
    DecisionWinnerModel,
    decision_diffs,
)
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.finish_hazard import BoutSurvival  # noqa: E402

console = Console()

ARTIFACT_PATH = ARTIFACTS_DIR / "decision_winner.json"
EVAL_ARTIFACT_PATH = ARTIFACTS_DIR / "decision_winner_eval.json"
REPORT_PATH = ARTIFACTS_DIR / "lab_decision_winner.json"
CACHE_PATH = DATA_DIR / "rolling_dataset.parquet"

C_GRID = (0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0)
TEMPERATURE_GRID = tuple(np.round(np.arange(0.4, 2.61, 0.1), 2))


def _logloss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def build_matrix(bouts: list[BoutSurvival]) -> tuple[np.ndarray, np.ndarray]:
    """Both orientations, label inverted. With a no-intercept fit the model is
    antisymmetric anyway, so this is belt-and-braces: it pins the training base
    rate to exactly 0.500 and makes any slot-order leak impossible rather than
    merely unlikely."""
    X = np.array([decision_diffs(b.snap_a, b.snap_b) for b in bouts])
    y = np.array([1 - b.winner_side for b in bouts], dtype=float)  # side 0 wins -> 1
    return np.vstack([X, -X]), np.concatenate([y, 1.0 - y])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.parse_args()

    if CACHE_PATH.exists():
        console.log(f"loading cached dataset from {CACHE_PATH}")
        df = pd.read_parquet(CACHE_PATH)
    else:
        df = symmetrize_for_training(build_dataset(fetch_raw(), include_debuts=True))
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)

    # Reuse the Stage 1 survival builder so the population, the exclusions and
    # the FighterMC shrinkage are identical across both stages.
    from scripts.lab_fit_hazard import build_survival_set

    bouts, skipped = build_survival_set(df)
    decisions = [b for b in bouts if b.cause is None and b.winner_side is not None]
    console.log(
        f"{len(decisions):,} decisions with a winner "
        f"(of {len(bouts):,} bouts; skipped {skipped})"
    )

    dates = pd.to_datetime([b.event_date for b in decisions])
    tr = [b for b, d in zip(decisions, dates, strict=True) if d < pd.to_datetime(TRAIN_END)]
    va = [b for b, d in zip(decisions, dates, strict=True)
          if pd.to_datetime(TRAIN_END) <= d < pd.to_datetime(VAL_END)]
    te = [b for b, d in zip(decisions, dates, strict=True) if d >= pd.to_datetime(VAL_END)]
    console.log(f"split — train {len(tr):,} · val {len(va):,} · test {len(te):,}")

    X_tr, y_tr = build_matrix(tr)
    X_va, y_va = build_matrix(va)
    X_te, y_te = build_matrix(te)
    assert abs(y_tr.mean() - 0.5) < 1e-9, (
        f"train base rate {y_tr.mean():.4f} != 0.500 — the two-orientation emit "
        "is broken and the fit would learn slot order"
    )

    scale = X_tr.std(axis=0)
    scale[scale < 1e-9] = 1.0

    console.log("sweeping C on the validation window…")
    sweep: list[dict] = []
    best_C, best_ll, best_clf = None, np.inf, None
    for C in C_GRID:
        clf = LogisticRegression(
            C=C, fit_intercept=False, max_iter=2000, solver="lbfgs"
        )
        clf.fit(X_tr / scale, y_tr)
        ll = _logloss(clf.predict_proba(X_va / scale)[:, 1], y_va)
        sweep.append({"C": C, "val_logloss": ll})
        console.log(f"  C {C:<6g} val decision log-loss {ll:.4f}")
        if ll < best_ll:
            best_C, best_ll, best_clf = C, ll, clf
    assert best_clf is not None

    # Temperature sweep, same procedure that produced METHOD_ANCHOR_LAMBDA=0.80:
    # minimize decision-conditional log-loss on the strictly pre-test window.
    raw_logit_va = (X_va / scale) @ best_clf.coef_[0]
    temp_sweep: list[dict] = []
    best_T, best_T_ll = 1.0, np.inf
    for T in TEMPERATURE_GRID:
        p = 1.0 / (1.0 + np.exp(-np.clip(raw_logit_va / T, -30, 30)))
        ll = _logloss(p, y_va)
        temp_sweep.append({"temperature": float(T), "val_logloss": ll})
        if ll < best_T_ll:
            best_T, best_T_ll = float(T), ll
    console.log(f"selected C={best_C:g} · temperature={best_T:.2f} (val ll {best_T_ll:.4f})")

    model = DecisionWinnerModel(
        coef=best_clf.coef_[0].tolist(),
        scale=scale.tolist(),
        feature_names=list(DECISION_FEATURES),
        temperature=best_T,
        meta={"C": best_C, "n_train_decisions": len(tr),
              "train_end": TRAIN_END, "val_end": VAL_END},
    )
    model.save(EVAL_ARTIFACT_PATH)

    # ── grading vs the incumbent hand-set logit ─────────────────────────
    from src.monte_carlo import DECISION_TEMPERATURE, _decision_logit

    def incumbent_probs(subset: list[BoutSurvival]) -> np.ndarray:
        z = np.array([_decision_logit(b.snap_a, b.snap_b) for b in subset])
        return 1.0 / (1.0 + np.exp(-np.clip(z / DECISION_TEMPERATURE, -30, 30)))

    def fitted_probs(subset: list[BoutSurvival], temperature: float) -> np.ndarray:
        return np.array([model.prob_a(b.snap_a, b.snap_b, temperature) for b in subset])

    grading: dict[str, dict] = {}
    for name, subset in (("val", va), ("test", te)):
        if not subset:
            continue
        y = np.array([1 - b.winner_side for b in subset], dtype=float)
        p_new = fitted_probs(subset, best_T)
        p_new_raw = fitted_probs(subset, 1.0)
        p_old = incumbent_probs(subset)
        n = len(subset)
        grading[name] = {
            "n": n,
            "fitted_logloss": _logloss(p_new, y),
            "fitted_logloss_temperature_1": _logloss(p_new_raw, y),
            "incumbent_logloss": _logloss(p_old, y),
            "coin_flip_logloss": float(np.log(2.0)),
            "fitted_accuracy": float(((p_new >= 0.5) == (y == 1)).mean()),
            "incumbent_accuracy": float(((p_old >= 0.5) == (y == 1)).mean()),
            "accuracy_se": float(np.sqrt(0.25 / n)),
            # How extreme each model's probabilities get. The incumbent's
            # temperature of 0.45 is a 2.2x sharpening, so this is where the
            # damage shows up.
            "fitted_p_below_0.05_or_above_0.95": float(
                np.mean((p_new < 0.05) | (p_new > 0.95))
            ),
            "incumbent_p_below_0.05_or_above_0.95": float(
                np.mean((p_old < 0.05) | (p_old > 0.95))
            ),
        }

    # Production refit on ALL decisions at the selected C / temperature.
    X_all, y_all = build_matrix(decisions)
    scale_all = X_all.std(axis=0)
    scale_all[scale_all < 1e-9] = 1.0
    clf_all = LogisticRegression(
        C=best_C, fit_intercept=False, max_iter=2000, solver="lbfgs"
    )
    clf_all.fit(X_all / scale_all, y_all)
    DecisionWinnerModel(
        coef=clf_all.coef_[0].tolist(),
        scale=scale_all.tolist(),
        feature_names=list(DECISION_FEATURES),
        temperature=best_T,
        meta={"C": best_C, "refit_on_all_data": True,
              "n_decisions": len(decisions),
              "trained_through": str(max(dates).date()),
              "note": "served weights = all decisions; honest metrics come from "
                      "decision_winner_eval.json (train-only)"},
    ).save(ARTIFACT_PATH)

    # ── printout ────────────────────────────────────────────────────────
    t = Table(title="Decision-winner model — held-out (decisions only)")
    t.add_column("Split")
    t.add_column("N", justify="right")
    t.add_column("fitted LL", justify="right")
    t.add_column("incumbent LL", justify="right")
    t.add_column("coin flip", justify="right")
    t.add_column("fitted acc", justify="right")
    t.add_column("incumbent acc", justify="right")
    for name, g in grading.items():
        t.add_row(
            name, f"{g['n']:,}",
            f"{g['fitted_logloss']:.4f}", f"{g['incumbent_logloss']:.4f}",
            f"{g['coin_flip_logloss']:.4f}",
            f"{g['fitted_accuracy']:.4f} ±{g['accuracy_se'] * 100:.1f}pp",
            f"{g['incumbent_accuracy']:.4f}",
        )
    console.print(t)

    e = Table(title="Share of decisions priced beyond 5% / 95%")
    e.add_column("Split")
    e.add_column("fitted", justify="right")
    e.add_column("incumbent", justify="right")
    for name, g in grading.items():
        e.add_row(
            name,
            f"{g['fitted_p_below_0.05_or_above_0.95'] * 100:.1f}%",
            f"{g['incumbent_p_below_0.05_or_above_0.95'] * 100:.1f}%",
        )
    console.print(e)

    c = Table(title="Fitted coefficients (per standardized A-B difference)")
    c.add_column("Feature")
    c.add_column("coef", justify="right")
    c.add_column("incumbent hand weight", justify="right")
    hand = {"slpm": "+0.18", "sapm": "-0.10", "control_per_min": "+0.80",
            "td_per15": "+0.08"}
    for name, w in zip(DECISION_FEATURES, model.coef, strict=True):
        c.add_row(name, f"{w:+.4f}", hand.get(name, "—"))
    console.print(c)

    REPORT_PATH.write_text(
        json.dumps(
            {
                "generated_at": datetime.utcnow().isoformat() + "Z",
                "n_decisions": len(decisions),
                "n_train": len(tr), "n_val": len(va), "n_test": len(te),
                "C_sweep": sweep,
                "temperature_sweep": temp_sweep,
                "selected_C": best_C,
                "selected_temperature": best_T,
                "coefficients": dict(
                    zip(DECISION_FEATURES, model.coef, strict=True)
                ),
                "grading": grading,
            },
            indent=2, default=str,
        )
    )
    console.log(f"wrote {ARTIFACT_PATH}, {EVAL_ARTIFACT_PATH} and {REPORT_PATH}")


if __name__ == "__main__":
    main()
