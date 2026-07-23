"""LAB (not production): can a round scorer learn anything the bout-level
model doesn't already have?

This is GATE 0b of the round-level-signals lab. It is a KILL TEST: if the
learned scorer can't clear the bar, Stage 4 (round-scorer features in the bout
model) is not built at all.

Three rungs, all scored on the SAME judged rounds:

  1. "round winner == bout winner" — the trivial predictor. Whatever a round
     scorer produces above this is the only thing it can contribute, because
     the bout winner is already the model's target.
  2. The four-term hand rule
     (sig_a-sig_b) + (ctrl_a-ctrl_b)/30 + 2*(td_a-td_b) + 5*(kd_a-kd_b)
     — the same four metrics opponent_ratings.RATING_METRICS already tracks.
  3. A LightGBM scorer on per-round A-B differences of every stat column.

LEAKAGE GUARDS (the whole point of the file):

  * The scrape puts the winner in slot A in 99.6% of carded bouts, so
    "always pick A" alone scores ~78% on rounds. Every input is therefore a
    DIFFERENCE (A-B) and every round is emitted in BOTH orientations with the
    label inverted, which pins the training base rate to exactly 0.500. The
    script asserts that — a base rate near 0.78 means the pipeline is leaking
    slot order and nothing below it is meaningful.
  * CV is GroupKFold on bout_id: a bout's rounds are correlated (ICC ~0.28)
    and its two orientations are the same data, so both must sit in one fold.
  * judge_name is NOT a feature — 407 raw names, absent at serve time, and
    absent entirely for finish rounds.
  * The ~2.93 judge rows per round carry an IDENTICAL feature vector, so
    rounds are de-duplicated to one row and labelled by judge majority.
    Keeping the replicas would silently weight three-judge bouts 3x.
  * Volume stats are normalized by the REAL round length (300s for a
    non-terminal round, time_finished_seconds for the terminal one) — the
    schema has no duration column.

Usage (from scripts/simulation, venv active):
  python scripts/lab_round_scorer_probe.py
  python scripts/lab_round_scorer_probe.py --min-year 2011
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

import lightgbm as lgb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.table import Table  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402

from src.config import ARTIFACTS_DIR, TRAIN_END, VAL_END  # noqa: E402
from src.db import get_connection  # noqa: E402

console = Console()

REPORT_PATH = ARTIFACTS_DIR / "lab_round_scorer_probe.json"
N_FOLDS = 5
GATE_ACCURACY = 0.86  # GATE 0b — below this, Stage 4 is not built.

# Per-(bout, fighter, round) stats plus the bout context needed to recover the
# real round length. `round_finished` is used ONLY as a duration lookup here;
# it never becomes a feature (max(round) == round_finished for 8,763/8,763
# bouts, so it IS the bout length — a hard leak if fed to a bout-level model).
ROUND_ROWS_SQL = """
SELECT
  brs.bout_id::text                AS bout_id,
  brs.fighter_id::text             AS fighter_id,
  brs.round                        AS round,
  b.fighter_a_id::text             AS fighter_a_id,
  b.fighter_b_id::text             AS fighter_b_id,
  b.winner_id::text                AS winner_id,
  b.method::text                   AS method,
  b.round_finished                 AS round_finished,
  b.time_finished_seconds          AS time_finished_seconds,
  e.date::date                     AS event_date,
  brs.sig_str_landed, brs.sig_str_attempted,
  brs.sig_str_head_landed, brs.sig_str_head_attempted,
  brs.sig_str_body_landed, brs.sig_str_body_attempted,
  brs.sig_str_legs_landed, brs.sig_str_legs_attempted,
  brs.sig_str_distance_landed, brs.sig_str_clinch_landed, brs.sig_str_ground_landed,
  brs.total_str_landed, brs.total_str_attempted,
  brs.takedowns_landed, brs.takedowns_attempted,
  brs.sub_attempts, brs.reversals, brs.knockdowns,
  brs.control_time_seconds
