"""One figure, two panels: what a seed budget buys, and what a question count costs."""
from __future__ import annotations
import json, sys
from pathlib import Path

SIM = Path(__file__).resolve().parents[1] / "scripts" / "simulation"
sys.path.insert(0, str(SIM)); sys.path.insert(0, str(SIM / "scripts"))

import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.stats import norm

OUT = Path(__file__).resolve().parent / "figs"
plt.rcParams.update({
    "font.size": 8, "axes.linewidth": 0.6, "xtick.major.width": 0.6,
    "ytick.major.width": 0.6, "legend.frameon": False, "figure.dpi": 200,
    "axes.spines.top": False, "axes.spines.right": False,
})
INK, ACC, MUT = "#1a1a1a", "#c1440e", "#8a8a8a"

f = json.loads((SIM / "artifacts" / "lab_floor.json").read_text())
var_b = f["variance_split"]["bout_level"]
var_s = f["variance_split"]["seed_level"]
Z = norm.ppf(0.95) + norm.ppf(0.80)
SHIPPED = 0.0026            # the only winner-leg lever the project ever shipped
NULL_MAX = f["null_lever"]["max_abs_delta"]

fig, (a1, a2) = plt.subplots(1, 2, figsize=(5.5, 2.1))

# -- left: the seed budget has an asymptote and it is close
k = np.arange(1, 51)
mde = Z * np.sqrt(var_b + var_s / k)
mde_inf = Z * np.sqrt(var_b)
a1.plot(k, mde, color=INK, lw=1.2)
a1.axhline(mde_inf, color=INK, lw=0.7, ls=":")
a1.text(49, mde_inf * 1.02, "infinite-seed floor", fontsize=6.5, ha="right", va="bottom", color=INK)
a1.axhline(SHIPPED, color=ACC, lw=0.9, ls="--")
a1.text(50, SHIPPED * 1.03, "the one lever ever shipped", fontsize=6.5, ha="right", color=ACC)
a1.axhline(NULL_MAX, color=MUT, lw=0.9, ls="-.")
a1.text(49, NULL_MAX * 0.965, "largest effect a NULL lever faked", fontsize=6.5,
        ha="right", va="top", color=MUT)
a1.set_xlabel("seeds averaged per arm"); a1.set_ylabel("detectable effect (nats)")
a1.set_ylim(0.0018, 0.0034); a1.set_xlim(1, 50)
a1.set_title("buying seeds walks to a floor, not past it", fontsize=7.5, pad=3)

# -- right: every extra question raises the floor
K = np.array([1, 2, 5, 10, 20, 50, 84, 200, 500])
z = norm.ppf(1 - 0.05 / K) + norm.ppf(0.80)
a2.plot(K, z * np.sqrt(var_b + var_s), color=INK, lw=1.2, marker="o", ms=2.5,
        label="1 seed")
a2.plot(K, z * np.sqrt(var_b), color=MUT, lw=1.2, marker="s", ms=2.5,
        label="infinite seeds")
a2.axhline(SHIPPED, color=ACC, lw=0.9, ls="--")
a2.text(1.1, SHIPPED * 1.04, "the one lever ever shipped", fontsize=6.5, va="bottom", color=ACC)
a2.axvline(84, color=INK, lw=0.6, ls=":")
a2.text(95, 0.00295, "the search\nactually run", fontsize=6.5, color=INK)
a2.set_xscale("log"); a2.set_xlabel("hypotheses the pipeline asks")
a2.set_ylabel("detectable effect (nats)")
a2.legend(loc="upper left", fontsize=6.8, handlelength=1.6)
a2.set_title("and every extra question raises it", fontsize=7.5, pad=3)

fig.tight_layout(pad=0.3)
fig.savefig(OUT / "floor.pdf"); fig.savefig(OUT / "floor.png")
print("wrote floor")
