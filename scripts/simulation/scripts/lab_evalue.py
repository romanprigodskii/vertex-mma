"""Re-ask docs/edge_segments.md's 87 questions as bets.

Stages:
  frame     build (and cache) the pool x context frame with closing decimals
  segments  an e-value per segment; e-BH against BH and BY
  mixture   the post-hoc threshold rule, paid for by a mixture martingale
  roi       anytime-valid confidence sequence on the deployable rule's ROI
  power     what the two instruments each need, measured on the same data
  all       everything, writing artifacts/lab_evalue.json
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

import lab_evalue_common as ev  # noqa: E402
from lab_edge_common import (  # noqa: E402
    Segment, bh_fdr, build_frame, cluster_bootstrap, per_bout_logloss,
)
from lab_edge_registry import SEGMENTS  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402

SEEDS = [42, 7, 13, 99, 2024]
PRIMARY_SEED = 42
ALPHA = 0.05
FRAME_CACHE = DATA_DIR / "lab_evalue_frame.parquet"


def get_frame(rebuild: bool = False) -> pd.DataFrame:
    if FRAME_CACHE.exists() and not rebuild:
        return pd.read_parquet(FRAME_CACHE)
    frame, _ = build_frame(SEEDS)
    frame.to_parquet(FRAME_CACHE)
    print(f"  cached {len(frame):,} rows -> {FRAME_CACHE.name}")
    return frame


def priced(frame: pd.DataFrame, seed: int) -> pd.DataFrame:
    """One seed's bouts that carry a closing line, in calendar order.

    Calendar order is not cosmetic: the wealth process is only a PROCESS if
    its increments arrive in the order the bettor would have met them, and
    Ville's inequality is a statement about that order. Ties inside a card
    are broken by bout id, deterministically.
    """
    f = frame[(frame["seed"] == seed) & frame["has_market"]].copy()
    f = f[f["market"].notna() & f["p"].notna() & f["y"].notna()]
    return f.sort_values(["event_date", "bout_id"]).reset_index(drop=True)


def segment_objects() -> list[Segment]:
    return [Segment(**d) for d in SEGMENTS]


def segment_rows(f: pd.DataFrame, seg: Segment) -> pd.DataFrame:
    a, b = seg.mask(f)
    return f[a | b]


# -- stages ------------------------------------------------------------


def stage_segments(frame: pd.DataFrame, frac: float = 0.5) -> dict:
    f = priced(frame, PRIMARY_SEED)
    segs = segment_objects()
    rows = []
    for seg in segs:
        s = segment_rows(f, seg)
        if len(s) < 20:
            continue
        p = s["p"].to_numpy(float)
        q = s["market"].to_numpy(float)
        y = s["y"].to_numpy(float)
        inc = ev.wealth_increments(p, q, y, frac=frac)
        inc_ad, c_used = ev.adaptive_increments(p, q, y)
        has_dec = s["dec_a"].notna() & s["dec_b"].notna()
        inc_vig = ev.vigged_increments(
            p, q, y, s["dec_a"].to_numpy(float), s["dec_b"].to_numpy(float), frac=frac
        )
        inc_vig = np.where(has_dec.to_numpy(), inc_vig, 1.0)
        # the lab's own statistic, on the same rows, for the comparison table
        d = per_bout_logloss(p, y) - per_bout_logloss(q, y)
        mean_d, lo_d, hi_d = cluster_bootstrap(d, s["event_id"].to_numpy())
        rows.append(dict(
            name=seg.name, family=seg.family, n=int(len(s)),
            events=int(s["event_id"].nunique()),
            e=ev.evalue(inc), e_max=float(ev.running_evalue(inc).max()),
            e_adaptive=ev.evalue(inc_ad), c_final=float(c_used[-1]),
            e_vigged=ev.evalue(inc_vig),
            growth=ev.log_growth(inc),
            bouts_needed=ev.bouts_to_reject(inc),
            crossing=ev.ville_crossing(inc),
            paired_delta=mean_d, paired_lo=lo_d, paired_hi=hi_d,
        ))
    df = pd.DataFrame(rows)
    pre = df[df["family"] != "post_hoc"].reset_index(drop=True)
    e = pre["e"].to_numpy(float)
    rej = ev.e_bh(e, ALPHA)
    # p-values from the same paired statistic the lab used, for BH / BY
    from scipy.stats import norm
    se = (pre["paired_hi"] - pre["paired_lo"]) / (2 * 1.96)
    z = pre["paired_delta"] / se.replace(0, np.nan)
    pv = np.asarray(norm.cdf(z), dtype=float)   # one-sided: model BETTER than book
    pre["p_paired"] = pv
    pre["q_bh"] = bh_fdr(pv)
    pre["q_by"] = ev.by_qvalues(pv)
    pre["e_bh_reject"] = rej
    out = dict(
        n_segments=int(len(pre)),
        e_bh_threshold=ev.e_bh_threshold(e, ALPHA),
        e_bh_rejected=[str(x) for x in pre.loc[rej, "name"]],
        bh_rejected=[str(x) for x in pre.loc[pre["q_bh"] < ALPHA, "name"]],
        by_rejected=[str(x) for x in pre.loc[pre["q_by"] < ALPHA, "name"]],
        by_penalty=float(np.sum(1.0 / np.arange(1, len(pre) + 1))),
        table=df.to_dict("records"),
    )
    print(f"\n  {len(pre)} pre-registered segments, alpha={ALPHA}")
    print(f"  e-BH cutoff e >= {out['e_bh_threshold']:.1f}"
          f"   rejects {int(rej.sum())}: {out['e_bh_rejected']}")
    print(f"  BH  rejects {len(out['bh_rejected'])}: {out['bh_rejected']}")
    print(f"  BY  rejects {len(out['by_rejected'])} (penalty x{out['by_penalty']:.2f})")
    print("\n  top 10 by e-value:")
    top = df.sort_values("e", ascending=False).head(10)
    for _, r in top.iterrows():
        print(f"    {r['name'][:46]:<46} n={r['n']:>4}  e={r['e']:>10.2f}"
              f"  e_vig={r['e_vigged']:>8.2f}  g={r['growth']:+.4f}"
              f"  need={r['bouts_needed']:.0f}")
    return out


def stage_global(frame: pd.DataFrame) -> dict:
    """The whole pool, and what the bookmaker's margin costs in evidence."""
    out = {}
    for seed in SEEDS:
        f = priced(frame, seed)
        p, q, y = (f[c].to_numpy(float) for c in ("p", "market", "y"))
        inc = ev.wealth_increments(p, q, y)
        has = (f["dec_a"].notna() & f["dec_b"].notna()).to_numpy()
        vig = ev.vigged_increments(p, q, y, f["dec_a"].to_numpy(float),
                                   f["dec_b"].to_numpy(float))
        vig = np.where(has, vig, 1.0)
        out[str(seed)] = dict(
            n=int(len(f)), e=ev.evalue(inc), e_vigged=ev.evalue(vig),
            growth=ev.log_growth(inc), growth_vigged=ev.log_growth(vig),
            overround=float(f["overround"].mean()),
        )
    g = out[str(PRIMARY_SEED)]
    print(f"\n  whole pool (seed {PRIMARY_SEED}), n={g['n']}: "
          f"e={g['e']:.3g}  e_vigged={g['e_vigged']:.3g}")
    print(f"  log-growth per bout: fair {g['growth']:+.5f}  "
          f"vigged {g['growth_vigged']:+.5f}  "
          f"-> the margin costs {g['growth']-g['growth_vigged']:.5f} nats/bout "
          f"at a mean overround of {g['overround']:.4f}")
    return out


