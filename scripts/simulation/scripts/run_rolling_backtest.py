"""Rolling-retrain backtest — the harness behind the README's "2025-07..2026-07"
numbers, which until now lived in uncommitted ad-hoc code.

Why rolling and not the static train/val/test split: the static split
(TRAIN_END=2024-01-01, VAL_END=2025-01-01) scores ONE model, frozen in Jan
2024, against 18 months of later fights. Production does not work that way —
`run_train.py` re-runs weekly, so the served model always carries data up to
last week. The rolling harness reproduces THAT: at each origin we retrain from
scratch on bouts strictly before the origin and score only the next window.

Per origin the split mirrors production exactly:

    train : event_date <  origin - 1 year
    val   : origin - 1 year <= event_date < origin   (early stop + blender)
    score : origin <= event_date < next origin       (never seen, never fit)

Segments are reported separately because two different models serve them in
production: the MAIN ensemble (both fighters have >=1 prior UFC bout) and the
DEBUT specialist (>=1 debutant, trained on everything with both-experienced
rows down-weighted to DEBUT_EXP_ROW_WEIGHT — same recipe as train.run_training).

Scoring is ORDER-INVARIANT: P(A) = 1/2 * [p(A,B) + 1 - p(B,A)], the same
averaging predict.py / custom.py apply at serve time. (eval_market.py and
eval_calibration.py score the raw scrape order and are therefore NOT comparable
to these numbers.)

Every accuracy carries its paired standard error. At the segment sizes here
(n ~ 400) that SE is ~2.4pp, so a 1pp accuracy move is noise — read log-loss.

Usage (from scripts/simulation, venv active):
  python scripts/run_rolling_backtest.py
  python scripts/run_rolling_backtest.py --start 2025-07-01 --end 2026-07-01
  python scripts/run_rolling_backtest.py --step-months 3 --cache
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

from src.config import (  # noqa: E402
    ARTIFACTS_DIR,
    DATA_DIR,
    FEATURE_CONTRI_OVERRIDES,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
    MODEL_VERSION,
    RESIDUAL_CORRECTION,
)
from src.ensemble import EnsembleModel, ResidualCorrector  # noqa: E402
from src.export import (  # noqa: E402
    build_dataset,
    fetch_raw,
    swap_sides,
    symmetrize_for_training,
)
from src.features import build_feature_matrix, debut_feature_names, feature_names  # noqa: E402
from src.train import DEBUT_EXP_ROW_WEIGHT, _load_tuned_params, evaluate_probs  # noqa: E402

console = Console()

DEFAULT_START = "2025-07-01"
DEFAULT_END = "2026-07-01"
DEFAULT_STEP_MONTHS = 3
# Length of the validation tail that precedes each origin (early stopping,
# blender fit, blend-mode select) — 12 months, exactly like TRAIN_END→VAL_END.
VAL_MONTHS = 12
REPORT_PATH = ARTIFACTS_DIR / "rolling_backtest.json"
# Flipped by --uncorrected so the lab can measure the corrector's effect on
# identical origins instead of against a stale committed report.
CORRECTOR_ENABLED = True
CACHE_PATH = DATA_DIR / "rolling_dataset.parquet"


def _origins(start: str, end: str, step_months: int) -> list[pd.Timestamp]:
    out: list[pd.Timestamp] = []
    cur = pd.to_datetime(start)
    stop = pd.to_datetime(end)
    while cur < stop:
        out.append(cur)
        cur = cur + pd.DateOffset(months=step_months)
    return out


def _acc_se(accuracy: float, n: int) -> float:
    """Standard error of a proportion. The PAIRED SE for a difference of two
    accuracies on the same bouts is smaller than sqrt(2)x this, but never
    smaller than this — quote it so nobody reads a 1pp move as a result."""
    if n <= 0:
        return float("nan")
    return float(np.sqrt(max(accuracy * (1.0 - accuracy), 1e-12) / n))


def _fit_ensemble(
    X_tr: pd.DataFrame,
    y_tr: pd.Series,
    X_va: pd.DataFrame,
    y_va: pd.Series,
    cols: list[str],
    sample_weight: np.ndarray | None = None,
    corrected: bool = True,
) -> EnsembleModel:
    tuned = _load_tuned_params()
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        "feature_contri": [FEATURE_CONTRI_OVERRIDES.get(c, 1.0) for c in cols],
    }
    model = EnsembleModel(
        feature_columns=cols,
        lgb_params=lgb_params,
        lgb_num_rounds=LGB_NUM_ROUNDS,
        lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
    )
    model.fit(
        X_train=X_tr.reset_index(drop=True),
        y_train=y_tr.reset_index(drop=True),
        X_val=X_va.reset_index(drop=True),
        y_val=y_va.reset_index(drop=True),
        sample_weight=sample_weight,
    )
    # v0.13.0 — the served path applies the residual corrector inside
    # predict_proba_a, so a rolling backtest without it would be measuring a
    # model production does not run. The coefficients are fixed in config, not
    # refit per origin: they were fitted once on walk-forward OOF ending at
    # VAL_END, which is strictly before this backtest's first origin.
    #
    # `corrected=False` for the DEBUT specialist, because train.py attaches the
    # corrector to the main ensemble only. The correction was fitted on the
    # both-experienced population and has never been gated on the debut one;
    # applying it there in the backtest but not in production would report a
    # number nothing serves. (An accidental run that did apply it moved the
    # debut segment 0.6534 -> 0.6380 on 94 bouts — suggestive, ungated, and
    # written down in docs/winner_batch.md rather than acted on.)
    model.corrector = (
        ResidualCorrector.from_dict(RESIDUAL_CORRECTION)
        if (RESIDUAL_CORRECTION and corrected and CORRECTOR_ENABLED)
        else None
    )
    return model


def _score_both_orders(
    model: EnsembleModel, X: pd.DataFrame, X_swapped: pd.DataFrame
) -> tuple[np.ndarray, np.ndarray]:
    """Return (order-invariant, raw-order) P(A).

    The headline is order-INVARIANT: P(A) = 1/2 * [p(A,B) + 1 - p(B,A)], the
    averaging predict.py / custom.py apply at serve time. The raw-order prob
    is kept only as a DIAGNOSTIC: the model is antisymmetric in its diff
    features but not in abs_*_a/_b or the stance one-hots, so the two differ,
    and averaging pulls near-coin-flip probabilities toward 0.5 — which moves
    accuracy (a threshold statistic) while barely touching log-loss or AUC.
    That is the knob that explains a couple of points of accuracy drift
    between two otherwise identical harnesses."""
    p_raw = model.predict_proba_a(X.reset_index(drop=True))
    p_sw = model.predict_proba_a(X_swapped.reset_index(drop=True))
    return 0.5 * (p_raw + (1.0 - p_sw)), p_raw


def load_dataset(use_cache: bool) -> pd.DataFrame:
    """The symmetrized bout frame. ONE dataset build, sliced by date per
    origin — legitimate because every feature in the row is point-in-time
    (snapshotted strictly before its own bout in export.build_dataset), so a
    row's contents never depend on which origin window it lands in."""
    if use_cache and CACHE_PATH.exists():
        console.log(f"loading cached dataset from {CACHE_PATH}")
        df = pd.read_parquet(CACHE_PATH)
    else:
        raw = fetch_raw()
        df = symmetrize_for_training(build_dataset(raw, include_debuts=True))
        if use_cache:
            df.to_parquet(CACHE_PATH, index=False)
            console.log(f"cached dataset at {CACHE_PATH}")
    return df


