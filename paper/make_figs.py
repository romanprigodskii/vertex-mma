"""Two figures. Both are the paper's argument; neither is decoration."""
from __future__ import annotations
import sys
from pathlib import Path

SIM = Path(__file__).resolve().parents[1] / "scripts" / "simulation"
sys.path.insert(0, str(SIM)); sys.path.insert(0, str(SIM / "scripts"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import lab_evalue as L
import lab_evalue_common as ev
import lab_evalue_stages as S

OUT = Path(__file__).resolve().parent / "figs"
ALPHA = 0.05
plt.rcParams.update({
    "font.size": 8, "axes.linewidth": 0.6, "xtick.major.width": 0.6,
    "ytick.major.width": 0.6, "legend.frameon": False, "figure.dpi": 200,
    "axes.spines.top": False, "axes.spines.right": False,
})
INK, ACC, MUT = "#1a1a1a", "#c1440e", "#8a8a8a"


def _inc_real(s):
    """The same predictable stakes, settled at the decimals the book offered."""
    return ev.vigged_increments(
        s["p"].to_numpy(float), s["market"].to_numpy(float), s["y"].to_numpy(float),
        s["dec_a"].to_numpy(float), s["dec_b"].to_numpy(float), frac=0.5)


def fig_continuation(f):
    """Wealth over calendar time, with the window the lab had to throw away."""
    fig, ax = plt.subplots(figsize=(5.5, 1.42))
    by = {s.name: s for s in S._segs()}
    styles = [
        ("form_momentum__long_win_streak_4plus", "win streak $\\geq$ 4", INK, "-"),
        ("post_hoc__we_back_the_favourite", "back the favourite (post-hoc)", ACC, "-"),
    ]
    for name, label, colour, ls in styles:
        s = S._rows(f, by[name]).sort_values(["event_date", "bout_id"])
        run = ev.running_evalue(S._inc(s))
        ax.plot(s["event_date"].to_numpy(), run, color=colour, lw=1.1, ls=ls, label=label)
        # the same bets at the price a bettor could actually get: the margin is
        # a supermartingale, so this line is always the lower of the two
        ax.plot(s["event_date"].to_numpy(), ev.running_evalue(_inc_real(s)),
                color=colour, lw=0.9, ls=(0, (3, 1.6)), alpha=0.85, zorder=2)
    # every other pre-registered segment, faintly: the null band
    for seg in S._segs():
        if seg.family == "post_hoc" or seg.name in dict((a, b) for a, b, _, _ in
                                                        [(x[0], x[1], 0, 0) for x in styles]):
            continue
        s = S._rows(f, seg).sort_values(["event_date", "bout_id"])
        if len(s) < 40:
            continue
        run = ev.running_evalue(S._inc(s))
        ax.plot(s["event_date"].to_numpy(), run, color=MUT, lw=0.35, alpha=0.30, zorder=0)
    ax.axhline(1 / ALPHA, color=INK, lw=0.6, ls=":", zorder=1)
    ax.text(pd.Timestamp("2016-04-01"), 1 / ALPHA * 1.25, r"$1/\alpha=20$",
            fontsize=6.5, color=INK)
    ax.axvline(S.DISCOVERY_END, color=INK, lw=0.6, ls="--", alpha=0.7)
    ax.text(S.DISCOVERY_END + pd.Timedelta(days=25), 0.0016,
            "search stops here", fontsize=6.5, rotation=0, color=INK)
    ax.set_yscale("log"); ax.set_ylim(1e-3, 1e3)
    ax.set_ylabel(r"wealth $=$ e-value"); ax.set_xlabel("")
    ax.plot([], [], color=MUT, lw=0.9, ls=(0, (3, 1.6)), label="the same, at real odds")
    ax.legend(loc="upper left", fontsize=6.3, handlelength=1.6, ncol=3, columnspacing=0.9)
    fig.tight_layout(pad=0.25)
    fig.savefig(OUT / "continuation.pdf"); fig.savefig(OUT / "continuation.png")
    print("  wrote continuation")


def fig_posthoc(f):
    """What each extra degree of post-hoc freedom costs the finding."""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(5.5, 1.42), width_ratios=[1.2, 1])
    grid = np.round(np.arange(0.02, 0.2251, 0.01), 3)
    es, ns = [], []
    for th in grid:
        s = f[f["lean_fav"] >= th]
        es.append(ev.evalue(S._inc(s)) if len(s) >= 10 else 1.0)
        ns.append(len(s))
    ax1.plot(grid, es, color=INK, lw=1.1, marker="o", ms=2.2)
    ax1.axhline(1 / ALPHA, color=INK, lw=0.6, ls=":")
    ax1.axvline(0.05, color=ACC, lw=0.8, ls="--")
    ax1.text(0.056, 1.6, "the cut the\nlab declared", fontsize=6.5, color=ACC)
    ax1.set_yscale("log"); ax1.set_xlabel(r"threshold on $\mathrm{lean}_{\mathrm{fav}}$")
    ax1.set_ylabel("e-value of that cut")
    ax1.set_title("the sweep that was searched", fontsize=7.5, pad=3)

    labels = ["threshold\n(21 cuts)", "+ direction\n(42)", "+ statistic\n(63)"]
    fair = [31.28, 15.64, 10.43]
    real = [8.47, 4.23, 2.82]
    x = np.arange(3)
    for off, vals, colour, edge, lab in ((-0.16, fair, ACC, "none", "fair odds"),
                                         (+0.16, real, "white", MUT, "real odds")):
        bars = ax2.bar(x + off, vals, color=colour, edgecolor=edge, lw=0.7,
                       width=0.30, label=lab)
        for b, v in zip(bars, vals):
            ax2.text(b.get_x() + b.get_width() / 2, v + 1.1, f"{v:.1f}",
                     ha="center", fontsize=6.3)
    ax2.axhline(1 / ALPHA, color=INK, lw=0.8, ls=":")
    ax2.text(0.5, 21.0, r"$1/\alpha$", fontsize=6.5, ha="center")
    ax2.legend(fontsize=6.3, loc="upper right", handlelength=1.2, borderpad=0.2)
    ax2.set_xticks(x); ax2.set_xticklabels(labels, fontsize=6.8)
    ax2.set_ylabel("mixture e-value"); ax2.set_ylim(0, 40)
    ax2.set_title("what the search has to be paid for", fontsize=7.5, pad=3)
    fig.tight_layout(pad=0.3)
    fig.savefig(OUT / "posthoc.pdf"); fig.savefig(OUT / "posthoc.png")
    print("  wrote posthoc")


if __name__ == "__main__":
    frame = L.get_frame()
    f = L.priced(frame, L.PRIMARY_SEED)
    fig_continuation(f)
    fig_posthoc(f)