def stage_mixture(frame: pd.DataFrame) -> dict:
    """The post-hoc rule, priced by a mixture over the thresholds it searched."""
    f = priced(frame, PRIMARY_SEED)
    grid = np.round(np.arange(0.02, 0.2251, 0.01), 3)
    paths, terminal, flat_roi = [], {}, {}
    for th in grid:
        s = f[f["lean_fav"] >= th]
        if len(s) < 10:
            paths.append(np.array([1.0]))
            continue
        p, q, y = (s[c].to_numpy(float) for c in ("p", "market", "y"))
        inc = ev.wealth_increments(p, q, y)
        path = ev.running_evalue(inc)
        paths.append(path)
        terminal[float(th)] = dict(n=int(len(s)), e=float(path[-1]),
                                   e_max=float(path.max()))
        # flat-stake ROI at the vigged price, backing the book's favourite
        fav_a = (s["market"] >= 0.5).to_numpy()
        dec = np.where(fav_a, s["dec_a"].to_numpy(float), s["dec_b"].to_numpy(float))
        won = np.where(fav_a, s["y"].to_numpy(float) > 0.5, s["y"].to_numpy(float) < 0.5)
        ok = np.isfinite(dec)
        r = np.where(won[ok], dec[ok] - 1.0, -1.0)
        flat_roi[float(th)] = dict(bets=int(ok.sum()), roi=float(r.mean()))
    mix = ev.mixture_evalue(paths)
    best = max(terminal.items(), key=lambda kv: kv[1]["e"])
    declared = terminal.get(0.05, {})
    out = dict(
        grid=[float(g) for g in grid], per_threshold=terminal, flat_roi=flat_roi,
        mixture_e=float(mix[-1]), mixture_e_max=float(mix.max()),
        best_threshold=float(best[0]), best_e=best[1]["e"],
        declared_threshold=0.05, declared_e=declared.get("e"),
        rejects_at_alpha=bool(mix[-1] >= 1 / ALPHA),
    )
    print(f"\n  post-hoc threshold sweep, {len(grid)} cuts from {grid[0]} to {grid[-1]}")
    print(f"    declared cut 0.05 : n={declared.get('n')}  e={declared.get('e'):.2f}")
    print(f"    best cut {best[0]:.2f}      : n={best[1]['n']}  e={best[1]['e']:.2f}"
          f"   <- NOT a valid e-value on its own")
    print(f"    mixture over all {len(grid)} : e={mix[-1]:.2f}  "
          f"(sup_t {mix.max():.2f})  -> {'REJECTS' if out['rejects_at_alpha'] else 'does not reject'} at 1/alpha={1/ALPHA:.0f}")
    return out


