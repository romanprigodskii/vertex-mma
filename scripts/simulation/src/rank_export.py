"""Point-in-time UFC ranking features from `ranking_snapshot`.

`ranking_snapshot` holds the official UFC divisional rankings as published:
279 snapshots from 2017-01-06 to now, ~every two weeks, rank 0 = champion
and 1..15 = the ranked contenders, one row per (snapshot, division, rank).
47k rows, 532 distinct fighters, and not one of them has ever reached a
model — every lab before this one worked off the fight record.

POINT-IN-TIME CONTRACT. Every column below is read from the latest snapshot
published STRICTLY BEFORE the bout's event date, which is exactly what was
knowable on fight night. Two consequences that are easy to get wrong:

  * "not in that snapshot" means UNRANKED AT THAT MOMENT, not missing. A
    fighter who was #4 in 2019 and fell out by 2021 must read as unranked in
    2021 — so the lookup is (fighter, snapshot_date) against the SNAPSHOT,
    never a backward as-of join on the fighter's own rows (which would happily
    return a two-year-old #4).
  * before 2017-01-06 there is no snapshot at all. Those rows get NaN and
    `rank_has_data = 0`, so the model can tell "unranked" from "we don't know".

Serving is symmetric with training: `run_predict.py` scores upcoming bouts
against the same table, whose newest snapshot is refreshed daily by the
live-rankings cron — no train/serve skew, and nothing here is a closing line.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Rank assigned to a fighter who is outside the top 15 at that snapshot. The
# rankings themselves stop at 15, so "unranked" has no natural number; 20 keeps
# the ordering sane for the diff columns while staying close enough that a
# single unranked side does not dominate a tree split. The raw per-side rank
# columns stay NaN for unranked so the GBTs can still separate the two states.
UNRANKED_LEVEL = 20.0

# A snapshot older than this is treated as no data rather than as truth. The
# publication cadence is ~14 days; the largest real gap in the table is ~10
# weeks (the 2020 COVID pause), and anything beyond that is a scrape hole.
MAX_SNAPSHOT_AGE_DAYS = 90

RANKINGS_SQL = """
SELECT
  fighter_id::text AS fighter_id,
  snapshot_date::date AS snapshot_date,
  division::text AS division,
  is_women,
  rank
