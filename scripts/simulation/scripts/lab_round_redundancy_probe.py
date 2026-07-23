"""LAB (not production): is a round-level aggregate new information, or a
re-packaging of features the bout model already carries?

This is GATE 0c of the round-level-signals lab. The control hypothesis is
specific: `str_off/str_def`, `grap_off/grap_def`, `kd_off/kd_def`,
`ctrl_off/ctrl_def` (features.py) are online opponent-adjusted ratings over
RATING_METRICS = ("str", "grap", "kd", "ctrl") — the exact four metrics the
four-term round rule uses. If that is right, a per-fighter round-win aggregate
should add ~nothing on top of them.

Setup
-----
TARGET   judged round share for side A on a carded bout: rounds A won by judge
         majority / rounds scored. This is the bout-level quantity any Stage-3
         or Stage-4 feature would ultimately be trying to move.
INPUTS   the production feature list (features.feature_names()), plus a
         point-in-time round aggregate built by CHRONOLOGICAL REPLAY —
         per fighter, the win rate and mean margin over every round they have
         fought BEFORE this bout, snapshotted pre-bout exactly like
         opponent_ratings.compute_rating_snapshots. Never a pandas merge on
         bout_id: that would hand the model this bout's own rounds.

The per-round scorer used for the aggregate is the deterministic four-term
hand rule, not a fitted model. It scores 0.828 on judged rounds vs 0.843 for
the LightGBM scorer (lab_round_scorer_probe.py) — within a point and a half —
and being unfitted it cannot leak fold structure into this measurement.

R2 is reported OUT-OF-FOLD (KFold, Ridge). In-sample R2 rises mechanically
with every column added and would make any feature look useful.

Usage (from scripts/simulation, venv active):
  python scripts/lab_round_redundancy_probe.py
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.table import Table  # noqa: E402
from sklearn.linear_model import RidgeCV  # noqa: E402
from sklearn.model_selection import KFold, cross_val_predict  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402

console = Console()

REPORT_PATH = ARTIFACTS_DIR / "lab_round_redundancy_probe.json"
CACHE_PATH = DATA_DIR / "rolling_dataset.parquet"
GATE_DELTA_R2 = 0.02  # GATE 0c — below this the aggregate is a re-packaging.
N_FOLDS = 5

# The eight opponent-adjusted rating diffs the control hypothesis names.
RATING_DIFFS = [
    "diff_str_off", "diff_str_def", "diff_grap_off", "diff_grap_def",
    "diff_kd_off", "diff_kd_def", "diff_ctrl_off", "diff_ctrl_def",
]

# Per-(bout, fighter, round) raw counts for the four-term rule, in event order
# so the replay below is chronological by construction.
ROUND_SQL = """
SELECT
  brs.bout_id::text     AS bout_id,
  brs.fighter_id::text  AS fighter_id,
  brs.round             AS round,
  e.date::date          AS event_date,
  b.bout_order          AS bout_order,
  COALESCE(brs.sig_str_landed, 0)      AS sig,
  COALESCE(brs.control_time_seconds,0) AS ctrl,
  COALESCE(brs.takedowns_landed, 0)    AS td,
  COALESCE(brs.knockdowns, 0)          AS kd
FROM bout_round_stats brs
JOIN bout b  ON b.id = brs.bout_id
JOIN event e ON e.id = b.event_id
WHERE e.promotion = 'ufc'
ORDER BY e.date ASC, b.bout_order ASC NULLS LAST, b.id ASC, brs.round ASC
"""

# Judge-majority round winner per (bout, round, fighter).
CARD_SQL = """
SELECT
  bs.bout_id::text       AS bout_id,
  bs.round               AS round,
  b.fighter_a_id::text   AS fighter_a_id,
  b.fighter_b_id::text   AS fighter_b_id,
  SUM(CASE WHEN bs.fighter_a_score > bs.fighter_b_score THEN 1 ELSE 0 END) AS a_wins,
  SUM(CASE WHEN bs.fighter_b_score > bs.fighter_a_score THEN 1 ELSE 0 END) AS b_wins
FROM bout_scorecard bs
JOIN bout b ON b.id = bs.bout_id
WHERE bs.fighter_a_score BETWEEN 7 AND 10
  AND bs.fighter_b_score BETWEEN 7 AND 10