FROM bout_round_stats brs
JOIN bout b  ON b.id = brs.bout_id
JOIN event e ON e.id = b.event_id
WHERE e.promotion = 'ufc'
"""

# One row per (bout, round, judge). The guard drops the single 1-1 parse-error
# row and anything else outside the legal 7..10 scoring band.
SCORECARD_SQL = """
SELECT
  bs.bout_id::text AS bout_id,
  bs.round         AS round,
  bs.fighter_a_score,
  bs.fighter_b_score,
  b.fighter_a_id::text AS card_fighter_a_id
FROM bout_scorecard bs
JOIN bout b ON b.id = bs.bout_id
WHERE bs.fighter_a_score BETWEEN 7 AND 10
  AND bs.fighter_b_score BETWEEN 7 AND 10
"""

# Volume columns → normalized per minute of ACTUAL round time.
RATE_COLUMNS = [
    "sig_str_landed", "sig_str_attempted",
    "sig_str_head_landed", "sig_str_head_attempted",
    "sig_str_body_landed", "sig_str_body_attempted",
    "sig_str_legs_landed", "sig_str_legs_attempted",
    "sig_str_distance_landed", "sig_str_clinch_landed", "sig_str_ground_landed",
    "total_str_landed", "total_str_attempted",
    "takedowns_landed", "takedowns_attempted",
    "sub_attempts", "reversals", "knockdowns",
]
# Ratio columns computed per fighter-round (NaN when the denominator is 0).
RATIO_SPECS = [
    ("sig_str_acc", "sig_str_landed", "sig_str_attempted"),
    ("total_str_acc", "total_str_landed", "total_str_attempted"),
    ("td_acc", "takedowns_landed", "takedowns_attempted"),
    ("head_share", "sig_str_head_landed", "sig_str_landed"),
    ("ground_share", "sig_str_ground_landed", "sig_str_landed"),
]
# Fraction-of-round columns.
FRACTION_COLUMNS = ["control_time_seconds"]

DURATION_FLOOR_S = 30.0  # a 5-second finish must not read as 200 slpm


def _fetch(sql: str) -> pd.DataFrame:
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def round_duration(round_no: int, round_finished, time_finished) -> float:
    """Real length of one round. The schema has no duration column: a round
    before the finishing one ran the full 300s; the finishing one ran
    `time_finished_seconds`. Decisions have round_finished == the last round
    with time 300, so the same rule covers them."""
    if round_finished is None or pd.isna(round_finished):
        return 300.0
    if round_no < int(round_finished):
        return 300.0
    if time_finished is None or pd.isna(time_finished):
        return 300.0
    return float(time_finished)


def build_round_frame(min_year: int | None = None) -> pd.DataFrame:
    """One row per (bout_id, round) holding A-side and B-side per-minute rates,
    their A-B differences, and the judge-majority label where cards exist."""
    raw = _fetch(ROUND_ROWS_SQL)
    console.log(f"fetched {len(raw):,} fighter-round stat rows")

    # 48 pre-2000 bouts recorded round_finished=1 with time > 300s (the old
    # long-round format). Their duration reconstruction is wrong, so they are
    # dropped from anything rate-based.
    bad_timing = (raw["round_finished"] == 1) & (raw["time_finished_seconds"] > 300)
    n_bad = int(raw.loc[bad_timing, "bout_id"].nunique())
    raw = raw.loc[~bad_timing].reset_index(drop=True)
    console.log(f"dropped {n_bad} bouts with round_finished=1 and time > 300s (legacy format)")

    raw["duration_s"] = [
        max(DURATION_FLOOR_S, round_duration(r, rf, tf))
        for r, rf, tf in zip(
            raw["round"], raw["round_finished"], raw["time_finished_seconds"], strict=True
        )
    ]
    minutes = raw["duration_s"] / 60.0

    feat = pd.DataFrame(index=raw.index)
    for col in RATE_COLUMNS:
        feat[col] = pd.to_numeric(raw[col], errors="coerce").fillna(0.0) / minutes
    for name, num, den in RATIO_SPECS:
        n = pd.to_numeric(raw[num], errors="coerce")
        d = pd.to_numeric(raw[den], errors="coerce")
        feat[name] = np.where(d.to_numpy() > 0, n.to_numpy() / d.to_numpy().clip(1), np.nan)
    for col in FRACTION_COLUMNS:
        feat[col] = pd.to_numeric(raw[col], errors="coerce").fillna(0.0) / raw["duration_s"]

    stat_cols = list(feat.columns)

    # Raw (un-normalized) per-round counts for the four hand-rule terms — its
    # coefficients were tuned on counts, not rates, so feeding it rates would
    # silently rescale it. Emitted under an `hr_` prefix so they never reach
    # the learned scorer, which selects on the `d_` prefix.
    hand_cols = ["sig_str_landed", "control_time_seconds", "takedowns_landed", "knockdowns"]
    for col in hand_cols:
        feat[f"hrsrc_{col}"] = pd.to_numeric(raw[col], errors="coerce").fillna(0.0)

    keyed = pd.concat(
        [raw[["bout_id", "round", "fighter_id", "fighter_a_id", "winner_id",
              "method", "event_date", "duration_s"]], feat],
        axis=1,
    )
    keyed["is_a"] = keyed["fighter_id"] == keyed["fighter_a_id"]

    side_a = keyed[keyed["is_a"]].set_index(["bout_id", "round"])
    side_b = keyed[~keyed["is_a"]].set_index(["bout_id", "round"])
    common = side_a.index.intersection(side_b.index)
    side_a = side_a.loc[common]
    side_b = side_b.loc[common]

    out = pd.DataFrame(index=common)
    for col in stat_cols:
        out[f"d_{col}"] = side_a[col].to_numpy() - side_b[col].to_numpy()
    for col in hand_cols:
        out[f"hr_{col}"] = (
            side_a[f"hrsrc_{col}"].to_numpy() - side_b[f"hrsrc_{col}"].to_numpy()
        )
    out["winner_id"] = side_a["winner_id"].to_numpy()
    out["fighter_a_id"] = side_a["fighter_a_id"].to_numpy()
    out["fighter_b_id"] = side_b["fighter_id"].to_numpy()
    out["event_date"] = pd.to_datetime(side_a["event_date"].to_numpy())
    out["method"] = side_a["method"].to_numpy()
    out = out.reset_index()

    if min_year is not None:
        out = out[out["event_date"].dt.year >= min_year].reset_index(drop=True)

    # ── judge majority label ────────────────────────────────────────────
    cards = _fetch(SCORECARD_SQL)
    console.log(f"fetched {len(cards):,} judge-round rows (7-10 guard applied)")
    cards["a_win"] = (cards["fighter_a_score"] > cards["fighter_b_score"]).astype(int)
    cards["b_win"] = (cards["fighter_b_score"] > cards["fighter_a_score"]).astype(int)
    cards["ten_eight"] = (
        (cards["fighter_a_score"] - cards["fighter_b_score"]).abs() >= 2
    ).astype(int)
    agg = cards.groupby(["bout_id", "round"]).agg(
        judges=("a_win", "size"),
        a_wins=("a_win", "sum"),
        b_wins=("b_win", "sum"),
        ten_eights=("ten_eight", "sum"),
    ).reset_index()
    # Majority verdict; equal counts (or a tied round) leave no binary label.
    agg["judged_a_wins"] = np.where(
        agg["a_wins"] > agg["b_wins"], 1, np.where(agg["b_wins"] > agg["a_wins"], 0, -1)
    )
    agg["unanimous"] = (agg["a_wins"] == agg["judges"]) | (agg["b_wins"] == agg["judges"])
    agg["is_ten_eight"] = agg["ten_eights"] * 2 > agg["judges"]

    out = out.merge(agg, on=["bout_id", "round"], how="left")
    return out


def _print_baselines(judged: pd.DataFrame, split: pd.DataFrame) -> dict:
    """Rungs 1 and 2."""
    res: dict = {}

    # 1. round winner == bout winner (needs a decisive bout).
    dec = judged[judged["winner_id"].notna()]
    pred_a = (dec["winner_id"] == dec["fighter_a_id"]).astype(int)
    acc1 = float((pred_a.to_numpy() == dec["judged_a_wins"].to_numpy()).mean())
    res["bout_winner_baseline"] = {"n": int(len(dec)), "accuracy": acc1}

    # 2. four-term hand rule (the metrics opponent_ratings already tracks).
    def rule_score(df: pd.DataFrame) -> np.ndarray:
        """(sig_a-sig_b) + (ctrl_a-ctrl_b)/30 + 2*(td_a-td_b) + 5*(kd_a-kd_b)
        on RAW per-round counts — the scale its coefficients were tuned on."""
        return (
            df["hr_sig_str_landed"]
            + df["hr_control_time_seconds"] / 30.0
            + 2.0 * df["hr_takedowns_landed"]
            + 5.0 * df["hr_knockdowns"]
        ).to_numpy()

    for label, frame in (("all_judged", judged), ("split_rounds", split)):
        s = rule_score(frame)
        y = frame["judged_a_wins"].to_numpy()
        # A zero score is a coin flip; count it as a miss (conservative).
        acc = float(((s > 0).astype(int) == y).mean())
        res.setdefault("hand_rule", {})[label] = {"n": int(len(frame)), "accuracy": acc}

    # 3. "always pick A" — the slot-order control.
    res["always_a"] = {
        "n": int(len(judged)),
        "accuracy": float((judged["judged_a_wins"] == 1).mean()),
    }
    return res


def _both_orientations(
    frame: pd.DataFrame, feature_cols: list[str]
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Emit each round twice: (A-B, y) and (B-A, 1-y). Pins the base rate to
    0.500 exactly, so no amount of slot-order signal can survive."""
    d_cols = [c for c in feature_cols if c.startswith("d_")]
    ctx_cols = [c for c in feature_cols if not c.startswith("d_")]

    fwd = frame[feature_cols].copy()
    rev = frame[feature_cols].copy()
    rev[d_cols] = -rev[d_cols]
    rev[ctx_cols] = frame[ctx_cols].to_numpy()  # symmetric context is unchanged

    X = pd.concat([fwd, rev], ignore_index=True)
    y = np.concatenate(
        [frame["judged_a_wins"].to_numpy(), 1 - frame["judged_a_wins"].to_numpy()]
    )
    groups = np.concatenate([frame["bout_id"].to_numpy(), frame["bout_id"].to_numpy()])
    return X, y, groups