FROM ranking_snapshot
WHERE fighter_id IS NOT NULL
ORDER BY snapshot_date, division, rank
"""

# Per-side output columns, in the order build_rank_features emits them.
RANK_BASE_COLUMNS = [
    "rank_div",          # rank in the bout's own division (0 = champion)
    "rank_best",         # best rank held in ANY division at that snapshot
    "rank_is_champ",     # holds a belt somewhere
    "rank_is_ranked",    # appears anywhere in the top 15
    "rank_peak",         # best rank ever reached, career to date
    "rank_tenure_days",  # days since first ever appearance in a top 15
    "rank_delta180",     # rank_best now minus rank_best ~180 days ago
    "rank_share_year",   # share of the last year's snapshots spent ranked
    "rank_days_since",   # days since last appearance (0 while ranked)
]


def fetch_rankings(conn) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(RANKINGS_SQL)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    df = pd.DataFrame(rows, columns=cols)
    # Pin nanosecond resolution: psycopg hands back `date` objects that pandas
    # reads as datetime64[s], and merge_asof refuses to join a [s] key against
    # the [ns] key that any timedelta arithmetic below produces.
    df["snapshot_date"] = pd.to_datetime(df["snapshot_date"]).astype("datetime64[ns]")
    df["rank"] = pd.to_numeric(df["rank"], errors="coerce")
    df["is_women"] = df["is_women"].astype(bool)
    return df


def _per_snapshot_aggregate(ranks: pd.DataFrame) -> pd.DataFrame:
    """One row per (fighter, snapshot): best rank held and whether it is a belt.

    A fighter can sit in two lists at once (champion at 135 while ranked at
    145), so "their rank" needs a rule; `min` is the one the market uses when
    it talks about a fighter's standing.
    """
    g = ranks.groupby(["fighter_id", "snapshot_date"], as_index=False)
    agg = g.agg(rank_best=("rank", "min"))
    agg["rank_is_champ"] = (agg["rank_best"] == 0).astype("int8")
    agg["rank_is_ranked"] = 1
    return agg.sort_values(["fighter_id", "snapshot_date"]).reset_index(drop=True)


def _history_columns(agg: pd.DataFrame, snapshot_dates: np.ndarray) -> pd.DataFrame:
    """Career-to-date columns per (fighter, snapshot), using only snapshots
    strictly older than the row's own — the value AS OF that snapshot.

    `rank_peak` and `rank_tenure_days` shift by one row so a fighter's very
    first ranked snapshot does not read its own rank as history. `rank_share_year`
    counts how many of the previous year's snapshots the fighter was ranked in,
    over how many snapshots the promotion actually published in that window.
    """
    out = agg.copy()
    grp = out.groupby("fighter_id", sort=False)
    # Best rank ever reached BEFORE this snapshot (NaN on the first appearance).
    out["rank_peak"] = grp["rank_best"].cummin().groupby(out["fighter_id"]).shift(1)
    first_seen = grp["snapshot_date"].transform("min")
    out["rank_tenure_days"] = (out["snapshot_date"] - first_seen).dt.days.astype(float)

    # Share of the trailing year spent ranked. Denominator = snapshots the
    # promotion published in that window, so a scrape gap cannot read as a
    # fighter falling out.
    sd = pd.Series(snapshot_dates).sort_values().reset_index(drop=True)
    shares = np.empty(len(out), dtype=float)
    dates = out["snapshot_date"].to_numpy()
    fighters = out["fighter_id"].to_numpy()
    # Per fighter, count their own snapshots inside the trailing window.
    by_fighter: dict[str, np.ndarray] = {
        f: d.to_numpy() for f, d in out.groupby("fighter_id", sort=False)["snapshot_date"]
    }
    sd_np = sd.to_numpy()
    for i in range(len(out)):
        hi = dates[i]
        lo = hi - np.timedelta64(365, "D")
        total = np.searchsorted(sd_np, hi, "left") - np.searchsorted(sd_np, lo, "left")
        own = by_fighter[fighters[i]]
        mine = np.searchsorted(own, hi, "left") - np.searchsorted(own, lo, "left")
        shares[i] = (mine / total) if total > 0 else np.nan
    out["rank_share_year"] = shares

    # rank_best ~180 days earlier, for the trajectory column.
    prev = out[["fighter_id", "snapshot_date", "rank_best"]].copy()
    prev["snapshot_date"] = prev["snapshot_date"] + pd.Timedelta(days=180)
    prev = prev.rename(columns={"rank_best": "rank_best_180"})
    out = pd.merge_asof(
        out.sort_values("snapshot_date"),
        prev.sort_values("snapshot_date"),
        on="snapshot_date",
        by="fighter_id",
        direction="backward",
        tolerance=pd.Timedelta(days=120),
    )
    out["rank_delta180"] = out["rank_best"] - out["rank_best_180"]
    return out.drop(columns=["rank_best_180"])


def _side_frame(
    keys: pd.DataFrame,
    ranks: pd.DataFrame,
    agg: pd.DataFrame,
    hist: pd.DataFrame,
) -> pd.DataFrame:
    """Resolve one side's rank columns.

    `keys` carries fighter_id, snap_date (the latest snapshot strictly before
    the bout), division and is_women. The join is against the SNAPSHOT — an
    absent (fighter, snap_date) pair is an unranked fighter, which is the whole
    point of doing it this way.
    """
    idx = keys.index
    div_join = keys.merge(
        ranks.rename(columns={"snapshot_date": "snap_date", "rank": "rank_div"}),
        on=["fighter_id", "snap_date", "division", "is_women"],
        how="left",
    )
    # A fighter cannot hold two ranks in one division in one snapshot, but a
    # bad scrape could duplicate the row — collapse defensively.
    div_join = div_join.groupby(level=0).first() if div_join.index.has_duplicates else div_join
    out = pd.DataFrame(index=idx)
    out["rank_div"] = div_join["rank_div"].to_numpy()

    best = keys.merge(
        agg.rename(columns={"snapshot_date": "snap_date"}),
        on=["fighter_id", "snap_date"],
        how="left",
    )
    out["rank_best"] = best["rank_best"].to_numpy()
    out["rank_is_champ"] = best["rank_is_champ"].fillna(0).to_numpy()
    out["rank_is_ranked"] = best["rank_is_ranked"].fillna(0).to_numpy()

    h = keys.merge(
        hist[
            ["fighter_id", "snapshot_date", "rank_peak", "rank_tenure_days",
             "rank_share_year", "rank_delta180"]
        ].rename(columns={"snapshot_date": "snap_date"}),
        on=["fighter_id", "snap_date"],
        how="left",
    )
    for col in ("rank_peak", "rank_tenure_days", "rank_share_year", "rank_delta180"):
        out[col] = h[col].to_numpy()

    # Days since the fighter last appeared in ANY list — the "fell out
    # recently" signal that separates a faded contender from a career prelim
    # fighter. 0 while ranked; NaN for someone never ranked at all.
    # merge_asof rejects null join keys, and every bout older than the first
    # snapshot has one — resolve on the dated rows and reindex the rest back to
    # NaN, which is what "the table cannot speak about this bout" should read as.
    dated = (
        keys.loc[keys["snap_date"].notna(), ["fighter_id", "snap_date"]]
        .reset_index()
        .sort_values("snap_date")
    )
    last_seen = pd.merge_asof(
        dated,
        agg[["fighter_id", "snapshot_date"]].sort_values("snapshot_date"),
        left_on="snap_date",
        right_on="snapshot_date",
        by="fighter_id",
        direction="backward",
        allow_exact_matches=True,
    ).set_index("index").reindex(idx)
    out["rank_days_since"] = (
        (keys["snap_date"] - last_seen["snapshot_date"]).dt.days.astype(float)
    )
    # A fighter ranked in the reference snapshot has 0 days since; the asof
    # above already returns that snapshot for them.
    return out[RANK_BASE_COLUMNS]


def build_rank_features(bouts: pd.DataFrame, ranks: pd.DataFrame) -> pd.DataFrame:
    """Per-side ranking columns for every bout row, aligned to `bouts.index`.

    `bouts` needs event_date, fighter_a_id, fighter_b_id, weight_class, gender.
    Returns `rank_*_a` / `rank_*_b` plus the two bout-level context columns.
    """
    if ranks.empty:
        raise ValueError("no ranking snapshots — check ranking_snapshot / the scrape")

    snapshot_dates = np.sort(
        ranks["snapshot_date"].unique().astype("datetime64[ns]")
    )
    event_date = pd.to_datetime(bouts["event_date"]).astype("datetime64[ns]")

    # Latest snapshot published STRICTLY BEFORE the bout. searchsorted 'left'
    # on a sorted unique array gives the count of snapshots < date, so the
    # index of the last one is that minus 1; -1 means the bout predates the
    # table entirely.
    pos = np.searchsorted(snapshot_dates, event_date.to_numpy(), side="left") - 1
    snap_date = pd.Series(
        np.where(pos >= 0, snapshot_dates[np.clip(pos, 0, None)], np.datetime64("NaT")),
        index=bouts.index,
    )
    age_days = (event_date - snap_date).dt.days.astype(float)
    # A stale snapshot is treated as no data at all.
    stale = age_days > MAX_SNAPSHOT_AGE_DAYS
    snap_date = snap_date.mask(stale)
    age_days = age_days.mask(stale)

    is_women = (bouts["gender"].astype(str) == "female") if "gender" in bouts else False
    division = bouts["weight_class"].astype(str)

    out = pd.DataFrame(index=bouts.index)
    agg = _per_snapshot_aggregate(ranks)
    hist = _history_columns(agg, snapshot_dates)

    for side in ("a", "b"):
        keys = pd.DataFrame(
            {
                "fighter_id": bouts[f"fighter_{side}_id"].astype(str),
                "snap_date": snap_date,
                "division": division,
                "is_women": is_women if isinstance(is_women, pd.Series) else False,
            },
            index=bouts.index,
        )
        side_out = _side_frame(keys, ranks, agg, hist)
        for col in RANK_BASE_COLUMNS:
            out[f"{col}_{side}"] = side_out[col].to_numpy()

    # Bout-level context: how fresh the reference snapshot is, and whether we
    # have one at all. `rank_has_data` is what lets the model separate a real
    # unranked fighter from a 2014 bout the table cannot speak about.
    out["rank_snapshot_age_days"] = age_days.to_numpy()
    out["rank_has_data"] = snap_date.notna().astype("int8").to_numpy()
    return out


def effective_rank(rank: pd.Series) -> pd.Series:
    """NaN (unranked) → UNRANKED_LEVEL, so a rank gap is defined for every bout
    where we have a snapshot. Kept separate from the raw column: the raw one
    lets a tree isolate "ranked at all", this one gives it a usable distance."""
    return pd.to_numeric(rank, errors="coerce").fillna(UNRANKED_LEVEL)
