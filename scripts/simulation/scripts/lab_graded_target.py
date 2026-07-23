"""STAGE 2 — three ways to spend the graded label, measured against the gate.

The binary target resolves a 90-second knockout and a split decision with the
same bit, so the learner has no gradient separating matchups that produce
blowouts from matchups that produce coin-flips. Stage 0 (lab_dominance_probe)
established that this is not a hypothetical: in the market's 0.72+ bucket,
holding the book's own confidence fixed, the bouts we are most timid about are
disproportionately the one-sided ones (any_blowout +3.23 z, n=414).

Three ways to use `dominance_a`, all measured, one picked on val:

  soft      train on the graded label directly. LightGBM `cross_entropy` takes
            it. CatBoost `Logloss` does NOT (measured, not assumed — it raises
            "Target with classes must contain only 2 unique values"); the
            probabilistic loss there is `CrossEntropy`. sklearn's
            LogisticRegression refuses continuous labels outright, and logreg
            carries the largest blend weight, so both escapes are tried: keep
            that leg binary, or duplicate each row into (y=1, w=d) and
            (y=0, w=1-d), which is the same likelihood.
  ordinal   bucket the label into ordered levels, fit multiclass, recover
            P(A wins) by summing the levels above the middle.
  weighted  keep the binary label, weight rows by |dominance - 0.5|.

`soft` and `weighted` do NOT estimate P(A wins). `soft` estimates expected
dominance — a different quantity, compressed toward 0.5 by construction since
even a total shutout labels 0.85 — and `weighted` distorts the base rate. Both
therefore get a monotone remap fitted on val, which is exactly what
`EnsembleModel.calibrator` is for and where it sits in the served path.
Reliability is reported before and after: buying resolution by spending
calibration is not a win, and the previous lab already showed that trade
running out.

EVERYTHING IS SCORED ON THE BINARY TARGET. The graded outcome is a training
signal, not a new product. Scoring is order-averaged (as predict.py serves)
on the symmetrized frame, and gated per market-confidence bucket, because a
global number would happily sell our edge on coin-flips to buy the tail.

Usage (from scripts/simulation, venv active):
  ./venv/bin/python scripts/lab_graded_target.py --cache             # seed 42
  ./venv/bin/python scripts/lab_graded_target.py --cache --seeds 42,7,13
  ./venv/bin/python scripts/lab_graded_target.py --cache --rolling   # gate f
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import lightgbm as lgb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from catboost import CatBoostClassifier  # noqa: E402
from eval_tail_buckets import (  # noqa: E402
    EPS,
    bucket_table,
    headline,
    murphy,
)
from lab_tail_calibration import fit_family  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import log_loss  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

from src.config import (  # noqa: E402
    ARTIFACTS_DIR,
    DATA_DIR,
    FEATURE_CONTRI_OVERRIDES,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
)
from src.ensemble import ProbabilityCalibrator  # noqa: E402
from src.export import build_dataset, fetch_raw, swap_sides, symmetrize_for_training  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.train import _load_tuned_params, temporal_split  # noqa: E402

# The dominance column is new, so the shared data/dataset.parquet written by
# run_train does not have it. Separate cache, so this lab never silently reads
# a frame without the label and never disturbs the production one.
CACHE_PATH = DATA_DIR / "dataset_dominance.parquet"
OUT_PATH = ARTIFACTS_DIR / "lab_graded_target.json"

LEG_NAMES = ("lgb", "cb", "logreg")

# Ordered levels for the ordinal variant. Edges are on dominance_a and are
# symmetric about 0.5; the middle is not a level of its own because the label
# floors a win at 0.55, so nothing lands in [0.45, 0.55) except draws, which
# never reach a training row.
ORDINAL_EDGES = (0.0, 0.15, 0.32, 0.5, 0.68, 0.85, 1.0001)


# ── data ───────────────────────────────────────────────────────────────


def load_frame(use_cache: bool) -> pd.DataFrame:
    if use_cache and CACHE_PATH.exists():
        df = pd.read_parquet(CACHE_PATH)
    else:
        df = symmetrize_for_training(build_dataset(fetch_raw(), include_debuts=True))
        df.to_parquet(CACHE_PATH, index=False)
    assert "dominance_a" in df.columns, (
        f"{CACHE_PATH.name} predates the graded label — delete it and rerun"
    )
    debut = (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).astype(bool)
    df = df[~debut & df["target_a_wins"].notna()].reset_index(drop=True)
    base = float(pd.to_numeric(df["target_a_wins"]).mean())
    assert 0.40 < base < 0.60, f"base rate {base:.3f} — frame is not symmetrized"
    dom = pd.to_numeric(df["dominance_a"])
    assert dom.notna().all(), "dominance_a has nulls on completed bouts"
    assert abs(dom.mean() - 0.5) < 0.05, f"dominance mean {dom.mean():.4f}"
    assert dom.corr(pd.to_numeric(df["target_a_wins"])) > 0.5, "label direction"
    return df


def prepare(use_cache: bool) -> dict:
    df = load_frame(use_cache)
    cols = feature_names()
    X, y, meta = build_feature_matrix(df)
    X = X[cols]
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    X_sw = X_sw[cols]
    dom = pd.to_numeric(df["dominance_a"]).astype(float)

    Xs, ys, metas = temporal_split(X, y, meta)
    Xsw_s, doms, _ = temporal_split(X_sw, dom, meta)
    out = {"cols": cols, "splits": {}}
    for name in ("train", "val", "test"):
        out["splits"][name] = {
            "X": Xs[name].reset_index(drop=True),
            "X_sw": Xsw_s[name].reset_index(drop=True),
            "y": ys[name].to_numpy().astype(int),
            "dom": doms[name].to_numpy().astype(float),
            "market": metas[name]["market_prob_a"].to_numpy(dtype=float),
        }
    return out


def sharpen(dom: np.ndarray, s: float) -> np.ndarray:
    """Pull the label toward 0.5 by (1-s).

    The ladder's absolute values are a prior, not a measurement, so how hard
    the label is allowed to push is itself a parameter. s=1 is the ladder as
    defined; s=0 would be a constant 0.5 and carry nothing.
    """
    return 0.5 + s * (np.asarray(dom, dtype=float) - 0.5)


# ── legs ───────────────────────────────────────────────────────────────


def lgb_params(cols: list[str], seed: int, objective: str, num_class: int = 0) -> dict:
    p = {
        **LGB_PARAMS,
        **_load_tuned_params(),
        "objective": objective,
        "seed": seed,
        "feature_contri": [FEATURE_CONTRI_OVERRIDES.get(c, 1.0) for c in cols],
    }
    if objective == "cross_entropy":
        p["metric"] = ["cross_entropy"]
    elif objective == "multiclass":
        p["metric"] = ["multi_logloss"]
        p["num_class"] = num_class
    return p


def fit_lgb(X_tr, y_tr, X_va, y_va, cols, seed, objective, num_class=0, weight=None):
    dtr = lgb.Dataset(X_tr, label=y_tr, weight=weight)
    dva = lgb.Dataset(X_va, label=y_va, reference=dtr)
    return lgb.train(
        lgb_params(cols, seed, objective, num_class),
        dtr,
        num_boost_round=LGB_NUM_ROUNDS,
        valid_sets=[dva],
        valid_names=["val"],
        callbacks=[lgb.early_stopping(LGB_EARLY_STOPPING_ROUNDS, verbose=False)],
    )


def fit_cb(X_tr, y_tr, X_va, y_va, seed, loss, weight=None):
    model = CatBoostClassifier(
        iterations=2000,
        learning_rate=0.05,
        depth=6,
        loss_function=loss,
        eval_metric=loss,
        random_seed=seed,
        verbose=0,
        allow_writing_files=False,
        early_stopping_rounds=100,
    )
    model.fit(X_tr, y_tr, sample_weight=weight, eval_set=(X_va, y_va))
    return model


def fit_logreg(X_tr, y_tr, seed, weight=None, multinomial=False):
    means = X_tr.mean(numeric_only=True).fillna(0.0)
    Xf = X_tr.fillna(means).fillna(0.0).values.astype(np.float64)
    scaler = StandardScaler()
    Xs = scaler.fit_transform(Xf)
    clf = LogisticRegression(
        max_iter=1000 if multinomial else 500, C=0.5, solver="lbfgs" if multinomial else "liblinear",
        random_state=seed,
    )
    clf.fit(Xs, y_tr, sample_weight=weight)
    return clf, scaler, means


def logreg_predict(bundle, X: pd.DataFrame) -> np.ndarray:
    clf, scaler, means = bundle
    Xf = X.fillna(means).fillna(0.0).values.astype(np.float64)
    return clf.predict_proba(scaler.transform(Xf))


# ── variants ───────────────────────────────────────────────────────────


class Variant:
    """Three trained legs plus the blend picked on val — same recipe as
    EnsembleModel (best of logreg / mean / softmax-weighted mean on val
    log-loss), so what is measured is what production would serve."""

    def __init__(self, name: str, kind: str, legs: list, ordinal_cut: int | None = None):
        self.name = name
        self.kind = kind
        self.legs = legs
        self.ordinal_cut = ordinal_cut
        self.mode = "weighted_mean"
        self.weights = np.ones(3) / 3
        self.blender: LogisticRegression | None = None
        self.calibrator: ProbabilityCalibrator | None = None

    def leg_matrix(self, X: pd.DataFrame) -> np.ndarray:
        cols = []
        for kind, leg in self.legs:
            if kind == "lgb":
                p = leg.predict(X, num_iteration=leg.best_iteration)
            elif kind == "cb":
                p = leg.predict_proba(X)
            else:
                p = logreg_predict(leg, X)
            if self.ordinal_cut is not None:
                p = np.asarray(p)[:, self.ordinal_cut:].sum(axis=1)
            cols.append(np.asarray(p, dtype=float).ravel() if p.ndim == 1 else np.asarray(p)[:, 1])
        return np.column_stack(cols)

    def pick_blend(self, X_va: pd.DataFrame, y_va: np.ndarray) -> None:
        """Blend selection is on the BINARY val target for every variant — the
        product is still P(A wins), whatever the legs were trained on."""
        V = self.leg_matrix(X_va)
        blender = LogisticRegression(max_iter=500, C=0.1, solver="liblinear", random_state=42)
        blender.fit(V, y_va)
        per_leg = np.array([log_loss(y_va, V[:, j].clip(1e-4, 1 - 1e-4)) for j in range(V.shape[1])])
        scaled = -per_leg / max(per_leg.std(), 1e-6)
        e = np.exp(scaled - scaled.max())
        w = e / e.sum()
        opts = {
            "logreg": log_loss(y_va, blender.predict_proba(V)[:, 1].clip(1e-4, 1 - 1e-4)),
            "mean": log_loss(y_va, V.mean(axis=1).clip(1e-4, 1 - 1e-4)),
            "weighted_mean": log_loss(y_va, (V @ w).clip(1e-4, 1 - 1e-4)),
        }
        self.blender = blender
        self.weights = w
        self.mode = min(opts, key=lambda k: opts[k])
        self.val_blend_logloss = {k: float(v) for k, v in opts.items()}
        self.val_leg_logloss = dict(zip(LEG_NAMES, per_leg.tolist(), strict=True))

    def blend(self, X: pd.DataFrame) -> np.ndarray:
        V = self.leg_matrix(X)
        if self.mode == "mean":
            return V.mean(axis=1)
        if self.mode == "weighted_mean":
            return V @ self.weights
        assert self.blender is not None
        return self.blender.predict_proba(V)[:, 1]

    def served(self, split: dict, cal: ProbabilityCalibrator | None = None) -> np.ndarray:
        """P(A) as production serves it, with the calibrator applied per
        orientation INSIDE the averaging — where EnsembleModel puts it."""
        p = self.blend(split["X"])
        p_sw = self.blend(split["X_sw"])
        cal = self.calibrator if cal is None else cal
        if cal is not None:
            p, p_sw = cal.transform(p), cal.transform(p_sw)
        return 0.5 * (p + (1.0 - p_sw))


def build_variant(spec: dict, sp_tr: dict, sp_va: dict, cols: list[str], seed: int) -> Variant:
    kind = spec["kind"]
    X_tr, X_va = sp_tr["X"], sp_va["X"]
    y_tr, y_va = sp_tr["y"], sp_va["y"]
    d_tr, d_va = sharpen(sp_tr["dom"], spec.get("s", 1.0)), sharpen(sp_va["dom"], spec.get("s", 1.0))

    if kind == "binary":
        legs = [
            ("lgb", fit_lgb(X_tr, y_tr, X_va, y_va, cols, seed, "binary")),
            ("cb", fit_cb(X_tr, y_tr, X_va, y_va, seed, "Logloss")),
            ("logreg", fit_logreg(X_tr, y_tr, seed)),
        ]
        return Variant(spec["name"], kind, legs)

    if kind == "weighted":
        # Weight by how one-sided the bout was. Normalized to mean 1 so the
        # effective sample size (and the learning rate's meaning) is unchanged.
        mag = 2.0 * np.abs(sp_tr["dom"] - 0.5)
        w = np.power(mag, spec["alpha"])
        w = w / w.mean()
        legs = [
            ("lgb", fit_lgb(X_tr, y_tr, X_va, y_va, cols, seed, "binary", weight=w)),
            ("cb", fit_cb(X_tr, y_tr, X_va, y_va, seed, "Logloss", weight=w)),
            ("logreg", fit_logreg(X_tr, y_tr, seed, weight=w)),
        ]
        return Variant(spec["name"], kind, legs)

    if kind == "soft":
        legs = [
            ("lgb", fit_lgb(X_tr, d_tr, X_va, d_va, cols, seed, "cross_entropy")),
            # `Logloss` rejects continuous targets on catboost 1.2.10 —
            # `CrossEntropy` is the probabilistic-target loss.
            ("cb", fit_cb(X_tr, d_tr, X_va, d_va, seed, "CrossEntropy")),
        ]
        if spec["logreg"] == "binary":
            # Escape 1: leave the linear leg on the binary label and let the
            # blender weigh the two kinds of leg against each other.
            legs.append(("logreg", fit_logreg(X_tr, y_tr, seed)))
        else:
            # Escape 2: row duplication. (y=1, w=d) + (y=0, w=1-d) has exactly
            # the cross-entropy likelihood of a soft label, which sklearn will
            # not take directly.
            X2 = pd.concat([X_tr, X_tr], ignore_index=True)
            y2 = np.concatenate([np.ones(len(X_tr), dtype=int), np.zeros(len(X_tr), dtype=int)])
            w2 = np.concatenate([d_tr, 1.0 - d_tr])
            legs.append(("logreg", fit_logreg(X2, y2, seed, weight=w2)))
        return Variant(spec["name"], kind, legs)

    if kind == "ordinal":
        edges = np.asarray(ORDINAL_EDGES)
        lvl_tr = np.clip(np.digitize(sp_tr["dom"], edges[1:-1]), 0, len(edges) - 2)
        lvl_va = np.clip(np.digitize(sp_va["dom"], edges[1:-1]), 0, len(edges) - 2)
        k = len(edges) - 1
        cut = k // 2  # levels at or above `cut` are "A wins"
        legs = [
            ("lgb", fit_lgb(X_tr, lvl_tr, X_va, lvl_va, cols, seed, "multiclass", num_class=k)),
            ("cb", fit_cb(X_tr, lvl_tr, X_va, lvl_va, seed, "MultiClass")),
            ("logreg", fit_logreg(X_tr, lvl_tr, seed, multinomial=True)),
        ]
        return Variant(spec["name"], kind, legs, ordinal_cut=cut)

    raise ValueError(f"unknown kind {kind}")


# ── evaluation ─────────────────────────────────────────────────────────


def fit_calibrator(v: Variant, sp_va: dict, families=("temperature",)) -> ProbabilityCalibrator | None:
    """Map the variant's output back onto P(A wins), fitted on val.

    Only 1-parameter families by default: the previous lab bootstrapped this
    exact fit and found 1 parameter stable on 429 rows, 2 a coin flip and 3
    worse than doing nothing. A soft-target model needs the map for a
    structural reason rather than a cosmetic one — its target tops out at
    0.85, so its output is compressed by construction — but the val split is
    no bigger than it was.
    """
    ctx = {
        "p": v.blend(sp_va["X"]),
        "p_sw": v.blend(sp_va["X_sw"]),
        "y": sp_va["y"],
        "market": sp_va["market"],
    }
    best, best_ll = None, log_loss(
        ctx["y"], np.clip(0.5 * (ctx["p"] + 1 - ctx["p_sw"]), EPS, 1 - EPS)
    )
    for fam in families:
        cal, ll = fit_family(fam, ctx)
        if ll < best_ll:
            best, best_ll = cal, ll
    return best


def evaluate(v: Variant, splits: dict, cal: ProbabilityCalibrator | None, label: str) -> dict:
    out = {"variant": v.name, "label": label, "blend_mode": v.mode,
           "blend_weights": dict(zip(LEG_NAMES, np.asarray(v.weights).tolist(), strict=True)),
           "val_leg_logloss": getattr(v, "val_leg_logloss", {}),
           "calibrator": cal.to_dict() if cal is not None else None}
    for name in ("val", "test"):
        sp = splits[name]
        probs = v.served(sp, cal)
        y, mkt = sp["y"], sp["market"]
        has = ~np.isnan(mkt)
        out[name] = {
            "all": headline(probs, y),
            "odds": headline(probs[has], y[has]),
            "murphy": murphy(probs[has], y[has]),
            "buckets": bucket_table(probs, mkt, y),
        }
    return out


def print_variant(res: dict, base: dict | None = None) -> None:
    t, v = res["test"], res["val"]
    cal = res["calibrator"]
    cal_s = f"  cal={cal['family']}({', '.join(f'{x:.3f}' for x in cal['params'])})" if cal else ""
    print(f"\n### {res['variant']} · {res['label']}   blend={res['blend_mode']}{cal_s}")
    print(f"  val  ll {v['odds']['logloss']:.4f}  (all {v['all']['logloss']:.4f})   "
          f"test ll {t['odds']['logloss']:.4f}  acc {t['odds']['acc']:.4f}  "
          f"auc {t['odds']['auc']:.4f}  sd {t['odds']['sd']:.4f}")
    m = t["murphy"]
    print(f"  test murphy: reliability {m['reliability']:.5f}  resolution {m['resolution']:.5f}  "
          f"brier {m['brier']:.4f}")
    row = "  buckets: " + "  ".join(
        f"{b['lo']:.2f}+ {b['model']:.4f}" for b in t["buckets"]
    )
    if base is not None:
        deltas = "  ".join(
            f"{b['lo']:.2f}+ {b['model'] - a['model']:+.4f}"
            for a, b in zip(base["test"]["buckets"], t["buckets"], strict=True)
        )
        row += f"\n  vs base: {deltas}   overall {t['odds']['logloss'] - base['test']['odds']['logloss']:+.4f}"
    print(row)


# ── gate ───────────────────────────────────────────────────────────────


def gate(res: dict, base: dict) -> dict:
    """GATE 1 — every condition at once, on the static split.

    (f) rolling and (g) seed stability are checked by the caller, which has
    the other runs; everything here is readable from one pair of results.
    """
    t, b = res["test"], base["test"]
    buckets = {f"{x['lo']:.2f}": x["model"] for x in t["buckets"]}
    base_buckets = {f"{x['lo']:.2f}": x["model"] for x in b["buckets"]}
    conds = {
        "a_val_logloss_improves": res["val"]["odds"]["logloss"] < base["val"]["odds"]["logloss"],
        "b_coinflip_bucket_held": buckets["0.50"] <= base_buckets["0.50"] + 1e-4,
        "c_tail_bucket_improves": buckets["0.72"] < base_buckets["0.72"] - 1e-3,
        "d_accuracy_not_down": t["odds"]["acc"] >= b["odds"]["acc"] - 1e-9,
        "e_reliability_not_up": t["murphy"]["reliability"] <= b["murphy"]["reliability"] + 1e-5,
    }
    conds["overall_test_logloss_improves"] = t["odds"]["logloss"] < b["odds"]["logloss"]
    return conds


ROLLING_START = "2025-07-01"
ROLLING_END = "2026-07-01"
ROLLING_STEP_MONTHS = 3
ROLLING_VAL_MONTHS = 12


def run_rolling(df: pd.DataFrame, specs: list[dict], seed: int) -> dict:
    """GATE 1(f) — the same candidates on production's own retrain cadence.

    The static split scores ONE model frozen in Jan 2024 against 18 months of
    later fights; production retrains weekly. Per origin: train before
    origin-12mo, val on the 12-month tail, score the next quarter, pool. The
    calibrator is refit on each origin's val, so nothing crosses an origin.
    """
    cols = feature_names()
    X, y, meta = build_feature_matrix(df)
    X = X[cols]
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    X_sw = X_sw[cols]
    dom = pd.to_numeric(df["dominance_a"]).astype(float).to_numpy()
    dates = pd.to_datetime(meta["event_date"])
    market = meta["market_prob_a"].to_numpy(dtype=float)
    yv = y.to_numpy().astype(int)

    pooled: dict[str, dict[str, list]] = {}
    origin = pd.to_datetime(ROLLING_START)
    stop = pd.to_datetime(ROLLING_END)
    while origin < stop:
        nxt = origin + pd.DateOffset(months=ROLLING_STEP_MONTHS)
        val_start = origin - pd.DateOffset(months=ROLLING_VAL_MONTHS)
        tr = (dates < val_start).to_numpy()
        va = ((dates >= val_start) & (dates < origin)).to_numpy()
        sc = ((dates >= origin) & (dates < min(nxt, stop))).to_numpy()
        if tr.sum() < 500 or va.sum() < 50 or sc.sum() == 0:
            origin = nxt
            continue
        sp_tr = {"X": X[tr].reset_index(drop=True), "y": yv[tr], "dom": dom[tr]}
        sp_va = {
            "X": X[va].reset_index(drop=True), "X_sw": X_sw[va].reset_index(drop=True),
            "y": yv[va], "dom": dom[va], "market": market[va],
        }
        sp_sc = {
            "X": X[sc].reset_index(drop=True), "X_sw": X_sw[sc].reset_index(drop=True),
            "y": yv[sc], "dom": dom[sc], "market": market[sc],
        }
        print(f"  origin {origin.date()}  train {int(tr.sum()):5d}  val {int(va.sum()):4d}  "
              f"scored {int(sc.sum()):4d}")
        for spec in specs:
            v = build_variant(spec, sp_tr, sp_va, cols, seed)
            v.pick_blend(sp_va["X"], sp_va["y"])
            for label, cal in (("raw", None), ("calibrated", fit_calibrator(v, sp_va))):
                if label == "calibrated" and cal is None:
                    continue
                key = f"{spec['name']} · {label}"
                slot = pooled.setdefault(key, {"p": [], "y": [], "market": []})
                slot["p"].append(v.served(sp_sc, cal))
                slot["y"].append(sp_sc["y"])
                slot["market"].append(sp_sc["market"])
        origin = nxt

    out = {}
    for key, slot in pooled.items():
        p = np.concatenate(slot["p"])
        yy = np.concatenate(slot["y"])
        mk = np.concatenate(slot["market"])
        has = ~np.isnan(mk)
        out[key] = {
            "all": headline(p, yy),
            "odds": headline(p[has], yy[has]),
            "murphy": murphy(p[has], yy[has]),
            "buckets": bucket_table(p, mk, yy),
        }
    return out


def print_rolling(roll: dict) -> None:
    print(f"\n{'=' * 72}\nGATE 1(f) — rolling retrain {ROLLING_START}..{ROLLING_END}\n{'=' * 72}")
    bases = {lab: roll[k] for k in roll if k.startswith("baseline") for lab in [k.rsplit(" · ", 1)[1]]}
    n = next(iter(roll.values()))["odds"]["n"]
    print(f"  main segment, {n} scored bouts with a line")
    print(f"  {'variant':<33} {'label':<11} {'ll':>8} {'d base':>8} {'acc':>7} "
          f"{'0.50-0.55':>10} {'0.72+':>8}")
    for key, r in roll.items():
        variant, label = key.rsplit(" · ", 1)
        b = bases.get(label)
        d = r["odds"]["logloss"] - b["odds"]["logloss"] if b else 0.0
        bk = {f"{x['lo']:.2f}": x["model"] for x in r["buckets"]}
        print(f"  {variant:<33} {label:<11} {r['odds']['logloss']:>8.4f} {d:>+8.4f} "
              f"{r['odds']['acc']:>7.4f} {bk.get('0.50', float('nan')):>10.4f} "
              f"{bk.get('0.72', float('nan')):>8.4f}")


def seed_stability(all_results: dict[int, list[dict]]) -> dict:
    """GATE 1(g) — does the SIGN of the effect survive a reseed?

    Every delta is against the baseline that got the same treatment, on the
    same seed. A candidate whose sign flips across 42/7/13 has not been
    measured, it has been sampled.
    """
    seeds = list(all_results)
    names = [(r["variant"], r["label"]) for r in all_results[seeds[0]]]
    out: dict[str, dict] = {}
    for variant, label in names:
        if variant.startswith("baseline"):
            continue
        d_test, d_tail, d_coin = [], [], []
        for s in seeds:
            row = next(r for r in all_results[s] if (r["variant"], r["label"]) == (variant, label))
            b = next(
                r for r in all_results[s]
                if r["variant"].startswith("baseline") and r["label"] == label
            )
            d_test.append(row["test"]["odds"]["logloss"] - b["test"]["odds"]["logloss"])
            d_tail.append(row["test"]["buckets"][3]["model"] - b["test"]["buckets"][3]["model"])
            d_coin.append(row["test"]["buckets"][0]["model"] - b["test"]["buckets"][0]["model"])
        out[f"{variant} · {label}"] = {
            "d_test_logloss": d_test,
            "d_tail_bucket": d_tail,
            "d_coinflip_bucket": d_coin,
            # Improvement is NEGATIVE (log-loss down). Stable only if every
            # seed agrees, on the headline and on the tail bucket alike.
            "sign_stable_overall": all(x < 0 for x in d_test) or all(x > 0 for x in d_test),
            "sign_stable_tail": all(x < 0 for x in d_tail) or all(x > 0 for x in d_tail),
            "improves_every_seed": all(x < 0 for x in d_test) and all(x < 0 for x in d_tail),
        }
    return out


def print_stability(stab: dict, seeds: list[int]) -> None:
    print(f"\n{'=' * 72}\nGATE 1(g) — sign stability across seeds {seeds}\n{'=' * 72}")
    print(f"{'variant':<33} {'label':<11} {'d test ll (per seed)':<26} {'d tail bucket':<26} verdict")
    for name, s in stab.items():
        variant, label = name.rsplit(" · ", 1)
        t = " ".join(f"{x:+.4f}" for x in s["d_test_logloss"])
        tl = " ".join(f"{x:+.4f}" for x in s["d_tail_bucket"])
        if s["improves_every_seed"]:
            verdict = "improves on every seed"
        elif s["sign_stable_overall"] and s["sign_stable_tail"]:
            verdict = "stable — and stably WORSE"
        else:
            verdict = "SIGN FLIPS — not measured"
        print(f"  {variant:<31} {label:<11} {t:<26} {tl:<26} {verdict}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--seeds", default="42")
    ap.add_argument("--sharpness", default="0.5,0.75,1.0")
    ap.add_argument(
        "--rolling",
        action="store_true",
        help="gate f — re-run the surviving candidates on the rolling retrain",
    )
    args = ap.parse_args()

    seeds = [int(s) for s in args.seeds.split(",")]
    sharps = [float(s) for s in args.sharpness.split(",")]

    prepared = prepare(args.cache)
    cols, splits = prepared["cols"], prepared["splits"]
    sp_tr, sp_va = splits["train"], splits["val"]
    print(f"train {len(sp_tr['X']):,} · val {len(sp_va['X']):,} · test {len(splits['test']['X']):,}")
    lv = np.clip(np.digitize(sp_tr["dom"], np.asarray(ORDINAL_EDGES)[1:-1]), 0, len(ORDINAL_EDGES) - 2)
    print("ordinal level counts (train): " + " ".join(
        f"L{i}={int((lv == i).sum())}" for i in range(len(ORDINAL_EDGES) - 1)))

    specs: list[dict] = [{"name": "baseline (binary)", "kind": "binary"}]
    for s in sharps:
        for lr in ("binary", "duplicate"):
            specs.append({"name": f"soft s={s} logreg={lr}", "kind": "soft", "s": s, "logreg": lr})
    specs.append({"name": "ordinal 6-level", "kind": "ordinal"})
    for a in (0.5, 1.0):
        specs.append({"name": f"weighted alpha={a}", "kind": "weighted", "alpha": a})

    all_results: dict[int, list[dict]] = {}
    for seed in seeds:
        print(f"\n{'=' * 72}\nSEED {seed}\n{'=' * 72}")
        results = []
        base_raw = base_cal = None
        for spec in specs:
            v = build_variant(spec, sp_tr, sp_va, cols, seed)
            v.pick_blend(sp_va["X"], sp_va["y"])
            raw = evaluate(v, splits, None, "raw")
            if base_raw is None:
                base_raw = raw
            print_variant(raw, None if spec["kind"] == "binary" else base_raw)
            results.append(raw)
            # EVERY variant gets the same remap, the BASELINE INCLUDED.
            # Without a calibrated baseline the comparison is rigged: the
            # previous lab already measured what a val-fit temperature buys on
            # the binary model (+0.0022, tail 0.5152 -> 0.4954, and the
            # 0.50-0.55 bucket degrading), so crediting the graded label for
            # that same move would be crediting it twice.
            cal = fit_calibrator(v, sp_va)
            if cal is not None:
                res_c = evaluate(v, splits, cal, "calibrated")
                if base_cal is None:
                    base_cal = res_c
                print_variant(res_c, None if spec["kind"] == "binary" else base_cal)
                results.append(res_c)
        all_results[seed] = results

    payload = {
        "seeds": seeds,
        "sharpness": sharps,
        "ordinal_edges": list(ORDINAL_EDGES),
        "results": {str(k): v for k, v in all_results.items()},
    }
    # Gate readout — each candidate against the baseline that had the SAME
    # treatment applied to it.
    res0 = all_results[seeds[0]]
    bases = {"raw": res0[0], "calibrated": next(r for r in res0 if r["label"] == "calibrated")}
    print(f"\n{'=' * 72}\nGATE 1 (static split, seed {seeds[0]}) — vs same-treatment baseline\n{'=' * 72}")
    gates = {}
    for res in res0:
        if res["variant"].startswith("baseline"):
            continue
        g = gate(res, bases[res["label"]])
        gates[f"{res['variant']} · {res['label']}"] = g
        flag = "PASS" if all(g.values()) else "fail: " + ",".join(k for k, ok in g.items() if not ok)
        print(f"  {res['variant']:<32} {res['label']:<11} {flag}")
    payload["gates"] = gates
    if len(seeds) > 1:
        stab = seed_stability(all_results)
        print_stability(stab, seeds)
        payload["seed_stability"] = stab

    if args.rolling:
        # Only the candidates that got anywhere on the static split are worth
        # 4 more ensemble fits each; the rest are already refuted several
        # conditions over.
        keep = {"baseline (binary)", "ordinal 6-level", "weighted alpha=0.5",
                "soft s=1.0 logreg=binary"}
        roll = run_rolling(load_frame(args.cache), [s for s in specs if s["name"] in keep], seeds[0])
        print_rolling(roll)
        payload["rolling"] = roll
    OUT_PATH.write_text(json.dumps(payload, indent=2, default=float))
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()
