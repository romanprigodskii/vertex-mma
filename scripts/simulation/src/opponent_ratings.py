"""Point-in-time opponent-adjusted ratings, shared by the dataset export and
the custom-sim worker.

Three rating families, all computed in ONE chronological replay of the bout
timeline, snapshotted strictly BEFORE each bout (leak-free by construction):

1. Elo (K=32) — overall strength-of-schedule-aware quality. Draws and
   no-contests snapshot but never update.
2. Online attack/defense skill ratings (Holmes-style, v0.7.0) — per-metric
   deviations from the league mean:
       predicted own rate vs this opponent = league_mean + off[self] + def[opp]
       err = observed − predicted; off[self] += LR·err; def[opp] += LR·err
   Metrics: sig strikes landed/min (str), takedowns/15min (grap),
   knockdowns/15min (kd), control-time fraction (ctrl). This is what makes
   5 landed strikes/min vs elite defense read differently from the same rate
   vs journeymen — raw career averages can't.
3. Opponent-quality Elo aggregates — who the record was compiled against:
   career/last-5 average opponent Elo, best/average Elo beaten, and an
   Elo-weighted win rate.

Validated on the 2025-07..2026-07 window (v0.7.0 lab): the 13 diff features
together beat the v0.6.0 baseline on val log-loss (0.6151 vs 0.6295, 3-seed
mean) and on every test metric; seed-stable.
"""

from __future__ import annotations

import math
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

ELO_K = 32.0
ELO_INITIAL = 1500.0

# Glicko-2 (v0.10.0) — uncertainty-aware rating next to plain Elo. Only the
# CONSERVATIVE rating (rating − 2·RD) ships as a feature: the v0.10 lab showed
# trees can't learn the rating×uncertainty interaction from raw rating+RD
# columns on ~5.6k rows, but baking it in beats the baseline seed-stably.
# Elo stays — the two diffs correlate only ~0.75 and are complementary.
GLICKO_SCALE = 173.7178
GLICKO_TAU = 0.5
GLICKO_INIT_RD = 350.0
GLICKO_INIT_VOL = 0.06
GLICKO_EPS = 1e-6
GLICKO_CONS_INITIAL = ELO_INITIAL - 2.0 * GLICKO_INIT_RD  # debutant default

# Form trajectory (v0.10.0) — mean of the last 3 bout rates minus the career
# rate, emitted once a fighter has >=2 stat bouts (the validated min-2
# window). Positive traj_sapm = getting hit MORE than career norm = decline
# signal the results-only recent-form features miss.
TRAJ_WINDOW = 3
TRAJ_MIN_BOUTS = 2
TRAJ_MIN_MINUTES = 0.5  # clip bout length so 10-second KOs don't give 60 slpm

# Attack/defense engine constants. LR validated on the v0.7.0 lab grid
# (0.2 beat 0.1/0.3 and an experience-decayed schedule on val).
RATING_METRICS = ("str", "grap", "kd", "ctrl")
RATING_LR = 0.2
DURATION_FLOOR_S = 60.0  # damp rate blow-ups from sub-minute finishes
# League-mean running averages are seeded with a broad prior so the first
# few hundred bouts don't swing the baseline the errors are measured against.
LEAGUE_PRIOR = {"str": 3.5, "grap": 1.5, "kd": 0.5, "ctrl": 0.2}
LEAGUE_PRIOR_WEIGHT = 200.0
# Observed rates are clipped at the p99 computed over bouts before this
# FROZEN anchor (the v0.7.0 train period) — a stable constant-by-construction,
# not a moving window, so retrains don't shift the clip as new data arrives.
CLIP_ANCHOR_DATE = "2024-07-01"

# Fighters with zero decisive prior bouts have no opponent history; the
# "beaten" aggregates fall back to a below-initial sentinel (a debutant has
# beaten nobody) while the averages stay NaN (unknown, imputed downstream).
NO_BEATEN_SENTINEL = ELO_INITIAL - 100.0

OPP_ELO_KEYS = (
    "avg_opp_elo_career",
    "avg_opp_elo_last5",
    "max_opp_elo_beaten",
    "avg_opp_elo_beaten",
    "sos_weighted_winrate",
)
RATING_KEYS = tuple(f"{m}_{side}" for m in RATING_METRICS for side in ("off", "def"))
TRAJ_KEYS = ("traj_slpm", "traj_sapm", "traj_td")
ALL_KEYS = ("elo", "glicko_cons") + RATING_KEYS + OPP_ELO_KEYS + TRAJ_KEYS


def _glicko_g(phi: float) -> float:
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi**2))


