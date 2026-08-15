"""LAB — where does the model actually beat the closing line?

The question this lab exists for is not "is the model good", it is "is there a
SEGMENT of bouts on which our number is better than the book's". Those are
different questions, and the second one is much easier to answer wrongly: slice
1,200 bouts finely enough and roughly half the slices come out ahead by pure
noise. A search that reports the winners without reporting how many slices it
opened has found nothing at all.

So the lab is a pre-registered search, not a hunt:

  1. POOL      walk-forward out-of-fold probabilities at production's own
               retrain cadence, over the whole span the data covers. Nothing
               here is scored by a model that saw it.
  2. FRAME     the pool joined to per-bout context, plus a point-in-time STYLE
               taxonomy built from career-to-date stats only.
  3. SCAN      every segment definition is declared UP FRONT
               (`lab_edge_registry.py`), measured the same way, and reported
               together — winners and losers — with a Benjamini-Hochberg
               correction over the whole family and a per-segment detection
               floor.
  4. CONFIRM   whatever survives the scan on the DISCOVERY window is read once
               on the CONFIRMATION window, which the scan never touches.
  5. MONEY     log-loss is not profit. Survivors are priced against the real
               vigged closing decimals from `bout_external_odds`.

Discovery / confirmation split in TIME, not at random: an edge that existed
only because 2021-2023 was 2021-2023 is not an edge, and a random split would
hide exactly that.

Usage (scripts/simulation, venv active):
  python scripts/lab_edge_segments.py --stage pool [--seeds 42,7,13,99,2024]
  python scripts/lab_edge_segments.py --stage scan
  python scripts/lab_edge_segments.py --stage confirm
  python scripts/lab_edge_segments.py --stage money
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

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from eval_tail_buckets import load_symmetrized  # noqa: E402
from lab_edge_common import Segment, build_frame  # noqa: E402
from lab_edge_encompass import (  # noqa: E402
    add_blend,
    encompassing,
    encompassing_by_segment,
    shrinkage,
)
from lab_edge_stats import bh_fdr, per_bout_logloss, score_segment  # noqa: E402
from lab_winner_common import walk_forward  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402

ARTIFACT_PATH = ARTIFACTS_DIR / "lab_edge_segments.json"

# The span starts in 2016 rather than at the dataset's own start because the
# comparison this lab makes needs a closing line on the other side of it, and
# `bout_external_odds` is thin before 2021 today. 2016 is the hedge: the odds
# backfill is idempotent and can be re-run over the full history, and when it
# is, the OOF probabilities for those years are already sitting here.
POOL_START = "2016-01-01"
POOL_END = "2026-12-01"
DISCOVERY_END = "2025-01-01"

DEFAULT_SEEDS = (42, 7, 13, 99, 2024)
PRIMARY_SEED = 42  # what production serves; the rest are the stability check


def pool_path(seed: int) -> Path:
    """One file per seed — seeds can then be produced by separate processes
    without racing on a shared parquet. The scan globs them back together."""
    return DATA_DIR / f"lab_edge_pool_seed{seed}.parquet"


# ── stage: pool ────────────────────────────────────────────────────────


def run_pool(seeds: list[int], start: str, end: str, append: bool) -> None:
    """Walk-forward OOF probabilities over the full span, per seed.

    Uses `lab_winner_common.walk_forward` unchanged — the same object the
    winner-leg labs select on — so any number this lab prints is comparable
    with `docs/winner_batch.md` rather than being a re-implementation of it.
    """
    df = load_symmetrized(use_cache=True)
    print(f"frame: {len(df)} both-experienced completed bouts, "
          f"{pd.to_datetime(df['event_date']).min().date()} → "
          f"{pd.to_datetime(df['event_date']).max().date()}", flush=True)

    for seed in seeds:
        out = pool_path(seed)
        if append and out.exists():
            print(f"seed {seed}: {out.name} exists, skipping", flush=True)
            continue
        print(f"\n── seed {seed} ─────────────────────────────────────────", flush=True)
        pool = walk_forward(df, label="served_recipe", seed=seed,
                            start=start, end=end, verbose=True)
        pool.to_parquet(out, index=False)
        print(f"  wrote {out} ({len(pool)} rows)", flush=True)


# ── the grid ───────────────────────────────────────────────────────────


def load_segments() -> list[Segment]:
    """The registry, with EXPRESSION duplicates collapsed.

    Asserting unique names is not enough — two lenses independently proposed
    `scheduled_rounds == 5` and two more proposed `is_women == 1`. Scoring the
    same slice twice prints the same row twice and, worse, charges the BH
    correction for 86 tests when 84 were performed. The registry keeps both
    entries, because it is the record of what was proposed; the scan scores
    the first and says so.
    """
    from lab_edge_registry import SEGMENTS

    segs = [Segment(**s) for s in SEGMENTS]
    names = [s.name for s in segs]
    assert len(names) == len(set(names)), "duplicate segment names in the registry"

    seen: dict[tuple[str, bool], str] = {}
    keep, dropped = [], []
    for s in segs:
        key = (" ".join(s.expr_a.split()), s.symmetric)
        if key in seen:
            dropped.append((s.name, seen[key]))
            continue
        seen[key] = s.name
        keep.append(s)
    for dup, orig in dropped:
        print(f"  collapsed duplicate expression: {dup} == {orig}")
    return keep


def seed_windows(frame: pd.DataFrame, seeds: list[int]) -> dict[tuple[str, int], pd.DataFrame]:
    """Per (window, seed) frames, with the blend already attached.

    `add_blend` is applied to one seed at a time. Fitting it on the stacked
    five-seed frame would feed the same bout in five times and shrink every
    standard error downstream by roughly √5 for no information at all.
    """
    out = {}
    for seed in seeds:
        one = frame[frame["seed"] == seed].reset_index(drop=True)
        one = add_blend(one)
        for which in ("discovery", "confirm"):
            sel = np.array(one["has_market"].to_numpy(), dtype=bool)
            disc = np.array(one["is_discovery"].to_numpy(), dtype=bool)
            sel &= disc if which == "discovery" else ~disc
            out[(which, seed)] = one[sel].reset_index(drop=True)
    return out


def evaluate_grid(
    wins: dict[tuple[str, int], pd.DataFrame], segs: list[Segment], which: str, seeds: list[int]
) -> pd.DataFrame:
    """Score every segment on one window, primary seed, plus stability legs."""
    base = wins[(which, PRIMARY_SEED)]
    rows = []
    for seg in segs:
        a, b = seg.mask(base)
        row = {"name": seg.name, "family": seg.family, "symmetric": seg.symmetric,
               "expr_a": seg.expr_a, "hypothesis": seg.hypothesis}
        row.update(score_segment(base, a, b, symmetric=seg.symmetric))

        # The high-power test: does our forecast add MORE on top of the price
        # inside this segment than outside it? Every bout in the window takes
        # part in this estimate, not only the segment's own.
        if row.get("n", 0) >= 30:
            enc = encompassing_by_segment(base, a | b)
            row.update({f"enc_{k}": v for k, v in enc.items()})
            # The deployable object, on the same rows.
            blend = base["p_blend"].to_numpy(dtype=float)
            ok = np.isfinite(blend)
            sub = base[ok].reset_index(drop=True)
            sel_ok = (a | b)[ok]
            if sel_ok.sum() >= 20:
                rb = score_segment(sub, sel_ok, sel_ok, symmetric=True, prob_col="p_blend")
                row["blend_delta"] = rb.get("delta", np.nan)
                row["blend_delta_se"] = rb.get("delta_se", np.nan)
                row["blend_p_value"] = rb.get("p_value", np.nan)
                for k in ("roi_00", "roi_00_n", "roi_05", "roi_05_n"):
                    row[f"blend_{k}"] = rb.get(k, np.nan)

        # Seed stability — the same segment under the OTHER model seeds. The
        # primary seed is excluded from its own agreement count; including it
        # put a floor of 1/len(seeds) under the statistic and made it print
        # 1.0 for all 89 segments.
        deltas = []
        for s in seeds:
            if s == PRIMARY_SEED:
                continue
            f2 = wins[(which, s)]
            a2, b2 = seg.mask(f2)
            r2 = score_segment(f2, a2, b2, symmetric=seg.symmetric)
            deltas.append(r2.get("delta", np.nan))
        deltas = np.array(deltas, dtype=float)
        row["seed_deltas"] = [None if not np.isfinite(d) else round(float(d), 4) for d in deltas]
        row["seed_sign_stable"] = (
            float(np.mean(np.sign(deltas) == np.sign(row.get("delta", np.nan))))
            if len(deltas) else float("nan")
        )

        # Era stability — the two halves of the window, split at its median date.
        if row.get("n", 0) >= 40:
            cut = base["event_date"].median()
            for half, m in (("early", base["event_date"] < cut), ("late", base["event_date"] >= cut)):
                mm = m.to_numpy()
                sub = base[mm].reset_index(drop=True)
                r3 = score_segment(sub, (a & mm)[mm], (b & mm)[mm], symmetric=seg.symmetric)
                row[f"delta_{half}"] = r3.get("delta", np.nan)
                row[f"n_{half}"] = r3.get("n", 0)
        rows.append(row)

    out = pd.DataFrame(rows)
    # The multiplicity correction is charged to the PRE-REGISTERED family only.
    # Folding the three post-hoc rows in would let a slice that was chosen by
    # looking at the answer make the other 86 look worse, which is exactly
    # backwards — and it would also lend those three a q-value they have not
    # earned. They are reported with their raw p and no q.
    pre = (out["family"] != "post_hoc").to_numpy()
    for src, dst in (("p_value", "q_value"), ("p_value_adj", "q_value_adj"),
                     ("enc_c_delta_p", "enc_q_value")):
        if src not in out.columns:
            continue
        p = out[src].to_numpy(dtype=float).copy()
        p[~pre] = np.nan
        out[dst] = bh_fdr(p)
    return out


# ── reporting ──────────────────────────────────────────────────────────


def print_headline(wins: dict, windows: tuple[str, ...]) -> None:
    """Headline numbers for the window being run — and ONLY that window.

    This used to loop over both unconditionally, so `--stage scan` printed the
    2025-26 log-loss, γ and encompassing c. A protocol that reserves a window
    and then prints it at the top of the other stage is not reserving anything.
    """
    print(f"\n{'=' * 100}\nHEADLINE — the model, the closing line, and the two combined\n{'=' * 100}")
    for which in windows:
        f = wins[(which, PRIMARY_SEED)]
        if not len(f):
            continue
        ll_m = per_bout_logloss(f["p"], f["y"]).mean()
        ll_k = per_bout_logloss(f["market"], f["y"]).mean()
        ok = np.isfinite(f["p_blend"].to_numpy(dtype=float))
        ll_b = per_bout_logloss(f.loc[ok, "p_blend"], f.loc[ok, "y"]).mean()
        s, e = shrinkage(f), encompassing(f)
        print(f"\n  {which.upper():<11} n={len(f):<5} events={f['event_id'].nunique()}")
        print(f"    log-loss   model {ll_m:.4f}   market {ll_k:.4f}   blend {ll_b:.4f}   "
              f"(model − market {ll_m - ll_k:+.4f})")
        print(f"    accuracy   model {(np.round(f['p']) == f['y']).mean():.3f}   "
              f"market {(np.round(f['market']) == f['y']).mean():.3f}")
        print(f"    γ (share of our disagreement that is signal)  {s['gamma']:+.3f}  "
              f"95% CI [{s['lo']:+.3f}, {s['hi']:+.3f}]  p={s['p_value']:.3f}")
        print(f"    encompassing  b·market {e['b_market']:+.3f} (p={e['b_market_p']:.4f})   "
              f"c·model {e['c_model']:+.3f} (p={e['c_model_p']:.4f})")


def print_grid(res: pd.DataFrame, title: str) -> None:
    print(f"\n{'=' * 118}\n{title}\n{'=' * 118}")
    print(f"  {'segment':42s} {'n':>4} {'model':>7} {'market':>7} {'Δ':>8} "
          f"{'95% CI':>17} {'Δadj':>8} {'q':>6} {'MDE':>7} {'seeds':>6}")
    show = res.sort_values("delta").reset_index(drop=True)
    for _, r in show.iterrows():
        if not np.isfinite(r.get("delta", np.nan)):
            print(f"  {r['name']:42s} {int(r['n']):>4}  — too small —")
            continue
        ci = f"[{r['delta_lo']:+.3f},{r['delta_hi']:+.3f}]"
        print(f"  {r['name']:42s} {int(r['n']):>4} {r['logloss_model']:7.4f} {r['logloss_market']:7.4f} "
              f"{r['delta']:+8.4f} {ci:>17} {r['delta_adj']:+8.4f} {r['q_value']:6.3f} "
              f"{r['mde']:7.4f} {r['seed_sign_stable']:6.1f}")


def print_direction(res: pd.DataFrame) -> None:
    d = res[~res["symmetric"] & res["model_p_side"].notna()].copy()
    if not len(d):
        return
    d["gap"] = d["model_bias"].abs() - d["market_bias"].abs()
    d = d.sort_values("market_bias")
    print(f"\n{'=' * 110}\nDIRECTION — the named side, oriented into slot A\n{'=' * 110}")
    print(f"  {'segment':42s} {'n':>4} {'drop':>5} {'model p':>8} {'mkt p':>7} {'actual':>7} "
          f"{'mod−act':>8} {'mkt−act':>8}")
    for _, r in d.iterrows():
        print(f"  {r['name']:42s} {int(r['n_direction']):>4} {int(r['n_direction_dropped']):>5} "
              f"{r['model_p_side']:8.3f} {r['market_p_side']:7.3f} "
              f"{r['actual_side']:7.3f} {r['model_bias']:+8.3f} {r['market_bias']:+8.3f}")


def print_money(res: pd.DataFrame) -> None:
    print(f"\n{'=' * 100}\nMONEY — flat stakes into the real closing decimals (vig included)\n{'=' * 100}")
    print(f"  {'segment':42s} {'bets@0':>7} {'ROI':>8} {'bets@5%':>8} {'ROI':>8} {'bets@10%':>9} {'ROI':>8}")
    for _, r in res.sort_values("roi_05", ascending=False).iterrows():
        if not np.isfinite(r.get("roi_00", np.nan)):
            continue
        def f(v):
            return "     —" if not np.isfinite(v) else f"{v:+7.1%}"
        print(f"  {r['name']:42s} {int(r['roi_00_n']):>7} {f(r['roi_00']):>8} "
              f"{int(r['roi_05_n']):>8} {f(r['roi_05']):>8} {int(r['roi_10_n']):>9} {f(r['roi_10']):>8}")


# ── stages ─────────────────────────────────────────────────────────────


def print_encompass(res: pd.DataFrame) -> None:
    if "enc_c_delta" not in res.columns:
        return
    print(f"\n{'=' * 112}\nINCREMENTAL INFORMATION — c = c₀ + c₁·segment. c₁ > 0 means our forecast "
          f"adds MORE on top of the price here\n{'=' * 112}")
    print(f"  {'segment':42s} {'n':>4} {'c out':>7} {'c in':>7} {'c₁':>8} "
          f"{'95% CI':>19} {'p':>7} {'q':>6}")
    for _, r in res.sort_values("enc_c_delta", ascending=False).iterrows():
        if not np.isfinite(r.get("enc_c_delta", np.nan)):
            continue
        ci = f"[{r['enc_c_delta_lo']:+.2f},{r['enc_c_delta_hi']:+.2f}]"
        print(f"  {r['name']:42s} {int(r['n']):>4} {r['enc_c_base']:+7.3f} {r['enc_c_in']:+7.3f} "
              f"{r['enc_c_delta']:+8.3f} {ci:>19} {r['enc_c_delta_p']:7.4f} "
              f"{r.get('enc_q_value', float('nan')):6.3f}")


def _run(which: str, seeds: list[int]) -> dict:
    frame, scale = build_frame(seeds, discovery_end=DISCOVERY_END)
    segs = load_segments()
    print(f"\ngrid: {len(segs)} pre-registered segments, "
          f"{len({s.family for s in segs})} families")
    wins = seed_windows(frame, seeds)
    print_headline(wins, (which,))
    res = evaluate_grid(wins, segs, which, seeds)
    label = ("DISCOVERY ≤2024 — Δ = model log-loss − market log-loss (negative = we are better)"
             if which == "discovery"
             else "CONFIRMATION 2025-2026 — read once, after discovery closed")
    print_grid(res, label)
    print_encompass(res)
    print_direction(res)
    print_money(res)
    return {
        "window": which,
        "style_scale": {"strike_cut": scale.strike_cut, "grapple_cut": scale.grapple_cut},
        "segments": json.loads(res.to_json(orient="records")),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True,
                    choices=["pool", "scan", "confirm"])
    ap.add_argument("--seeds", default=",".join(str(s) for s in DEFAULT_SEEDS))
    ap.add_argument("--start", default=POOL_START)
    ap.add_argument("--end", default=POOL_END)
    ap.add_argument("--fresh", action="store_true",
                    help="ignore the pool cache instead of topping it up")
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]

    if args.stage == "pool":
        run_pool(seeds, args.start, args.end, append=not args.fresh)
        return

    res = _run("discovery" if args.stage == "scan" else "confirm", seeds)
    prev = {}
    if ARTIFACT_PATH.exists():
        prev = json.loads(ARTIFACT_PATH.read_text())
    prev[res["window"]] = res
    ARTIFACT_PATH.write_text(json.dumps(prev, indent=2))
    print(f"\nwrote {ARTIFACT_PATH}")


if __name__ == "__main__":
    main()
