"""The stages that need a window split, a mixture family, or five seeds."""

from __future__ import annotations

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
from lab_edge_common import Segment, swap_expr  # noqa: E402
from lab_edge_registry import SEGMENTS  # noqa: E402
from src.config import ARTIFACTS_DIR  # noqa: E402

ALPHA = 0.05
DISCOVERY_END = pd.Timestamp("2025-01-01")


def _segs(dedupe: bool = False) -> list[Segment]:
    """The registry, optionally collapsed to distinct slices.

    Two pairs of entries in the grid are the same expression proposed by two
    different lenses (a five-round bout is both a market-microstructure and a
    division-context hypothesis). docs/edge_segments.md collapses them and
    charges multiplicity to 84, not 86. Charging 86 would be conservative
    rather than wrong, but it would stop the two documents reconciling, and a
    multiplicity count that cannot be reconciled is the one number in a
    multiple-testing paper that has to be exactly right.
    """
    segs = [Segment(**d) for d in SEGMENTS]
    if not dedupe:
        return segs
    seen: set[tuple[str, str]] = set()
    out = []
    for seg in segs:
        key = tuple(sorted([seg.expr_a, swap_expr(seg.expr_a)]))
        if seg.family != "post_hoc":
            if key in seen:
                continue
            seen.add(key)
        out.append(seg)
    return out


def _rows(f: pd.DataFrame, seg: Segment) -> pd.DataFrame:
    a, b = seg.mask(f)
    return f[a | b]


def _inc(s: pd.DataFrame, frac: float = 0.5) -> np.ndarray:
    return ev.wealth_increments(
        s["p"].to_numpy(float), s["market"].to_numpy(float),
        s["y"].to_numpy(float), frac=frac,
    )


# -- 1. the multiplicity comparison, on the window the lab searched -----


def stage_discovery_multiplicity(f_all: pd.DataFrame) -> dict:
    """e-BH vs BH vs BY on the SAME 84 hypotheses and the SAME 1,191 bouts.

    The lab applied BH to the discovery window and reported one survivor.
    Comparing e-BH on the full pool against that would be comparing sample
    sizes, not procedures, so everything here is restricted to the rows the
    lab actually searched.
    """
    lab = json.loads((ARTIFACTS_DIR / "lab_edge_segments.json").read_text())
    lab_seg = {r["name"]: r for r in lab["discovery"]["segments"]}

    f = f_all[f_all["event_date"] < DISCOVERY_END]
    rows = []
    for seg in _segs(dedupe=True):
        if seg.family == "post_hoc":
            continue
        s = _rows(f, seg)
        if len(s) < 20:
            continue
        inc = _inc(s)
        r = lab_seg.get(seg.name, {})
        rows.append(dict(
            name=seg.name, family=seg.family, n=int(len(s)),
            e=ev.evalue(inc), e_max=float(ev.running_evalue(inc).max()),
            growth=ev.log_growth(inc),
            lab_delta_adj=r.get("delta_adj"), lab_p_adj=r.get("p_value_adj"),
            lab_q_adj=r.get("q_value_adj"),
        ))
    df = pd.DataFrame(rows)
    K = len(df)
    e = df["e"].to_numpy(float)
    rej_e = ev.e_bh(e, ALPHA)
    p_adj = pd.to_numeric(df["lab_p_adj"], errors="coerce").fillna(1.0).to_numpy()
    q_by = ev.by_qvalues(p_adj)
    q_bh_lab = pd.to_numeric(df["lab_q_adj"], errors="coerce").fillna(1.0).to_numpy()
    # Sign matters and the lab's table splits on it: a segment can clear BH
    # by being reliably WORSE than the book, which is not a discovery anyone
    # wants to bank. delta_adj < 0 is the model beating the closing line.
    d_adj = pd.to_numeric(df["lab_delta_adj"], errors="coerce").to_numpy()
    bh_hit = q_bh_lab < ALPHA
    out = dict(
        window="discovery (<2025-01-01)", K=int(K),
        n_bouts=int(f["bout_id"].nunique()),
        e_bh_cutoff=ev.e_bh_threshold(e, ALPHA),
        e_bh=[str(x) for x in df.loc[rej_e, "name"]],
        bh_lab=[str(x) for x in df.loc[bh_hit, "name"]],
        bh_favourable=[str(x) for x in df.loc[bh_hit & (d_adj < 0), "name"]],
        bh_against=[str(x) for x in df.loc[bh_hit & (d_adj >= 0), "name"]],
        by=[str(x) for x in df.loc[q_by < ALPHA, "name"]],
        by_penalty=float(np.sum(1.0 / np.arange(1, K + 1))),
        top=df.sort_values("e", ascending=False).head(6).to_dict("records"),
    )
    print(f"\n  DISCOVERY WINDOW: {out['n_bouts']} bouts, {K} pre-registered hypotheses")
    print(f"    BH  (guarantee needs PRDS; not established here) rejects "
          f"{len(out['bh_lab'])} — {len(out['bh_favourable'])} in the model's favour, "
          f"{len(out['bh_against'])} against it")
    print(f"        favourable: {out['bh_favourable']}")
    print(f"    BY  (valid under arbitrary dependence, x{out['by_penalty']:.2f}) rejects "
          f"{len(out['by'])}: {out['by']}")
    print(f"    e-BH(valid under arbitrary dependence, no penalty) rejects "
          f"{len(out['e_bh'])}: {out['e_bh']}   [cutoff e>={out['e_bh_cutoff']:.0f}]")
    print("    top segments by e-value on this window:")
    for r in out["top"]:
        print(f"      {r['name'][:44]:<44} n={r['n']:>4} e={r['e']:>8.2f} "
              f"lab q_adj={r['lab_q_adj'] if r['lab_q_adj'] is None else round(r['lab_q_adj'],3)}")
    return out