GROUP BY bs.bout_id, bs.round, b.fighter_a_id, b.fighter_b_id
"""


def _fetch(sql: str) -> pd.DataFrame:
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def judged_round_share() -> pd.DataFrame:
    """Per (bout_id, fighter_id): rounds won by judge majority / rounds scored."""
    cards = _fetch(CARD_SQL)
    console.log(f"{len(cards):,} carded (bout, round) pairs")
    rows: list[dict] = []
    for r in cards.itertuples(index=False):
        if r.a_wins == r.b_wins:
            continue  # tied round — no binary verdict
        winner = r.fighter_a_id if r.a_wins > r.b_wins else r.fighter_b_id
        for fid in (r.fighter_a_id, r.fighter_b_id):
            rows.append(
                {"bout_id": r.bout_id, "fighter_id": fid, "won": int(fid == winner)}
            )
    df = pd.DataFrame(rows)
    agg = df.groupby(["bout_id", "fighter_id"])["won"].agg(["sum", "count"])
    agg["round_share"] = agg["sum"] / agg["count"]
    return agg.reset_index().rename(columns={"count": "scored_rounds"})


def replay_round_aggregates() -> dict[tuple[str, str], dict[str, float]]:
    """CHRONOLOGICAL REPLAY. For each (bout_id, fighter_id) returns the
    fighter's round record over every PRIOR bout — never this one. Same
    pre-bout snapshot discipline as opponent_ratings.compute_rating_snapshots
    (snapshot first, update after), which is the only thing keeping this
    leak-free; a merge on bout_id would silently include the target bout."""
    rounds = _fetch(ROUND_SQL)
    console.log(f"{len(rounds):,} fighter-round rows for the replay")

    # Group rounds by bout, preserving the SQL's chronological bout order.
    by_bout: dict[str, dict[int, list]] = {}
    for r in rounds.itertuples(index=False):
        by_bout.setdefault(r.bout_id, {}).setdefault(r.round, []).append(r)

    state: dict[str, dict[str, float]] = defaultdict(
        lambda: {"rounds": 0.0, "won": 0.0, "margin_sum": 0.0}
    )
    snaps: dict[tuple[str, str], dict[str, float]] = {}

    for bid, rounds_of_bout in by_bout.items():
        fighters = sorted(
            {r.fighter_id for rows in rounds_of_bout.values() for r in rows}
        )
        if len(fighters) != 2:
            continue
        # 1. SNAPSHOT (strictly pre-bout) — before any of this bout's rounds
        # touch the running state. This ordering IS the leak guarantee.
        for fid in fighters:
            s = state[fid]
            n = s["rounds"]
            snaps[(bid, fid)] = {
                "prior_rounds": n,
                "prior_round_win_rate": (s["won"] / n) if n > 0 else np.nan,
                "prior_round_margin": (s["margin_sum"] / n) if n > 0 else np.nan,
            }
        # 2. UPDATE with this bout's rounds. The four-term rule is evaluated on
        # the pair's count difference and negated for the other side, so no
        # scrape slot enters the aggregate.
        f0, f1 = fighters
        for rnd in sorted(rounds_of_bout):
            by_fid = {r.fighter_id: r for r in rounds_of_bout[rnd]}
            if f0 not in by_fid or f1 not in by_fid:
                continue
            a, b = by_fid[f0], by_fid[f1]
            margin = (
                (a.sig - b.sig)
                + (a.ctrl - b.ctrl) / 30.0
                + 2.0 * (a.td - b.td)
                + 5.0 * (a.kd - b.kd)
            )
            for fid, sign in ((f0, 1.0), (f1, -1.0)):
                s = state[fid]
                s["rounds"] += 1.0
                s["won"] += 1.0 if sign * margin > 0 else 0.0
                s["margin_sum"] += sign * margin
    console.log(f"replayed {len(by_bout):,} bouts → {len(snaps):,} pre-bout snapshots")
    return snaps


def _cv_r2(X: pd.DataFrame, y: np.ndarray, seed: int = 42) -> float:
    """Out-of-fold R2. In-sample R2 rises with every column added and would
    make any feature look useful, so it is never reported as the result."""
    model = make_pipeline(
        StandardScaler(),
        RidgeCV(alphas=np.logspace(-2, 4, 25)),
    )
    Xf = X.fillna(X.median(numeric_only=True)).fillna(0.0)
    kf = KFold(n_splits=N_FOLDS, shuffle=True, random_state=seed)
    pred = cross_val_predict(model, Xf, y, cv=kf)
    ss_res = float(((y - pred) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    return 1.0 - ss_res / ss_tot


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache", action="store_true", default=True)
    ap.parse_args()

    if CACHE_PATH.exists():
        console.log(f"loading cached dataset from {CACHE_PATH}")
        df = pd.read_parquet(CACHE_PATH)
    else:
        df = symmetrize_for_training(build_dataset(fetch_raw(), include_debuts=True))

    df = df[df["target_a_wins"].notna()].reset_index(drop=True)
    X, _, meta = build_feature_matrix(df)
    cols = feature_names()
    X = X[cols]

    # ── target: judged round share for the DATASET's side A ─────────────
    share = judged_round_share()
    share_map = {
        (r.bout_id, r.fighter_id): (r.round_share, r.scored_rounds)
        for r in share.itertuples(index=False)
    }
    tgt = np.full(len(df), np.nan)
    n_rounds_scored = np.zeros(len(df))
    for i in range(len(df)):
        key = (df["bout_id"].iloc[i], df["fighter_a_id"].iloc[i])
        hit = share_map.get(key)
        if hit is not None:
            tgt[i], n_rounds_scored[i] = hit
    has_target = ~np.isnan(tgt)
    console.log(
        f"{int(has_target.sum()):,} of {len(df):,} dataset bouts carry a judged "
        f"round share (the rest are finishes or pre-2006 cards)"
    )

    # ── point-in-time round aggregates ──────────────────────────────────
    snaps = replay_round_aggregates()
    agg_cols = ["prior_rounds", "prior_round_win_rate", "prior_round_margin"]
    extra = pd.DataFrame(index=df.index, columns=[f"rd_{c}" for c in agg_cols], dtype=float)
    for i in range(len(df)):
        bid = df["bout_id"].iloc[i]
        sa = snaps.get((bid, df["fighter_a_id"].iloc[i]))
        sb = snaps.get((bid, df["fighter_b_id"].iloc[i]))
        if sa is None or sb is None:
            continue
        for c in agg_cols:
            extra.loc[i, f"rd_{c}"] = sa[c] - sb[c]
    coverage = extra["rd_prior_round_win_rate"].notna().mean()
    console.log(f"round-aggregate coverage on dataset rows: {coverage * 100:.1f}%")

    y = tgt[has_target]
    Xs = X.loc[has_target].reset_index(drop=True)
    Xe = extra.loc[has_target].reset_index(drop=True)
    n = int(has_target.sum())

    variants = {
        "rating diffs only (8 cols)": Xs[RATING_DIFFS],
        "round aggregate only (3 cols)": Xe,
        f"production features ({len(cols)} cols)": Xs,
        "production + round aggregate": pd.concat([Xs, Xe], axis=1),
        "production MINUS rating diffs": Xs.drop(columns=RATING_DIFFS),
        "production MINUS rating diffs + round aggregate": pd.concat(
            [Xs.drop(columns=RATING_DIFFS), Xe], axis=1
        ),
    }
    results: dict[str, dict] = {}
    var_y = float(np.var(y))
    for name, mat in variants.items():
        r2 = _cv_r2(mat, y)
        results[name] = {
            "n_features": int(mat.shape[1]),
            "cv_r2": r2,
            "residual_variance": var_y * (1.0 - r2),
        }
        console.log(f"  {name}: R2 {r2:+.4f}")

    delta = (
        results["production + round aggregate"]["cv_r2"]
        - results[f"production features ({len(cols)} cols)"]["cv_r2"]
    )
    substitute_delta = (
        results["production MINUS rating diffs + round aggregate"]["cv_r2"]
        - results["production MINUS rating diffs"]["cv_r2"]
    )

    table = Table(title=f"GATE 0c — judged round share, out-of-fold R2 (n={n:,})")
    table.add_column("Feature set")
    table.add_column("cols", justify="right")
    table.add_column("CV R2", justify="right")
    table.add_column("Resid. var", justify="right")
    for name, m in results.items():
        table.add_row(name, str(m["n_features"]), f"{m['cv_r2']:+.4f}",
                      f"{m['residual_variance']:.4f}")
    console.print(table)
    console.print(
        f"target variance {var_y:.4f} · "
        f"incremental R2 from the round aggregate over the full production set: "
        f"[bold]{delta:+.4f}[/bold] (gate {GATE_DELTA_R2:.2f})"
    )
    console.print(
        f"when the 8 opponent-adjusted rating diffs are REMOVED, the round "
        f"aggregate recovers {substitute_delta:+.4f} R2 — how much of its content "
        f"those ratings were already carrying"
    )

    passed = delta >= GATE_DELTA_R2
    verdict = (
        "round aggregates carry information the production features miss"
        if passed
        else "round aggregates are a re-packaging of features already in X; "
             "Stage 3 and Stage 4 are not justified on this evidence"
    )
    console.print(f"\n[bold]GATE 0c: {'PASS' if passed else 'FAIL'}[/bold] — {verdict}")

    payload = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "n_bouts_with_judged_share": n,
        "target_variance": var_y,
        "aggregate_coverage": float(coverage),
        "variants": results,
        "gate": {
            "threshold_delta_r2": GATE_DELTA_R2,
            "delta_r2_over_production": delta,
            "delta_r2_without_rating_diffs": substitute_delta,
            "passed": bool(passed),
        },
    }
    REPORT_PATH.write_text(json.dumps(payload, indent=2, default=str))
    console.log(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()
