"""Custom "dream fight" simulations — score any fighter pair, each at the
form they had as of a chosen bout.

Semantics
---------
"Form as of bout X" = the fighter's history up to AND INCLUDING X (their
post-fight shape after that performance). NULL as_of = current form (full
history to date).

Each side's snapshot is evaluated at its OWN point in time so cross-era
fantasy matchups stay fair:
  * age is computed at the fighter's own reference date (Khabib-2018 is
    30, not his age today);
  * layoff is pinned to a NOMINAL_LAYOFF_DAYS camp gap for as-of forms
    (both sides walk in equally "ready" — a 2018 form must not be punished
    for eight years of ring rust it never had). Current form keeps the
    REAL layoff: current means current, rust included.
  * point-in-time vertex scores come from fighter_score_history anchors
    at-or-before the as-of date (the anchor written AT bout X is X's
    post-fight score, which matches the "form including X" contract).

Context: 5 scheduled rounds, main event, non-title. Weight class = the
shared class of both as-of bouts when they agree, else 'catchweight'
(→ wc_other flag).

The worker (scripts/run_custom.py) polls the custom_simulation queue
written by the Next.js server action, scores each pending row with the
committed ensemble artifacts (never retrains), and writes the full result
payload back. Failures mark the row 'failed' with a truncated error so a
poison request can't wedge the queue.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import pandas as pd
from psycopg.types.json import Jsonb
from rich.console import Console

from .db import get_connection
from .export import FighterHistory, _fight_duration_seconds, stable_hash, swap_sides
from .features import build_feature_matrix
from .monte_carlo import FighterMC, simulate_bout
from .opponent_ratings import (
    ALL_KEYS as RATING_ALL_KEYS,
    ELO_INITIAL,
    RatingSnapshots,
    compute_from_connection,
)
from .predict import LoadedModel

console = Console()

# Both as-of fighters walk in off a standard training camp. ~90 days sits in
# the meat of the layoff distribution (median UFC gap is ~4-6 months), so the
# abs_layoff features stay in-distribution and diff_layoff is 0.
NOMINAL_LAYOFF_DAYS = 90

_STD_WC = {
    "strawweight",
    "flyweight",
    "bantamweight",
    "featherweight",
    "lightweight",
    "welterweight",
    "middleweight",
    "light_heavyweight",
    "heavyweight",
}


# --------------------------------------------------------------------------
# Per-fighter form snapshot
# --------------------------------------------------------------------------

# Neutral rating values for a fighter absent from the timeline replay
# (shouldn't happen for anyone with a completed bout, but keeps the worker
# total-function). Ratings are league-mean deviations, so 0.0 = average.
_DEFAULT_RATINGS: dict[str, Any] = {"elo": ELO_INITIAL} | {
    k: (0.0 if not k.startswith(("avg_opp", "max_opp", "sos")) else None)
    for k in RATING_ALL_KEYS
    if k != "elo"
}


FIGHTER_BOUTS_SQL = """
SELECT
  b.id::text AS bout_id,
  (e.date AT TIME ZONE 'UTC')::date AS event_date,
  e.name AS event_name,
  b.fighter_a_id::text AS fighter_a_id,
  b.fighter_b_id::text AS fighter_b_id,
  b.weight_class::text AS weight_class,
  b.is_title_fight,
  b.scheduled_rounds,
  b.winner_id::text AS winner_id,
  b.method::text AS method,
  b.round_finished,
  b.time_finished_seconds
FROM bout b
JOIN event e ON e.id = b.event_id
WHERE e.promotion = 'ufc'
  AND b.status = 'completed'
  AND (b.fighter_a_id = %s::uuid OR b.fighter_b_id = %s::uuid)
ORDER BY e.date ASC, b.bout_order ASC NULLS LAST, b.id ASC
"""

BOUT_STATS_SQL = """
SELECT
  brs.bout_id::text AS bout_id,
  brs.fighter_id::text AS fighter_id,
  SUM(brs.sig_str_landed)::int AS sig_str_landed,
  SUM(brs.sig_str_attempted)::int AS sig_str_attempted,
  SUM(brs.sig_str_head_landed)::int AS sig_str_head_landed,
  SUM(brs.sig_str_body_landed)::int AS sig_str_body_landed,
  SUM(brs.sig_str_legs_landed)::int AS sig_str_legs_landed,
  SUM(brs.sig_str_distance_landed)::int AS sig_str_distance_landed,
  SUM(brs.sig_str_clinch_landed)::int AS sig_str_clinch_landed,
  SUM(brs.sig_str_ground_landed)::int AS sig_str_ground_landed,
  SUM(brs.takedowns_landed)::int AS td_landed,
  SUM(brs.takedowns_attempted)::int AS td_attempted,
  SUM(brs.sub_attempts)::int AS sub_attempts,
  SUM(brs.reversals)::int AS reversals,
  SUM(brs.knockdowns)::int AS knockdowns,
  SUM(brs.control_time_seconds)::int AS control_seconds