def _glicko_update(
    mu: float, phi: float, sigma: float, mu_j: float, phi_j: float, s: float
) -> tuple[float, float, float]:
    """One Glicko-2 rating period containing a single game vs (mu_j, phi_j)
    with score s in {0, 1} (Glickman's paper, steps 3-7; volatility via the
    Illinois algorithm). Returns (mu', phi', sigma')."""
    gj = _glicko_g(phi_j)
    ej = 1.0 / (1.0 + math.exp(-gj * (mu - mu_j)))
    v = 1.0 / (gj * gj * ej * (1.0 - ej))
    delta = v * gj * (s - ej)

    a = math.log(sigma * sigma)

    def f(x: float) -> float:
        ex = math.exp(x)
        num = ex * (delta * delta - phi * phi - v - ex)
        den = 2.0 * (phi * phi + v + ex) ** 2
        return num / den - (x - a) / (GLICKO_TAU * GLICKO_TAU)

    upper = a
    if delta * delta > phi * phi + v:
        lower = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * GLICKO_TAU) < 0:
            k += 1
        lower = a - k * GLICKO_TAU
    f_upper, f_lower = f(upper), f(lower)
    while abs(lower - upper) > GLICKO_EPS:
        mid = upper + (upper - lower) * f_upper / (f_lower - f_upper)
        f_mid = f(mid)
        if f_mid * f_lower <= 0:
            upper, f_upper = lower, f_lower
        else:
            f_upper = f_upper / 2.0
        lower, f_lower = mid, f_mid
    sigma_p = math.exp(upper / 2.0)

    phi_star = math.sqrt(phi * phi + sigma_p * sigma_p)
    phi_p = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
    mu_p = mu + phi_p * phi_p * gj * (s - ej)
    return mu_p, phi_p, sigma_p


@dataclass
class RatingSnapshots:
    """pre[(bout_id, fighter_id)] — values as of just BEFORE that bout;
    post[(bout_id, fighter_id)] — values right AFTER it (custom-sim "form as
    of bout X includes X" semantics); current[fighter_id] — latest values."""

    pre: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    post: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    current: dict[str, dict[str, Any]] = field(default_factory=dict)


def _duration_seconds(round_finished, time_finished, scheduled_rounds) -> float:
    if round_finished is not None and not pd.isna(round_finished):
        partial = (
            float(time_finished)
            if time_finished is not None and not pd.isna(time_finished)
            else 300.0
        )
        return max(0.0, (float(round_finished) - 1.0) * 300.0) + partial
    sched = float(scheduled_rounds) if not pd.isna(scheduled_rounds) else 3.0
    return sched * 300.0


def _rates(stat: dict[str, Any], duration_s: float) -> dict[str, float]:
    d = max(duration_s, DURATION_FLOOR_S)
    return {
        "str": (stat.get("sig_str_landed") or 0) / (d / 60.0),
        "grap": (stat.get("td_landed") or 0) / d * 900.0,
        "kd": (stat.get("knockdowns") or 0) / d * 900.0,
        "ctrl": (stat.get("control_seconds") or 0) / d,
    }


