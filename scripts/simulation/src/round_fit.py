"""Production fits for the two round-level artifacts the simulator serves.

`finish_hazard.json` decides WHEN a fight ends; `decision_winner.json` decides
WHO wins one that goes the distance. Both were fitted once, by hand, from
`scripts/lab_fit_hazard.py` / `scripts/lab_fit_decision.py` — which
`run_train.py` never called. The weekly retrain therefore refreshed the
ensemble and the method models AROUND two artifacts frozen at their lab date,
and the drift was silent: nothing in `metadata.json` records what the Monte
Carlo's timing was fitted on.

This module holds the fitting itself so the pipeline and the labs run the same
code. `run_train.py` calls `refit_round_models`; the lab scripts call the same
functions and add their grading on top.

Everything that does NOT produce served weights — fitted-vs-incumbent grading,
the round-of-finish verdict, the report JSONs — stays in the lab scripts. This
module writes four files and nothing else:

    finish_hazard.json        served — refit on all bouts
    finish_hazard_eval.json   split-trained twin, the source of honest metrics
    decision_winner.json      served — refit on all decisions
    decision_winner_eval.json split-trained twin

The eval twins mirror the `ensemble/` vs `ensemble_eval/` convention in
`train.py`: grading the served model on the test window would be in-sample.

Exclusions applied to the survival set, all of them data quality rather than
convenience:
  * bouts whose round stats show more rounds than `scheduled_rounds`
    (scheduled_rounds is unreliable there, and it is a covariate here);
  * bouts with round_finished = 1 and time_finished_seconds > 300 — the
    pre-2000 long-round format, whose elapsed-time reconstruction is wrong;
  * no-contests and DQs, which are not KO / submission / decision outcomes.
Draws stay in as right-censored: they went to the scorecards, which is exactly
what "no finish" means here.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from rich.console import Console
from sklearn.linear_model import LogisticRegression, PoissonRegressor

from .config import ARTIFACTS_DIR, TRAIN_END, VAL_END
from .db import get_connection
from .decision_model import DECISION_FEATURES, DecisionWinnerModel, decision_diffs
from .finish_hazard import (
    BIN_SECONDS,
    SECONDS_PER_ROUND,
    BoutSurvival,
    FinishHazardModel,
    design_columns,
    expand_person_periods,
    survival_loglik,
    time_basis_names,
)
from .monte_carlo import FighterMC

console = Console()

HAZARD_PATH = ARTIFACTS_DIR / "finish_hazard.json"
HAZARD_EVAL_PATH = ARTIFACTS_DIR / "finish_hazard_eval.json"
DECISION_PATH = ARTIFACTS_DIR / "decision_winner.json"
DECISION_EVAL_PATH = ARTIFACTS_DIR / "decision_winner_eval.json"

ALPHAS = (1e-4, 1e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1.0)
C_GRID = (0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0)
TEMPERATURE_GRID = tuple(np.round(np.arange(0.4, 2.61, 0.1), 2))

OUTCOME_SQL = """
SELECT
  b.id::text                AS bout_id,
  b.fighter_a_id::text      AS fighter_a_id,
  b.winner_id::text         AS winner_id,
  b.method::text            AS method,
  b.round_finished          AS round_finished,
  b.time_finished_seconds   AS time_finished_seconds,
  b.scheduled_rounds        AS scheduled_rounds,
  b.is_main_event           AS is_main_event,
  b.is_title_fight          AS is_title_fight,
  (SELECT COUNT(DISTINCT round) FROM bout_round_stats s WHERE s.bout_id = b.id)
                            AS observed_rounds