def stage_roi(frame: pd.DataFrame) -> dict:
    """Anytime-valid CS on the deployable rule's flat-stake return."""
    f = priced(frame, PRIMARY_SEED)
    s = f[f["lean_fav"] >= 0.05].copy()
    fav_a = (s["market"] >= 0.5).to_numpy()
    dec = np.where(fav_a, s["dec_a"].to_numpy(float), s["dec_b"].to_numpy(float))
    won = np.where(fav_a, s["y"].to_numpy(float) > 0.5, s["y"].to_numpy(float) < 0.5)
    ok = np.isfinite(dec)
    r = np.where(won[ok], dec[ok] - 1.0, -1.0)
    hi = float(np.nanmax(dec[ok]) - 1.0)
    lo_cs, hi_cs = ev.betting_cs(r, alpha=ALPHA, lo=-1.0, hi=hi)
    mean_r, bs_lo, bs_hi = cluster_bootstrap(
        r, s.loc[ok, "event_id"].to_numpy()
    )
    out = dict(
        bets=int(ok.sum()), events=int(s.loc[ok, "event_id"].nunique()),
        roi=mean_r, bootstrap_ci=[bs_lo, bs_hi],
        cs_final=[float(lo_cs[-1]), float(hi_cs[-1])],
        cs_excludes_zero=bool(lo_cs[-1] > 0),
        max_decimal=hi + 1.0,
    )
    print(f"\n  rule 'back the favourite when lean >= 0.05': "
          f"{out['bets']} bets / {out['events']} events, ROI {mean_r:+.1%}")
    print(f"    cluster bootstrap CI (valid at this n only): "
          f"[{bs_lo:+.1%}, {bs_hi:+.1%}]")
    print(f"    anytime-valid CS (valid at EVERY n):        "
          f"[{lo_cs[-1]:+.1%}, {hi_cs[-1]:+.1%}]"
          f"  -> {'excludes' if out['cs_excludes_zero'] else 'includes'} zero")
    return out