def compute_rating_snapshots(
    bouts: pd.DataFrame, round_stats: pd.DataFrame
) -> RatingSnapshots:
    """One chronological replay over `bouts` (MUST already be in event order,
    as fetched by export.BOUTS_SQL / the custom-sim SQL). `round_stats` is the
    per-(bout_id, fighter_id) totals frame. Scheduled/statless bouts get pre
    snapshots but never update any rating."""
    stat_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for row in round_stats.itertuples(index=False):
        stat_lookup[(row.bout_id, row.fighter_id)] = row._asdict()

    # Clip constants: p99 of each observed rate over pre-anchor bouts. Frozen
    # anchor -> deterministic, and never sees post-anchor (i.e. eval) data.
    anchor = pd.to_datetime(CLIP_ANCHOR_DATE).date()
    clip_samples: dict[str, list[float]] = {m: [] for m in RATING_METRICS}
    for bout in bouts.itertuples(index=False):
        ev = bout.event_date if not hasattr(bout.event_date, "date") else bout.event_date.date()
        if ev >= anchor:
            continue
        d = _duration_seconds(
            bout.round_finished, bout.time_finished_seconds, bout.scheduled_rounds
        )
        for fid in (bout.fighter_a_id, bout.fighter_b_id):
            stat = stat_lookup.get((bout.bout_id, fid))
            if stat:
                r = _rates(stat, d)
                for m in RATING_METRICS:
                    clip_samples[m].append(r[m])
    clip = {
        m: (float(np.quantile(v, 0.99)) if v else float("inf"))
        for m, v in clip_samples.items()
    }

    elo: dict[str, float] = {}
    # Glicko-2 state per fighter: (mu, phi, sigma) on the internal scale.
    glicko_init = (0.0, GLICKO_INIT_RD / GLICKO_SCALE, GLICKO_INIT_VOL)
    glicko: dict[str, tuple[float, float, float]] = {}
    off = {m: defaultdict(float) for m in RATING_METRICS}
    deff = {m: defaultdict(float) for m in RATING_METRICS}
    league_sum = {m: LEAGUE_PRIOR[m] * LEAGUE_PRIOR_WEIGHT for m in RATING_METRICS}
    league_n = {m: LEAGUE_PRIOR_WEIGHT for m in RATING_METRICS}
    # (opponent_pre_elo, won) per decisive bout, per fighter.
    opp_hist: dict[str, list[tuple[float, bool]]] = defaultdict(list)
    # Form trajectory: career rate sums + a deque of last-N per-bout rates.
    traj_career: dict[str, dict[str, float]] = defaultdict(
        lambda: {"landed": 0.0, "absorbed": 0.0, "td": 0.0, "minutes": 0.0, "n": 0}
    )
    traj_recent: dict[str, dict[str, deque]] = defaultdict(
        lambda: {
            "slpm": deque(maxlen=TRAJ_WINDOW),
            "sapm": deque(maxlen=TRAJ_WINDOW),
            "td15": deque(maxlen=TRAJ_WINDOW),
        }
    )

    snaps = RatingSnapshots()

    def snapshot(fid: str) -> dict[str, Any]:
        vals: dict[str, Any] = {"elo": elo.get(fid, ELO_INITIAL)}
        g_mu, g_phi, _ = glicko.get(fid, glicko_init)
        vals["glicko_cons"] = (
            ELO_INITIAL + GLICKO_SCALE * g_mu
        ) - 2.0 * (GLICKO_SCALE * g_phi)
        for m in RATING_METRICS:
            vals[f"{m}_off"] = off[m][fid]
            vals[f"{m}_def"] = deff[m][fid]
        tc, tr = traj_career[fid], traj_recent[fid]
        if tc["n"] >= TRAJ_MIN_BOUTS and tc["minutes"] > 0:
            career_rates = {
                "slpm": tc["landed"] / tc["minutes"],
                "sapm": tc["absorbed"] / tc["minutes"],
                "td15": tc["td"] / tc["minutes"] * 15.0,
            }
            for key, name in (("slpm", "traj_slpm"), ("sapm", "traj_sapm"), ("td15", "traj_td")):
                vals[name] = float(np.mean(tr[key])) - career_rates[key]
        else:
            vals["traj_slpm"] = None
            vals["traj_sapm"] = None
            vals["traj_td"] = None
        hist = opp_hist.get(fid)
        if hist:
            opes = [h[0] for h in hist]
            beaten = [h[0] for h in hist if h[1]]
            vals["avg_opp_elo_career"] = float(np.mean(opes))
            vals["avg_opp_elo_last5"] = float(np.mean(opes[-5:]))
            vals["max_opp_elo_beaten"] = max(beaten) if beaten else NO_BEATEN_SENTINEL
            vals["avg_opp_elo_beaten"] = (
                float(np.mean(beaten)) if beaten else NO_BEATEN_SENTINEL
            )
            vals["sos_weighted_winrate"] = float(
                sum(max(0.0, h[0] - 1400.0) / 100.0 for h in hist if h[1]) / len(hist)
            )
        else:
            vals["avg_opp_elo_career"] = None
            vals["avg_opp_elo_last5"] = None
            vals["max_opp_elo_beaten"] = None
            vals["avg_opp_elo_beaten"] = None
            vals["sos_weighted_winrate"] = None
        return vals

    for bout in bouts.itertuples(index=False):
        bid, fa, fb = bout.bout_id, bout.fighter_a_id, bout.fighter_b_id
        snaps.pre[(bid, fa)] = snapshot(fa)
        snaps.pre[(bid, fb)] = snapshot(fb)

        if getattr(bout, "status", "completed") == "completed":
            winner = bout.winner_id
            decisive = (
                isinstance(winner, str)
                and winner in (fa, fb)
                and (bout.method or "") != "no_contest"
            )
            duration = _duration_seconds(
                bout.round_finished, bout.time_finished_seconds, bout.scheduled_rounds
            )

            # Elo + Glicko-2 + opponent-history updates (decisive results only).
            if decisive:
                ra, rb = elo.get(fa, ELO_INITIAL), elo.get(fb, ELO_INITIAL)
                expected_a = 1.0 / (1.0 + 10.0 ** ((rb - ra) / 400.0))
                score_a = 1.0 if winner == fa else 0.0
                elo[fa] = ra + ELO_K * (score_a - expected_a)
                elo[fb] = rb + ELO_K * ((1.0 - score_a) - (1.0 - expected_a))
                opp_hist[fa].append((rb, winner == fa))
                opp_hist[fb].append((ra, winner == fb))
                ga, gb = glicko.get(fa, glicko_init), glicko.get(fb, glicko_init)
                glicko[fa] = _glicko_update(*ga, gb[0], gb[1], score_a)
                glicko[fb] = _glicko_update(*gb, ga[0], ga[1], 1.0 - score_a)

            # Attack/defense updates need round stats, not a winner — a draw
            # still tells us who out-landed whom. Both sides' errors are
            # computed from PRE-bout values, then applied together.
            obs: dict[str, dict[str, float]] = {}
            for fid in (fa, fb):
                stat = stat_lookup.get((bid, fid))
                if stat:
                    obs[fid] = _rates(stat, duration)
            updates: list[tuple[str, str, str, float, float]] = []
            for me, opp in ((fa, fb), (fb, fa)):
                if me not in obs:
                    continue
                for m in RATING_METRICS:
                    o = min(obs[me][m], clip[m])
                    err = o - (league_sum[m] / league_n[m] + off[m][me] + deff[m][opp])
                    updates.append((m, me, opp, err, o))
            for m, me, opp, err, o in updates:
                off[m][me] += RATING_LR * err
                deff[m][opp] += RATING_LR * err
                league_sum[m] += o
                league_n[m] += 1.0

            # Form-trajectory history — needs BOTH sides' stats (absorbed =
            # the opponent's landed), with its own validated duration floor.
            stat_a = stat_lookup.get((bid, fa))
            stat_b = stat_lookup.get((bid, fb))
            if stat_a is not None and stat_b is not None:
                minutes = max(duration / 60.0, TRAJ_MIN_MINUTES)
                for me_stat, opp_stat in ((stat_a, stat_b), (stat_b, stat_a)):
                    fid = me_stat["fighter_id"]
                    tc = traj_career[fid]
                    tc["landed"] += me_stat["sig_str_landed"] or 0
                    tc["absorbed"] += opp_stat["sig_str_landed"] or 0
                    tc["td"] += me_stat["td_landed"] or 0
                    tc["minutes"] += minutes
                    tc["n"] += 1
                    tr = traj_recent[fid]
                    tr["slpm"].append((me_stat["sig_str_landed"] or 0) / minutes)
                    tr["sapm"].append((opp_stat["sig_str_landed"] or 0) / minutes)
                    tr["td15"].append((me_stat["td_landed"] or 0) / minutes * 15.0)

        snaps.post[(bid, fa)] = snapshot(fa)
        snaps.post[(bid, fb)] = snapshot(fb)

    all_fighters = set(elo) | set(opp_hist) | set(glicko) | set(traj_career)
    for m in RATING_METRICS:
        all_fighters |= set(off[m]) | set(deff[m])
    for fid in all_fighters:
        snaps.current[fid] = snapshot(fid)
    return snaps