FROM bout_round_stats brs
WHERE brs.bout_id = ANY(%s::uuid[])
GROUP BY brs.bout_id, brs.fighter_id
"""

FIGHTER_INFO_SQL = """
SELECT
  f.id::text AS fighter_id,
  f.slug,
  f.name_en,
  f.name_ru,
  f.dob::date AS dob,
  f.height_cm,
  f.reach_cm,
  f.stance::text AS stance,
  f.gender,
  f.photo_thumbnail_url
FROM fighter f
WHERE f.id = %s::uuid
"""

SCORE_HISTORY_SQL = """
SELECT as_of_date::date AS as_of_date, vertex_score, vertex_score_all_time
FROM fighter_score_history
WHERE fighter_id = %s::uuid AND kind = 'bout'
ORDER BY as_of_date ASC
"""


@dataclass
class FormSnapshot:
    fighter_id: str
    snapshot: dict[str, Any]  # FighterHistory.snapshot() keys
    info: dict[str, Any]  # slug, names, dob, height/reach/stance/gender, photo
    as_of_bout_id: str | None
    as_of_date: date  # date of the anchoring bout (or last bout for current)
    reference_date: date  # date the snapshot was evaluated at
    weight_class: str | None  # weight class of the anchoring bout
    age_years: float | None
    record: str  # "W-L" (draws appended when non-zero) at the anchor
    # Point-in-time elo + opponent-adjusted ratings (post-anchor for as-of
    # forms, current otherwise) — keys = opponent_ratings.ALL_KEYS.
    ratings: dict[str, Any]


class SnapshotError(Exception):
    """User-addressable problem (bad as_of, no history) — marks 'failed'."""


def build_form_snapshot(
    conn,
    fighter_id: str,
    as_of_bout_id: str | None,
    *,
    today: date,
    rating_snaps: RatingSnapshots | None = None,
) -> FormSnapshot:
    # The rating replay needs the full bout timeline; callers scoring several
    # snapshots (process_pending) pass a precomputed one to avoid replaying
    # it per side.
    if rating_snaps is None:
        rating_snaps = compute_from_connection(conn)
    with conn.cursor() as cur:
        cur.execute(FIGHTER_INFO_SQL, (fighter_id,))
        info_row = cur.fetchone()
        if info_row is None:
            raise SnapshotError(f"fighter {fighter_id} not found")
        info_cols = [d[0] for d in cur.description]
        info = dict(zip(info_cols, info_row, strict=True))

        cur.execute(FIGHTER_BOUTS_SQL, (fighter_id, fighter_id))
        bout_cols = [d[0] for d in cur.description]
        bouts = [dict(zip(bout_cols, r, strict=True)) for r in cur.fetchall()]

    if as_of_bout_id is not None:
        cut = next(
            (i for i, b in enumerate(bouts) if b["bout_id"] == as_of_bout_id),
            None,
        )
        if cut is None:
            raise SnapshotError(
                f"as_of bout {as_of_bout_id} is not a completed UFC bout of fighter {fighter_id}"
            )
        bouts = bouts[: cut + 1]
    if not bouts:
        raise SnapshotError(f"fighter {fighter_id} has no completed UFC bouts")

    bout_ids = [b["bout_id"] for b in bouts]
    with conn.cursor() as cur:
        cur.execute(BOUT_STATS_SQL, (bout_ids,))
        st_cols = [d[0] for d in cur.description]
        stats: dict[tuple[str, str], dict[str, int]] = {}
        for r in cur.fetchall():
            row = dict(zip(st_cols, r, strict=True))
            stats[(row["bout_id"], row["fighter_id"])] = row

        cur.execute(SCORE_HISTORY_SQL, (fighter_id,))
        history_rows = cur.fetchall()

    h = FighterHistory()
    for b in bouts:
        method = b["method"] or ""
        if method == "no_contest":
            continue  # NCs never touch history (mirrors build_dataset)
        winner = b["winner_id"]
        if winner is None:
            result = "draw"
        elif winner == fighter_id:
            result = "win"
        else:
            result = "loss"
        opp_id = (
            b["fighter_b_id"] if b["fighter_a_id"] == fighter_id else b["fighter_a_id"]
        )
        duration = _fight_duration_seconds(
            {
                "round_finished": b["round_finished"],
                "time_finished_seconds": b["time_finished_seconds"],
            },
            int(b["scheduled_rounds"] or 3),
        )
        h.apply_bout(
            result=result,
            method=b["method"],
            is_title_fight=bool(b["is_title_fight"]),
            event_dt=b["event_date"],
            own_stats=stats.get((b["bout_id"], fighter_id)),
            opp_stats=stats.get((b["bout_id"], opp_id)),
            duration_seconds=duration,
        )

    anchor = bouts[-1]
    as_of_date: date = anchor["event_date"]
    # Current form is evaluated today (real layoff / real age); an as-of form
    # is evaluated a nominal camp later so both sides read as fight-ready.
    reference_date = (
        today
        if as_of_bout_id is None
        else as_of_date + timedelta(days=NOMINAL_LAYOFF_DAYS)
    )

    # Point-in-time vertex anchors at-or-before the as-of date (the anchor
    # written AT the bout is its post-fight score — included on purpose).
    vs = vsat = None
    for d, v, vat in history_rows:
        if d <= as_of_date:
            vs, vsat = v, vat
        else:
            break
    h.last_vertex_score = None if vs is None else int(vs)
    h.last_vertex_score_all_time = None if vsat is None else int(vsat)

    snapshot = h.snapshot(reference_date)

    age = None
    if info.get("dob") is not None:
        age = (reference_date - info["dob"]).days / 365.25

    record = f"{h.wins}-{h.losses}"
    draws = h.bouts - h.wins - h.losses
    if draws > 0:
        record += f"-{draws}"

    # Point-in-time ratings mirror the vertex anchor semantics: an as-of
    # form carries values right AFTER the anchoring bout; current form
    # carries values after the full history.
    if as_of_bout_id is not None:
        ratings = rating_snaps.post.get(
            (anchor["bout_id"], fighter_id), _DEFAULT_RATINGS
        )
    else:
        ratings = rating_snaps.current.get(fighter_id, _DEFAULT_RATINGS)

    return FormSnapshot(
        fighter_id=fighter_id,
        snapshot=snapshot,
        info=info,
        as_of_bout_id=as_of_bout_id,
        as_of_date=as_of_date,
        reference_date=reference_date,
        weight_class=anchor["weight_class"],
        age_years=age,
        record=record,
        ratings=dict(ratings),
    )


# --------------------------------------------------------------------------
# Pair scoring
# --------------------------------------------------------------------------


def _sim_weight_class(a: FormSnapshot, b: FormSnapshot) -> str:
    if (
        a.weight_class
        and a.weight_class == b.weight_class
        and a.weight_class in _STD_WC
    ):
        return a.weight_class
    return "catchweight"  # → wc_other one-hot


def score_pair(
    model: LoadedModel, sim_id: str, a: FormSnapshot, b: FormSnapshot
) -> dict[str, Any]:
    wc = _sim_weight_class(a, b)
    gender = a.info.get("gender") or b.info.get("gender") or "male"

    row: dict[str, Any] = {
        "bout_id": sim_id,
        "event_id": sim_id,
        "event_date": max(a.reference_date, b.reference_date),
        "weight_class": wc,
        "is_title_fight": False,
        "is_main_event": True,
        "scheduled_rounds": 5,
        "fighter_a_id": a.fighter_id,
        "fighter_b_id": b.fighter_id,
        "height_a": a.info.get("height_cm"),
        "height_b": b.info.get("height_cm"),
        "reach_a": a.info.get("reach_cm"),
        "reach_b": b.info.get("reach_cm"),
        "age_a": a.age_years,
        "age_b": b.age_years,
        "stance_a": a.info.get("stance"),
        "stance_b": b.info.get("stance"),
        "gender": gender,
        "market_prob_a": None,
        "target_a_wins": 0,  # dummy — build_feature_matrix selects on it
    }
    for key in RATING_ALL_KEYS:
        row[f"{key}_a"] = a.ratings.get(key)
        row[f"{key}_b"] = b.ratings.get(key)
    for k, v in a.snapshot.items():
        row[f"{k}_a"] = v
    for k, v in b.snapshot.items():
        row[f"{k}_b"] = v

    df = pd.DataFrame([row])
    X, _, _ = build_feature_matrix(df)
    X_swapped, _, _ = build_feature_matrix(swap_sides(df))
    # Order-invariant winner prob, same as predict.py.
    p_orig = float(model.predict_proba_a(X)[0])
    p_swap = float(model.predict_proba_a(X_swapped)[0])
    prob_a = 0.5 * (p_orig + (1.0 - p_swap))

    mc = simulate_bout(
        FighterMC.from_snapshot(a.snapshot),
        FighterMC.from_snapshot(b.snapshot),
        5,
        seed=stable_hash(sim_id),
    )

    def side_payload(s: FormSnapshot) -> dict[str, Any]:
        snap = s.snapshot
        return {
            "fighter_id": s.fighter_id,
            "slug": s.info.get("slug"),
            "name_en": s.info.get("name_en"),
            "name_ru": s.info.get("name_ru"),
            "photo_thumbnail_url": s.info.get("photo_thumbnail_url"),
            "as_of_bout_id": s.as_of_bout_id,
            "as_of_date": s.as_of_date.isoformat(),
            "record": s.record,
            "age": None if s.age_years is None else round(s.age_years, 1),
            "weight_class": s.weight_class,
            "vertex_score": snap.get("vertex_score"),
            "vertex_score_all_time": snap.get("vertex_score_all_time"),
            "slpm": _round(snap.get("slpm")),
            "td_per15": _round(snap.get("td_per15")),
            "sub_per15": _round(snap.get("sub_per15")),
            "kd_per_fight": _round(snap.get("kd_per_fight")),
            "current_streak": snap.get("current_streak"),
        }

    return {
        "prob_a": round(prob_a, 4),
        "prob_b": round(1.0 - prob_a, 4),
        "mc": {
            "n": mc.n_simulations,
            "prob_ko_a": _round(mc.prob_ko_a),
            "prob_ko_b": _round(mc.prob_ko_b),
            "prob_sub_a": _round(mc.prob_sub_a),
            "prob_sub_b": _round(mc.prob_sub_b),
            "prob_decision_a": _round(mc.prob_decision_a),
            "prob_decision_b": _round(mc.prob_decision_b),
            "avg_finish_seconds": _round(mc.avg_finish_seconds),
            "finish_round": {
                str(r): _round(mc.prob_finish_per_round.get(r))
                for r in (1, 2, 3, 4, 5)
            },
        },
        "context": {
            "weight_class": wc,
            "scheduled_rounds": 5,
            "gender": gender,
        },
        "a": side_payload(a),
        "b": side_payload(b),
    }


def _round(v: Any, nd: int = 4) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if pd.isna(f):
        return None
    return round(f, nd)


# --------------------------------------------------------------------------
# Queue processing
# --------------------------------------------------------------------------

CLAIM_SQL = """
SELECT id::text, fighter_a_id::text, fighter_b_id::text,
       as_of_bout_a_id::text, as_of_bout_b_id::text