FROM bout b
WHERE b.id = ANY(%s::uuid[]) AND b.status = 'completed'
"""


def _cause(method: str | None) -> str | None:
    if method in ("ko", "tko"):
        return "ko"
    if method == "submission":
        return "sub"
    if method is not None and method.startswith("decision"):
        return None  # censored at the bell
    return "SKIP"  # dq / no_contest / unknown — not a gradeable outcome


def build_survival_set(df: pd.DataFrame) -> tuple[list[BoutSurvival], dict]:
    """Reduce the feature frame to what the two likelihoods need.

    The outcome columns are re-read from the DB rather than taken from `df`:
    the frame carries features, not the finish clock. That also means this is
    the one place where a corrected scrape (a fixed `is_title_fight`, a
    repaired `round_finished`) reaches the fitted weights.
    """
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(OUTCOME_SQL, (df["bout_id"].tolist(),))
        cols = [d[0] for d in cur.description]
        rows = {r[0]: dict(zip(cols, r, strict=True)) for r in cur.fetchall()}

    bouts: list[BoutSurvival] = []
    skipped = {"no_db_row": 0, "ungradeable_method": 0, "sched_mismatch": 0,
               "legacy_long_round": 0, "bad_timing": 0}

    for i in range(len(df)):
        row = df.iloc[i]
        r = rows.get(row["bout_id"])
        if r is None:
            skipped["no_db_row"] += 1
            continue
        cause = _cause(r["method"])
        if cause == "SKIP":
            skipped["ungradeable_method"] += 1
            continue
        sched = int(r["scheduled_rounds"] or 3)
        if (r["observed_rounds"] or 0) > sched:
            skipped["sched_mismatch"] += 1
            continue
        rf, tf = r["round_finished"], r["time_finished_seconds"]
        if rf == 1 and tf is not None and tf > SECONDS_PER_ROUND:
            skipped["legacy_long_round"] += 1
            continue

        w = r["winner_id"]
        if w == row["fighter_a_id"]:
            winner_side = 0
        elif w == row["fighter_b_id"]:
            winner_side = 1
        else:
            winner_side = None  # draw — censored, and not method-gradeable

        if cause is None:
            end = float(sched * SECONDS_PER_ROUND)
            side = None
        else:
            if rf is None or tf is None:
                skipped["bad_timing"] += 1
                continue
            end = float((int(rf) - 1) * SECONDS_PER_ROUND + float(tf))
            if not 0 < end <= sched * SECONDS_PER_ROUND:
                skipped["bad_timing"] += 1
                continue
            if winner_side is None:
                skipped["bad_timing"] += 1
                continue
            side = winner_side

        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        bouts.append(
            BoutSurvival(
                bout_id=row["bout_id"],
                event_date=pd.to_datetime(row["event_date"]),
                scheduled_rounds=sched,
                is_main_event=bool(r["is_main_event"]),
                is_title_fight=bool(r["is_title_fight"]),
                end_seconds=end,
                cause=cause,
                finisher_side=side,
                winner_side=winner_side,
                # FighterMC applies the shrinkage the MC serves with, so the
                # hazard is fitted on exactly the numbers it will see live.
                snap_a=FighterMC.from_snapshot(snap_a),
                snap_b=FighterMC.from_snapshot(snap_b),
            )
        )
    return bouts, skipped


def _temporal_split(
    items: list[BoutSurvival],
) -> tuple[pd.DatetimeIndex, list[BoutSurvival], list[BoutSurvival], list[BoutSurvival]]:
    """The production splits: train < TRAIN_END, val in [TRAIN_END, VAL_END),
    test >= VAL_END. Val selects the penalty; test is reported once."""
    dates = pd.to_datetime([b.event_date for b in items])
    tr = [b for b, d in zip(items, dates, strict=True) if d < pd.to_datetime(TRAIN_END)]
    va = [b for b, d in zip(items, dates, strict=True)
          if pd.to_datetime(TRAIN_END) <= d < pd.to_datetime(VAL_END)]
    te = [b for b, d in zip(items, dates, strict=True) if d >= pd.to_datetime(VAL_END)]
    return dates, tr, va, te


# ── stage 1: the finish hazard ──────────────────────────────────────────────


def fit_cause(
    T: np.ndarray, Xs: np.ndarray, expo: np.ndarray, y: np.ndarray, alpha: float
) -> PoissonRegressor:
    """Poisson with exposure via the standard offset trick: regress the RATE
    (events / exposure) weighted by exposure, which has the same likelihood as
    a log-link Poisson with log(exposure) as an offset."""
    design = np.hstack([T, Xs])
    model = PoissonRegressor(alpha=alpha, max_iter=1000, tol=1e-7)
    model.fit(design, y / expo, sample_weight=expo)
    return model


@dataclass
class HazardFit:
    """What the labs need to grade the fit they just wrote."""

    served: FinishHazardModel
    eval_model: FinishHazardModel
    alpha: float
    sweep: list[dict]
    bouts: list[BoutSurvival]
    train: list[BoutSurvival]
    val: list[BoutSurvival]
    test: list[BoutSurvival]


def fit_finish_hazard(
    bouts: list[BoutSurvival], bin_seconds: int = BIN_SECONDS
) -> HazardFit:
    """Sweep the L2 penalty on val, save the split-trained twin, refit the
    served weights on every bout, save that too."""
    dates, tr, va, te = _temporal_split(bouts)
    console.log(f"hazard split — train {len(tr):,} · val {len(va):,} · test {len(te):,}")

    T_tr, X_tr, e_tr, ko_tr, sub_tr = expand_person_periods(tr, bin_seconds)
    console.log(
        f"person-period rows: {len(T_tr):,} "
        f"({int(ko_tr.sum())} KO events, {int(sub_tr.sum())} sub events)"
    )

    cov_mean = X_tr.mean(axis=0)
    cov_std = X_tr.std(axis=0)
    cov_std[cov_std < 1e-9] = 1.0
    Xs_tr = (X_tr - cov_mean) / cov_std

    def build_model(alpha: float) -> FinishHazardModel:
        m_ko = fit_cause(T_tr, Xs_tr, e_tr, ko_tr, alpha)
        m_sub = fit_cause(T_tr, Xs_tr, e_tr, sub_tr, alpha)
        return FinishHazardModel(
            coef={"ko": m_ko.coef_.tolist(), "sub": m_sub.coef_.tolist()},
            intercept={"ko": float(m_ko.intercept_), "sub": float(m_sub.intercept_)},
            cov_mean=cov_mean.tolist(),
            cov_std=cov_std.tolist(),
            cov_names=design_columns(),
            time_names=time_basis_names(),
            meta={"alpha": alpha, "bin_seconds": bin_seconds,
                  "n_train_bouts": len(tr), "train_end": TRAIN_END, "val_end": VAL_END},
        )

    console.log("sweeping the L2 penalty on the validation window…")
    sweep: list[dict] = []
    best, best_ll = None, -np.inf
    for alpha in ALPHAS:
        model = build_model(alpha)
        ll = survival_loglik(model, va)["mean_loglik"]
        sweep.append({"alpha": alpha, "val_mean_loglik": ll})
        console.log(f"  alpha {alpha:<8g} val mean log-lik {ll:+.5f}")
        if ll > best_ll:
            best, best_ll = model, ll
    assert best is not None
    alpha = best.meta["alpha"]
    console.log(f"selected alpha = {alpha:g}")
    best.save(HAZARD_EVAL_PATH)

    # Production refit: same alpha, same design, ALL bouts. The lab's metrics
    # stay the split model's, which is the conservative estimate — the served
    # model has strictly more data.
    T_all, X_all, e_all, ko_all, sub_all = expand_person_periods(bouts, bin_seconds)
    mean_all, std_all = X_all.mean(axis=0), X_all.std(axis=0)
    std_all[std_all < 1e-9] = 1.0
    Xs_all = (X_all - mean_all) / std_all
    m_ko_all = fit_cause(T_all, Xs_all, e_all, ko_all, alpha)
    m_sub_all = fit_cause(T_all, Xs_all, e_all, sub_all, alpha)
    served = FinishHazardModel(
        coef={"ko": m_ko_all.coef_.tolist(), "sub": m_sub_all.coef_.tolist()},
        intercept={
            "ko": float(m_ko_all.intercept_),
            "sub": float(m_sub_all.intercept_),
        },
        cov_mean=mean_all.tolist(),
        cov_std=std_all.tolist(),
        cov_names=design_columns(),
        time_names=time_basis_names(),
        meta={
            "alpha": alpha,
            "bin_seconds": bin_seconds,
            "refit_on_all_data": True,
            "n_bouts": len(bouts),
            "trained_through": str(max(dates).date()),
            "note": "served weights = all bouts; honest metrics come from "
                    "finish_hazard_eval.json (train-only)",
        },
    )
    served.save(HAZARD_PATH)
    console.log(
        f"saved served hazard (all {len(bouts):,} bouts) and the split-trained "
        f"eval twin ({len(tr):,} bouts)"
    )
    return HazardFit(
        served=served, eval_model=best, alpha=alpha, sweep=sweep,
        bouts=bouts, train=tr, val=va, test=te,
    )


# ── stage 2: the decision winner ────────────────────────────────────────────


def logloss(p: np.ndarray, y: np.ndarray) -> float:
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


@dataclass
class DecisionFit:
    served: DecisionWinnerModel
    eval_model: DecisionWinnerModel
    C: float
    temperature: float
    c_sweep: list[dict]
    temperature_sweep: list[dict]
    decisions: list[BoutSurvival]
    train: list[BoutSurvival]
    val: list[BoutSurvival]
    test: list[BoutSurvival]


def decisions_from(bouts: list[BoutSurvival]) -> list[BoutSurvival]:
    """Bouts that reached the scorecards AND have a winner. Draws are excluded:
    there is no binary target."""
    return [b for b in bouts if b.cause is None and b.winner_side is not None]


def fit_decision_winner(decisions: list[BoutSurvival]) -> DecisionFit:
    """Sweep C and the temperature on val, save the split-trained twin, refit
    the served weights on every decision, save that too."""
    dates, tr, va, te = _temporal_split(decisions)
    console.log(f"decision split — train {len(tr):,} · val {len(va):,} · test {len(te):,}")

    X_tr, y_tr = build_matrix(tr)
    X_va, y_va = build_matrix(va)
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
        ll = logloss(clf.predict_proba(X_va / scale)[:, 1], y_va)
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
        ll = logloss(p, y_va)
        temp_sweep.append({"temperature": float(T), "val_logloss": ll})
        if ll < best_T_ll:
            best_T, best_T_ll = float(T), ll
    console.log(
        f"selected C={best_C:g} · temperature={best_T:.2f} (val ll {best_T_ll:.4f})"
    )

    eval_model = DecisionWinnerModel(
        coef=best_clf.coef_[0].tolist(),
        scale=scale.tolist(),
        feature_names=list(DECISION_FEATURES),
        temperature=best_T,
        meta={"C": best_C, "n_train_decisions": len(tr),
              "train_end": TRAIN_END, "val_end": VAL_END},
    )
    eval_model.save(DECISION_EVAL_PATH)

    # Production refit on ALL decisions at the selected C / temperature.
    X_all, y_all = build_matrix(decisions)
    scale_all = X_all.std(axis=0)
    scale_all[scale_all < 1e-9] = 1.0
    clf_all = LogisticRegression(
        C=best_C, fit_intercept=False, max_iter=2000, solver="lbfgs"
    )
    clf_all.fit(X_all / scale_all, y_all)
    served = DecisionWinnerModel(
        coef=clf_all.coef_[0].tolist(),
        scale=scale_all.tolist(),
        feature_names=list(DECISION_FEATURES),
        temperature=best_T,
        meta={"C": best_C, "refit_on_all_data": True,
              "n_decisions": len(decisions),
              "trained_through": str(max(dates).date()),
              "note": "served weights = all decisions; honest metrics come from "
                      "decision_winner_eval.json (train-only)"},
    )
    served.save(DECISION_PATH)
    console.log(
        f"saved served decision model (all {len(decisions):,} decisions) and the "
        f"split-trained eval twin ({len(tr):,} decisions)"
    )
    return DecisionFit(
        served=served, eval_model=eval_model, C=best_C, temperature=best_T,
        c_sweep=sweep, temperature_sweep=temp_sweep,
        decisions=decisions, train=tr, val=va, test=te,
    )


# ── the pipeline entry point ────────────────────────────────────────────────


def refit_round_models(
    df: pd.DataFrame, bin_seconds: int = BIN_SECONDS
) -> dict[str, object]:
    """Refit and save both round-level artifacts from the frame `run_train.py`
    just built. One survival set feeds both stages, so the population, the
    exclusions and the FighterMC shrinkage are identical across them.

    `df` must be the freshly built dataset — never the lab cache, whose whole
    purpose is to be stale.
    """
    frame = df[df["target_a_wins"].notna()].reset_index(drop=True)
    bouts, skipped = build_survival_set(frame)
    console.log(f"{len(bouts):,} bouts in the survival set · skipped {skipped}")

    hazard = fit_finish_hazard(bouts, bin_seconds)
    decision = fit_decision_winner(decisions_from(bouts))
    return {
        "n_bouts": len(bouts),
        "skipped": skipped,
        "hazard_alpha": hazard.alpha,
        "hazard_trained_through": hazard.served.meta["trained_through"],
        "n_decisions": len(decision.decisions),
        "decision_C": decision.C,
        "decision_temperature": decision.temperature,
        "decision_trained_through": decision.served.meta["trained_through"],
    }