def run(
    start: str = DEFAULT_START,
    end: str = DEFAULT_END,
    step_months: int = DEFAULT_STEP_MONTHS,
    use_cache: bool = False,
) -> dict:
    df = load_dataset(use_cache)
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)

    main_cols = feature_names()
    dbt_cols = debut_feature_names()

    # Feature matrices for BOTH fighter orderings, built once.
    X_all, y_all, meta_all = build_feature_matrix(df)
    X_all_sw, _, _ = build_feature_matrix(swap_sides(df))
    dates = pd.to_datetime(meta_all["event_date"])
    debut_mask = (
        (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).to_numpy()
        if "is_debut_a" in df.columns
        else np.zeros(len(df), dtype=bool)
    )
    market = (
        meta_all["market_prob_a"] if "market_prob_a" in meta_all.columns else None
    )

    origins = _origins(start, end, step_months)
    console.log(
        f"rolling backtest — {len(origins)} origins, step {step_months}mo, "
        f"val tail {VAL_MONTHS}mo · {len(df):,} graded bouts on file"
    )

    per_origin: list[dict] = []
    # Accumulated out-of-sample predictions across all origins, per segment.
    pooled: dict[str, dict[str, list]] = {
        seg: {"p": [], "p_raw": [], "y": [], "market": [], "origin": []}
        for seg in ("main", "debut")
    }

    for origin in origins:
        val_start = origin - pd.DateOffset(months=VAL_MONTHS)
        nxt = origin + pd.DateOffset(months=step_months)
        m_train = (dates < val_start).to_numpy()
        m_val = ((dates >= val_start) & (dates < origin)).to_numpy()
        m_score = ((dates >= origin) & (dates < nxt)).to_numpy()
        if not m_score.any():
            console.log(f"[dim]origin {origin.date()} — no bouts to score, skipped[/dim]")
            continue

        entry: dict = {
            "origin": str(origin.date()),
            "score_window": [str(origin.date()), str(nxt.date())],
            "train_end": str(val_start.date()),
            "n_train": int(m_train.sum()),
            "n_val": int(m_val.sum()),
            "segments": {},
        }

        # ── MAIN model: both-experienced rows only (train.run_training recipe)
        exp = ~debut_mask
        tr = m_train & exp
        va = m_val & exp
        sc = m_score & exp
        if tr.sum() > 0 and va.sum() > 0 and sc.sum() > 0:
            model = _fit_ensemble(
                X_all.loc[tr, main_cols], y_all.loc[tr],
                X_all.loc[va, main_cols], y_all.loc[va],
                main_cols,
            )
            probs, probs_raw = _score_both_orders(
                model, X_all.loc[sc, main_cols], X_all_sw.loc[sc, main_cols]
            )
            y_sc = y_all.loc[sc].reset_index(drop=True)
            mk = market.loc[sc].reset_index(drop=True) if market is not None else None
            entry["segments"]["main"] = evaluate_probs(probs, y_sc, mk)
            pooled["main"]["p"].extend(probs.tolist())
            pooled["main"]["p_raw"].extend(probs_raw.tolist())
            pooled["main"]["y"].extend(y_sc.tolist())
            pooled["main"]["market"].extend(
                mk.tolist() if mk is not None else [np.nan] * len(y_sc)
            )
            pooled["main"]["origin"].extend([str(origin.date())] * len(y_sc))

        # ── DEBUT specialist: trained on ALL rows with experienced rows
        # down-weighted; early stopping / blender on DEBUT val rows only.
        sc_d = m_score & debut_mask
        va_d = m_val & debut_mask
        if m_train.sum() > 0 and va_d.sum() > 0 and sc_d.sum() > 0:
            weights = np.where(debut_mask, 1.0, DEBUT_EXP_ROW_WEIGHT)
            spec = _fit_ensemble(
                X_all.loc[m_train, dbt_cols], y_all.loc[m_train],
                X_all.loc[va_d, dbt_cols], y_all.loc[va_d],
                dbt_cols,
                sample_weight=weights[m_train],
                corrected=False,
            )
            probs_d, probs_d_raw = _score_both_orders(
                spec, X_all.loc[sc_d, dbt_cols], X_all_sw.loc[sc_d, dbt_cols]
            )
            y_d = y_all.loc[sc_d].reset_index(drop=True)
            mk_d = market.loc[sc_d].reset_index(drop=True) if market is not None else None
            entry["segments"]["debut"] = evaluate_probs(probs_d, y_d, mk_d)
            pooled["debut"]["p"].extend(probs_d.tolist())
            pooled["debut"]["p_raw"].extend(probs_d_raw.tolist())
            pooled["debut"]["y"].extend(y_d.tolist())
            pooled["debut"]["market"].extend(
                mk_d.tolist() if mk_d is not None else [np.nan] * len(y_d)
            )
            pooled["debut"]["origin"].extend([str(origin.date())] * len(y_d))

        seg_txt = " · ".join(
            f"{k} n={v['n']} acc={v['accuracy']:.3f} ll={v['log_loss']:.3f}"
            for k, v in entry["segments"].items()
        )
        console.log(f"origin {origin.date()} → {seg_txt or 'no scorable rows'}")
        per_origin.append(entry)

    # ── Pooled metrics over the whole window ────────────────────────────
    overall: dict[str, dict] = {}
    for seg, buf in pooled.items():
        if not buf["y"]:
            continue
        p = np.asarray(buf["p"], dtype=float)
        y = pd.Series(buf["y"], dtype="int8")
        mk = pd.Series(buf["market"], dtype=float)
        m = evaluate_probs(p, y, mk if mk.notna().any() else None)
        m["accuracy_se"] = _acc_se(m["accuracy"], m["n"])
        if "market_n" in m:
            m["market_accuracy_se"] = _acc_se(m["market_accuracy"], m["market_n"])
            m["model_accuracy_on_market_se"] = _acc_se(
                m["model_accuracy_on_market"], m["market_n"]
            )
        # Diagnostic only — see _score_both_orders. Reported so the accuracy
        # delta between order-invariant and raw-order scoring is visible
        # instead of showing up as an unexplained gap against an older number.
        raw = evaluate_probs(np.asarray(buf["p_raw"], dtype=float), y)
        m["raw_order_diagnostic"] = {
            "accuracy": raw["accuracy"],
            "log_loss": raw["log_loss"],
            "roc_auc": raw["roc_auc"],
            "picks_differing_from_order_invariant": int(
                ((p >= 0.5) != (np.asarray(buf["p_raw"], dtype=float) >= 0.5)).sum()
            ),
        }
        overall[seg] = m

    _print_report(overall, per_origin)

    payload = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "model_version": MODEL_VERSION,
        "window": {"start": start, "end": end, "step_months": step_months,
                   "val_months": VAL_MONTHS},
        "scoring": "order-invariant: 0.5*(p(A,B) + 1 - p(B,A))",
        "overall": overall,
        "per_origin": per_origin,
    }
    REPORT_PATH.write_text(json.dumps(payload, indent=2, default=str))
    console.log(f"wrote {REPORT_PATH}")
    return payload