# -- 2. optional continuation ------------------------------------------


def stage_continuation(f_all: pd.DataFrame, names: list[str]) -> dict:
    """What the lab had to do with a second window, and what an e-process does.

    The lab froze the discovery window, picked a survivor, and then ran a
    FRESH fixed-n test on 2025-26 — which came back p = 0.30 and was
    reported, correctly, as a failure to replicate. That is the only move
    available to a fixed-n analysis: the second window buys a second test
    and nothing carries over.

    A test martingale carries over. The wealth accumulated before the split
    is contaminated by the selection that produced the segment, so it is
    reported but not claimed. The wealth accumulated AFTER the split is a
    valid e-value for a hypothesis that was already fixed when the window
    opened, and the two multiply into a running number that never has to
    choose a stopping time in advance.
    """
    by_name = {s.name: s for s in _segs()}
    out = {}
    for name in names:
        seg = by_name[name]
        s = _rows(f_all, seg).sort_values(["event_date", "bout_id"])
        is_conf = (s["event_date"] >= DISCOVERY_END).to_numpy()
        inc = _inc(s)
        run = ev.running_evalue(inc)
        e_disc = float(run[~is_conf][-1]) if (~is_conf).any() else 1.0
        inc_conf = inc[is_conf]
        e_conf = ev.evalue(inc_conf)
        g_conf = ev.log_growth(inc_conf)
        need = ev.bouts_to_reject(inc_conf)
        out[name] = dict(
            n_total=int(len(s)), n_discovery=int((~is_conf).sum()),
            n_confirm=int(is_conf.sum()),
            e_discovery=e_disc, e_confirm_only=e_conf,
            e_total=float(run[-1]), e_running_max=float(run.max()),
            growth_confirm=g_conf,
            confirm_rejects=bool(e_conf >= 1 / ALPHA),
            bouts_needed_confirm=need,
            shortfall=float(max(0.0, need - is_conf.sum())) if np.isfinite(need) else None,
        )
        r = out[name]
        print(f"\n  {name}")
        print(f"    discovery  n={r['n_discovery']:>4}  e={r['e_discovery']:>8.2f}"
              f"   (selection-contaminated: this is where the segment was chosen)")
        print(f"    confirm    n={r['n_confirm']:>4}  e={r['e_confirm_only']:>8.2f}"
              f"   (clean: the hypothesis was fixed before this window opened)"
              f" -> {'REJECTS' if r['confirm_rejects'] else 'does not reject'}")
        print(f"    continued  n={r['n_total']:>4}  e={r['e_total']:>8.2f}"
              f"   sup_t {r['e_running_max']:.2f}")
        if r["shortfall"] is not None:
            print(f"    at the confirmation-window growth rate ({r['growth_confirm']:+.4f} nats/bout), "
                  f"e=1/alpha needs {r['bouts_needed_confirm']:.0f} bouts "
                  f"-> {r['shortfall']:.0f} still to come")
    return out


# -- 3. what the post-hoc freedom costs --------------------------------