FROM custom_simulation
WHERE status = 'pending'
ORDER BY requested_at ASC
LIMIT %s
FOR UPDATE SKIP LOCKED
"""


def process_pending(model: LoadedModel, *, limit: int = 10) -> int:
    """Score up to `limit` pending queue rows. Returns rows processed."""
    processed = 0
    today = date.today()
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(CLAIM_SQL, (limit,))
            jobs = cur.fetchall()
        # One full-timeline rating replay per batch (not per side) — the
        # walk is the expensive part of snapshot building.
        rating_snaps = compute_from_connection(conn) if jobs else None
        for sim_id, fa, fb, asof_a, asof_b in jobs:
            try:
                snap_a = build_form_snapshot(conn, fa, asof_a, today=today, rating_snaps=rating_snaps)
                snap_b = build_form_snapshot(conn, fb, asof_b, today=today, rating_snaps=rating_snaps)
                result = score_pair(model, sim_id, snap_a, snap_b)
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE custom_simulation
                        SET status = 'done', result = %s,
                            model_version = %s, error = NULL,
                            completed_at = now()
                        WHERE id = %s::uuid
                        """,
                        (Jsonb(result), model.model_version, sim_id),
                    )
                console.log(
                    f"scored {sim_id}: P(A)={result['prob_a']:.3f} "
                    f"({result['a']['name_en']} vs {result['b']['name_en']})"
                )
            except SnapshotError as e:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE custom_simulation
                        SET status = 'failed', error = %s, completed_at = now()
                        WHERE id = %s::uuid
                        """,
                        (str(e)[:500], sim_id),
                    )
                console.log(f"failed {sim_id}: {e}")
            except Exception as e:  # noqa: BLE001 — poison rows must not wedge the queue
                console.log(f"ERROR {sim_id}: {e}\n{traceback.format_exc()}")
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE custom_simulation
                        SET status = 'failed', error = %s, completed_at = now()
                        WHERE id = %s::uuid
                        """,
                        (f"internal: {e}"[:500], sim_id),
                    )
            processed += 1
        conn.commit()
    return processed