def _print_report(overall: dict, per_origin: list[dict]) -> None:
    table = Table(title=f"Rolling retrain backtest — {MODEL_VERSION}")
    table.add_column("Segment")
    table.add_column("N", justify="right")
    table.add_column("Acc", justify="right")
    table.add_column("±SE", justify="right")
    table.add_column("LogLoss", justify="right")
    table.add_column("Brier", justify="right")
    table.add_column("AUC", justify="right")
    for seg, m in overall.items():
        table.add_row(
            seg, f"{m['n']:,}", f"{m['accuracy']:.4f}", f"{m['accuracy_se']*100:.2f}pp",
            f"{m['log_loss']:.4f}", f"{m['brier']:.4f}", f"{m['roc_auc']:.4f}",
        )
    console.print(table)

    mk = Table(title="Model vs market — identical bouts (odds subset)")
    mk.add_column("Segment")
    mk.add_column("N odds", justify="right")
    mk.add_column("Model Acc", justify="right")
    mk.add_column("Market Acc", justify="right")
    mk.add_column("Model LL", justify="right")
    mk.add_column("Market LL", justify="right")
    any_market = False
    for seg, m in overall.items():
        if "market_n" not in m:
            continue
        any_market = True
        mk.add_row(
            seg, f"{m['market_n']:,}",
            f"{m['model_accuracy_on_market']:.4f}", f"{m['market_accuracy']:.4f}",
            f"{m['model_log_loss_on_market']:.4f}", f"{m['market_log_loss']:.4f}",
        )
    if any_market:
        console.print(mk)

    for seg, m in overall.items():
        d = m.get("raw_order_diagnostic")
        if d:
            console.log(
                f"[dim]{seg}: raw-order (no swap averaging) acc {d['accuracy']:.4f} "
                f"ll {d['log_loss']:.4f} auc {d['roc_auc']:.4f} — "
                f"{d['picks_differing_from_order_invariant']} picks differ from the "
                f"order-invariant headline[/dim]"
            )

    po = Table(title="Per origin (main segment)")
    po.add_column("Origin")
    po.add_column("n train", justify="right")
    po.add_column("n val", justify="right")
    po.add_column("n score", justify="right")
    po.add_column("Acc", justify="right")
    po.add_column("LogLoss", justify="right")
    for e in per_origin:
        m = e["segments"].get("main")
        if m is None:
            continue
        po.add_row(
            e["origin"], f"{e['n_train']:,}", f"{e['n_val']:,}", f"{m['n']:,}",
            f"{m['accuracy']:.3f}", f"{m['log_loss']:.3f}",
        )
    console.print(po)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=DEFAULT_END)
    ap.add_argument("--step-months", type=int, default=DEFAULT_STEP_MONTHS)
    ap.add_argument(
        "--cache",
        action="store_true",
        help="reuse data/rolling_dataset.parquet instead of rebuilding from Postgres",
    )
    ap.add_argument(
        "--uncorrected",
        action="store_true",
        help=(
            "run the main segment WITHOUT the v0.13.0 residual corrector and write "
            "rolling_backtest_uncorrected.json — the paired before/after on identical "
            "origins and identical data, which comparing against an older committed "
            "report cannot give you (the data grows between runs)"
        ),
    )
    args = ap.parse_args()
    if args.uncorrected:
        global CORRECTOR_ENABLED, REPORT_PATH
        CORRECTOR_ENABLED = False
        REPORT_PATH = ARTIFACTS_DIR / "rolling_backtest_uncorrected.json"
    run(args.start, args.end, args.step_months, args.cache)


if __name__ == "__main__":
    main()