def stage_posthoc_price(f_all: pd.DataFrame) -> dict:
    """How wide can the mixture get before the post-hoc finding dies?

    docs/edge_segments.md 6 declares its rule post-hoc and says so. A
    mixture martingale can pay for that, but only for the freedom it is
    actually given prior mass over. Widening the family is therefore a
    direct measurement of how much searching the finding can absorb, and it
    is the number a reader should want: 'it survives paying for the
    threshold' and 'it survives paying for everything we could have looked
    at' are very different claims.
    """
    f = f_all.sort_values(["event_date", "bout_id"])
    grid = np.round(np.arange(0.02, 0.2251, 0.01), 3)

    def path(mask: np.ndarray) -> np.ndarray:
        s = f[mask]
        if len(s) < 10:
            return np.array([1.0])
        return ev.running_evalue(_inc(s))

    back = [path((f["lean_fav"] >= th).to_numpy()) for th in grid]
    fade = [path((f["lean_fav"] <= -th).to_numpy()) for th in grid]
    disag = [path((f["disagreement"] >= th).to_numpy()) for th in grid]

    families = {
        "thresholds only (21)": back,
        "+ the fade direction (42)": back + fade,
        "+ the other disagreement statistic (63)": back + fade + disag,
    }
    out = {}
    for label, paths in families.items():
        mix = ev.mixture_evalue(paths)
        out[label] = dict(components=len(paths), e=float(mix[-1]),
                          e_max=float(mix.max()),
                          rejects=bool(mix[-1] >= 1 / ALPHA))
        print(f"    mixture over {label:<42} e={mix[-1]:>7.2f}  "
              f"-> {'REJECTS' if out[label]['rejects'] else 'does NOT reject'}")
    best = max(float(p[-1]) for p in back)
    out["max_over_thresholds_not_an_evalue"] = best
    print(f"    (max over thresholds, which is NOT a valid e-value: {best:.2f})")
    return out


# -- 4. seed stability -------------------------------------------------


def stage_seeds(frame: pd.DataFrame, names: list[str], seeds: list[int]) -> dict:
    """Five walk-forward seeds, because the lab reports every number five times.

    The pool is a walk-forward refit and the seed moves which bouts land in
    which fold's early stopping. A finding that lives on one seed is a
    finding about a random number generator.
    """
    by_name = {s.name: s for s in _segs()}
    out = {}
    for name in names:
        seg = by_name[name]
        es = []
        for seed in seeds:
            f = frame[(frame["seed"] == seed) & frame["has_market"]]
            f = f[f["market"].notna() & f["p"].notna()].sort_values(["event_date", "bout_id"])
            s = _rows(f, seg)
            es.append(ev.evalue(_inc(s)))
        out[name] = dict(seeds=seeds, evalues=[float(x) for x in es],
                         min=float(min(es)), max=float(max(es)),
                         all_reject=bool(min(es) >= 1 / ALPHA))
        print(f"    {name[:44]:<44} e = " + ", ".join(f"{x:.1f}" for x in es)
              + f"   min {min(es):.1f} -> {'all cross' if min(es)>=1/ALPHA else 'NOT all cross'} 1/alpha")
    return out


# -- 5. how much of the result is the stake rule ------------------------


def stage_stake_sensitivity(f_all: pd.DataFrame, names: list[str]) -> dict:
    """Fractional Kelly at 0.25 / 0.5 / 1.0, plus the predictable plug-in.

    The stake is a free choice and every choice is valid, so the only
    question a reader should have is whether the conclusion is a property of
    the data or of the fraction. Reporting one fraction invites the
    suspicion; reporting the curve settles it.

    The plug-in row is the one that answers the choice honestly: it learns
    the multiplier from past bouts only, so it is not a choice at all.
    """
    by_name = {s.name: s for s in _segs()}
    out = {}
    for name in names:
        s = _rows(f_all, by_name[name]).sort_values(["event_date", "bout_id"])
        p, q, y = (s[c].to_numpy(float) for c in ("p", "market", "y"))
        row = {f"kelly_{fr}": ev.evalue(ev.wealth_increments(p, q, y, frac=fr))
               for fr in (0.25, 0.5, 1.0)}
        inc_ad, c_used = ev.adaptive_increments(p, q, y)
        row["plug_in"] = ev.evalue(inc_ad)
        row["plug_in_final_c"] = float(c_used[-1])
        row["n"] = int(len(s))
        out[name] = row
        print(f"    {name[:44]:<44} " + "  ".join(
            f"{k}={row[k]:.1f}" for k in ("kelly_0.25", "kelly_0.5", "kelly_1.0", "plug_in"))
            + f"   (plug-in settled at c={row['plug_in_final_c']:.2f})")
    return out