# SQL for consumers that don't already hold the frames (custom-sim worker).
ALL_BOUTS_SQL = """
SELECT
  b.id::text AS bout_id,
  e.date::date AS event_date,
  b.fighter_a_id::text AS fighter_a_id,
  b.fighter_b_id::text AS fighter_b_id,
  b.winner_id::text AS winner_id,
  b.method::text AS method,
  b.status::text AS status,
  b.scheduled_rounds,
  b.round_finished,
  b.time_finished_seconds
FROM bout b
JOIN event e ON e.id = b.event_id
WHERE e.promotion = 'ufc' AND b.status = 'completed'
ORDER BY e.date ASC, b.bout_order ASC NULLS LAST, b.id ASC
"""

ALL_ROUND_STATS_SQL = """
SELECT
  brs.bout_id::text AS bout_id,
  brs.fighter_id::text AS fighter_id,
  SUM(brs.sig_str_landed)::int AS sig_str_landed,
  SUM(brs.takedowns_landed)::int AS td_landed,
  SUM(brs.knockdowns)::int AS knockdowns,
  SUM(brs.control_time_seconds)::int AS control_seconds
FROM bout_round_stats brs
GROUP BY brs.bout_id, brs.fighter_id
"""


def compute_from_connection(conn) -> RatingSnapshots:
    """Fetch the full timeline and replay — for the custom-sim worker."""
    def fetch(sql: str) -> pd.DataFrame:
        with conn.cursor() as cur:
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            return pd.DataFrame(cur.fetchall(), columns=cols)

    return compute_rating_snapshots(fetch(ALL_BOUTS_SQL), fetch(ALL_ROUND_STATS_SQL))