LGB_SCORER_PARAMS = {
    "objective": "binary",
    "metric": "binary_logloss",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 40,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 5,
    "lambda_l2": 1.0,
    "verbosity": -1,
    "seed": 42,
    "deterministic": True,
    "force_row_wise": True,
}


def run_scorer(judged: pd.DataFrame) -> dict:
    stat_diffs = [c for c in judged.columns if c.startswith("d_")]
    feature_cols = [*stat_diffs, "round"]

    X, y, groups = _both_orientations(judged, feature_cols)
    base_rate = float(y.mean())
    console.log(f"scorer train frame: {len(X):,} rows · base rate {base_rate:.4f}")
    assert abs(base_rate - 0.5) < 1e-9, (
        f"base rate {base_rate:.4f} != 0.500 — the two-orientation emit is "
        "broken and the pipeline is leaking slot order"
    )

    n_rounds = len(judged)
    oof = np.full(len(X), np.nan)
    gkf = GroupKFold(n_splits=N_FOLDS)
    for fold, (tr, te) in enumerate(gkf.split(X, y, groups)):
        dtr = lgb.Dataset(X.iloc[tr], label=y[tr])
        dte = lgb.Dataset(X.iloc[te], label=y[te], reference=dtr)
        booster = lgb.train(
            LGB_SCORER_PARAMS, dtr, num_boost_round=1500, valid_sets=[dte],
            callbacks=[lgb.early_stopping(80, verbose=False)],
        )
        oof[te] = booster.predict(X.iloc[te], num_iteration=booster.best_iteration)
        console.log(f"  fold {fold + 1}/{N_FOLDS} · best_iter {booster.best_iteration}")

    assert not np.isnan(oof).any()
    # Fold the two orientations back into one prediction per round: the
    # forward row predicts P(A), the reversed row predicts P(B) = 1 - P(A).
    p_a = 0.5 * (oof[:n_rounds] + (1.0 - oof[n_rounds:]))
    y_a = judged["judged_a_wins"].to_numpy()

    def metrics(mask: np.ndarray, label: str) -> dict:
        if mask.sum() == 0:
            return {"segment": label, "n": 0}
        p, t = p_a[mask], y_a[mask]
        acc = float(((p >= 0.5).astype(int) == t).mean())
        ll = float(-np.mean(t * np.log(p.clip(1e-6, 1 - 1e-6))
                            + (1 - t) * np.log((1 - p).clip(1e-6, 1 - 1e-6))))
        return {
            "segment": label,
            "n": int(mask.sum()),
            "accuracy": acc,
            "accuracy_se": float(np.sqrt(acc * (1 - acc) / mask.sum())),
            "log_loss": ll,
        }

    unan = judged["unanimous"].to_numpy(dtype=bool)
    out = {
        "base_rate": base_rate,
        "n_rounds": int(n_rounds),
        "groupkfold": [
            metrics(np.ones(n_rounds, dtype=bool), "all judged rounds"),
            metrics(unan, "unanimous rounds"),
            metrics(~unan, "split rounds (judges disagree)"),
            metrics(judged["is_ten_eight"].to_numpy(dtype=bool), "10-8 rounds"),
        ],
    }

    # Strict temporal holdout on top of CV: rounds from bouts before TRAIN_END
    # train, rounds from bouts on/after VAL_END are scored. Answers "is the CV
    # number just fold optimism?".
    dt = judged["event_date"]
    tr_mask = (dt < pd.to_datetime(TRAIN_END)).to_numpy()
    te_mask = (dt >= pd.to_datetime(VAL_END)).to_numpy()
    if tr_mask.sum() > 500 and te_mask.sum() > 100:
        Xtr, ytr, _ = _both_orientations(judged[tr_mask], feature_cols)
        Xte, yte, _ = _both_orientations(judged[te_mask], feature_cols)
        booster = lgb.train(
            LGB_SCORER_PARAMS, lgb.Dataset(Xtr, label=ytr), num_boost_round=400
        )
        n_te = int(te_mask.sum())
        pte = booster.predict(Xte)
        p_a_te = 0.5 * (pte[:n_te] + (1.0 - pte[n_te:]))
        y_te = judged.loc[te_mask, "judged_a_wins"].to_numpy()
        acc = float(((p_a_te >= 0.5).astype(int) == y_te).mean())
        unan_te = judged.loc[te_mask, "unanimous"].to_numpy(dtype=bool)
        split_acc = (
            float(((p_a_te[~unan_te] >= 0.5).astype(int) == y_te[~unan_te]).mean())
            if (~unan_te).any() else float("nan")
        )
        out["temporal_holdout"] = {
            "train_before": TRAIN_END, "test_from": VAL_END,
            "n_train_rounds": int(tr_mask.sum()), "n_test_rounds": n_te,
            "accuracy": acc,
            "accuracy_se": float(np.sqrt(acc * (1 - acc) / n_te)),
            "split_round_accuracy": split_acc,
            "n_split_rounds": int((~unan_te).sum()),
        }
        assert yte.mean() == 0.5

    # Feature importance — which stats the scorer actually leans on.
    full = lgb.train(
        LGB_SCORER_PARAMS, lgb.Dataset(X, label=y), num_boost_round=400
    )
    gains = dict(
        zip(full.feature_name(), full.feature_importance("gain").tolist(), strict=True)
    )
    total = sum(gains.values()) or 1.0
    out["top_features"] = [
        {"feature": k, "gain_share": v / total}
        for k, v in sorted(gains.items(), key=lambda kv: -kv[1])[:12]
    ]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--min-year", type=int, default=None,
        help="drop rounds before this year (scorecard coverage is thin before 2011)",
    )
    args = ap.parse_args()

    frame = build_round_frame(args.min_year)
    n_total = len(frame)
    judged = frame[frame["judged_a_wins"].isin([0, 1])].reset_index(drop=True)
    n_tied = int((frame["judged_a_wins"] == -1).sum())
    console.log(
        f"{n_total:,} (bout, round) pairs · {len(judged):,} with a binary judge "
        f"majority · {n_tied} tied rounds dropped"
    )

    split_rounds = judged[~judged["unanimous"].astype(bool)].reset_index(drop=True)
    console.log(
        f"{len(split_rounds):,} split rounds "
        f"({len(split_rounds) / max(1, len(judged)) * 100:.2f}% of judged)"
    )

    baselines = _print_baselines(judged, split_rounds)
    scorer = run_scorer(judged)

    table = Table(title="GATE 0b — round scorer vs baselines")
    table.add_column("Rung")
    table.add_column("Segment")
    table.add_column("N", justify="right")
    table.add_column("Accuracy", justify="right")
    table.add_row("0 · always pick A (slot control)", "all judged",
                  f"{baselines['always_a']['n']:,}",
                  f"{baselines['always_a']['accuracy']:.4f}")
    table.add_row("1 · round winner == bout winner", "decisive bouts",
                  f"{baselines['bout_winner_baseline']['n']:,}",
                  f"{baselines['bout_winner_baseline']['accuracy']:.4f}")
    for seg, m in baselines["hand_rule"].items():
        table.add_row("2 · four-term hand rule", seg, f"{m['n']:,}",
                      f"{m['accuracy']:.4f}")
    for m in scorer["groupkfold"]:
        if m["n"] == 0:
            continue
        table.add_row("3 · LightGBM scorer (GroupKFold)", m["segment"],
                      f"{m['n']:,}",
                      f"{m['accuracy']:.4f} ±{m['accuracy_se'] * 100:.2f}pp")
    if "temporal_holdout" in scorer:
        th = scorer["temporal_holdout"]
        table.add_row("3b · LightGBM scorer (temporal holdout)",
                      f"bouts >= {th['test_from']}", f"{th['n_test_rounds']:,}",
                      f"{th['accuracy']:.4f} ±{th['accuracy_se'] * 100:.2f}pp")
    console.print(table)

    overall = next(m for m in scorer["groupkfold"] if m["segment"] == "all judged rounds")
    split_m = next(m for m in scorer["groupkfold"] if m["segment"].startswith("split"))
    rule_split = baselines["hand_rule"]["split_rounds"]["accuracy"]
    passed = overall["accuracy"] >= GATE_ACCURACY and split_m["accuracy"] > rule_split
    verdict = "PASS" if passed else "FAIL"
    console.print(
        f"\n[bold]GATE 0b: {verdict}[/bold] — scorer {overall['accuracy']:.4f} "
        f"vs gate {GATE_ACCURACY:.2f}; split rounds {split_m['accuracy']:.4f} "
        f"vs hand rule {rule_split:.4f}"
    )
    console.print(
        "[dim]FAIL means Stage 4 (round-scorer features in the bout model) is "
        "not built — a scorer that can't beat the hand rule on the rounds the "
        "judges themselves disagree about has no information to contribute.[/dim]"
        if not passed else ""
    )

    payload = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "min_year": args.min_year,
        "n_bout_rounds_total": int(n_total),
        "n_judged_rounds": int(len(judged)),
        "n_tied_dropped": n_tied,
        "n_split_rounds": int(len(split_rounds)),
        "baselines": baselines,
        "scorer": scorer,
        "gate": {
            "threshold_accuracy": GATE_ACCURACY,
            "scorer_accuracy": overall["accuracy"],
            "scorer_split_accuracy": split_m["accuracy"],
            "hand_rule_split_accuracy": rule_split,
            "passed": bool(passed),
        },
    }
    REPORT_PATH.write_text(json.dumps(payload, indent=2, default=str))
    console.log(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()