def stage_power(frame: pd.DataFrame) -> dict:
    """What each instrument needs to see the same effect, on the same data.

    docs/edge_segments.md §0 reports ~89,900 bouts for the paired log-loss
    test against a 3 pp edge. That number is not wrong, but it prices a
    fixed-n test of a SEGMENT against the pool, and a paired log-loss
    contrast on a 200-bout slice discards most of what each bout carries.
    The sequential bet keeps it. Both are computed here on the same
    simulated edge so the comparison is like for like.
    """
    from scipy.stats import norm
    f = priced(frame, PRIMARY_SEED)
    q = f["market"].to_numpy(float)
    rng = np.random.default_rng(11)
    out = {}
    for edge in (0.03, 0.05):
        p = np.clip(q + edge * np.sign(rng.normal(size=len(q))), 0.02, 0.98)
        # sequential: expected log-growth per bout under the true alternative
        lam = ev.clip_lambda(0.5 * ev.kelly_lambda(p, q), q)
        g = float(np.mean(p * np.log1p(lam * (1 - q)) + (1 - p) * np.log1p(-lam * q)))
        n_seq = float(np.log(1 / ALPHA) / g) if g > 0 else float("inf")
        # fixed-n paired log-loss, same edge, sd taken from the real pool
        d = per_bout_logloss(p, f["y"].to_numpy(float)) - per_bout_logloss(q, f["y"].to_numpy(float))
        sd = float(np.std(d))
        eff = float(np.mean(
            p * (np.log(p) - np.log(q)) + (1 - p) * (np.log(1 - p) - np.log(1 - q))
        ))
        n_fix = ((norm.ppf(0.95) + norm.ppf(0.80)) * sd / eff) ** 2 if eff > 0 else float("inf")
        out[f"{edge:.2f}"] = dict(
            growth_per_bout=g, n_sequential=n_seq,
            paired_sd=sd, paired_effect=eff, n_fixed=float(n_fix),
            ratio=float(n_fix / n_seq) if n_seq else None,
        )
        print(f"\n  a true {edge:.0%} edge, alpha={ALPHA}:")
        print(f"    sequential bet : {g:+.5f} nats/bout -> {n_seq:,.0f} bouts to e=1/alpha")
        print(f"    paired log-loss: effect {eff:.5f}, sd {sd:.3f} -> {n_fix:,.0f} bouts at 80% power")
        print(f"    ratio: the fixed-n test needs {n_fix/n_seq:.0f}x more fights")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["frame", "segments", "global", "mixture", "roi", "power", "all"])
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()

    frame = get_frame(rebuild=args.rebuild)
    print(f"  frame: {len(frame):,} rows, {frame['bout_id'].nunique():,} bouts, "
          f"{int(frame[frame['seed']==PRIMARY_SEED]['has_market'].sum()):,} priced per seed")
    if args.stage == "frame":
        return

    res = {}
    if args.stage in ("segments", "all"):
        res["segments"] = stage_segments(frame)
    if args.stage in ("global", "all"):
        res["global"] = stage_global(frame)
    if args.stage in ("mixture", "all"):
        res["mixture"] = stage_mixture(frame)
    if args.stage in ("roi", "all"):
        res["roi"] = stage_roi(frame)
    if args.stage in ("power", "all"):
        res["power"] = stage_power(frame)

    if args.stage == "all":
        path = ARTIFACTS_DIR / "lab_evalue.json"
        path.write_text(json.dumps(res, indent=2, default=float))
        print(f"\n  wrote {path}")


if __name__ == "__main__":
    main()
