"""bout_video -> a corpus we are willing to trust.

`bout_video` was matched from YouTube titles, and a title match is the
same species of evidence that once wrote a 2026 closing line onto a 2025
fight. Here there is a free independent check: a video claiming to be a
fight cannot be shorter than the fight. Two rows fail it — both are
finish-only clips carrying the FULL FIGHT label — and they are dropped
rather than explained away.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .db import get_connection

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"

# A round is five minutes. UFCStats clocks the finish within its round.
ROUND_SECONDS = 300

# Uploads carry walkouts, the Buffer intro, replays and the post-fight
# interview. Everything inside this band is plausible; outside it, the
# row is claiming to be something it isn't.
MIN_SLACK_SECONDS = -30      # video may trim a few seconds of the clock
MAX_SLACK_SECONDS = 1500     # 25 min of ceremony is already generous


@dataclass(frozen=True)
class Fight:
    bout_id: str
    youtube_video_id: str
    title: str
    event_date: str
    duration_seconds: int
    fight_seconds: int
    scheduled_rounds: int
    round_finished: int
    method: str
    # Ground truth, summed over both fighters and every round.
    sig_str_distance: int
    sig_str_clinch: int
    sig_str_ground: int
    control_seconds: int
    takedowns: int
    knockdowns: int

    @property
    def positional_strikes(self) -> int:
        return self.sig_str_distance + self.sig_str_clinch + self.sig_str_ground

    @property
    def ground_strike_share(self) -> float:
        """UFCStats' verdict on how much of this fight was floor-bound."""
        total = self.positional_strikes
        return self.sig_str_ground / total if total else 0.0

    @property
    def distance_strike_share(self) -> float:
        total = self.positional_strikes
        return self.sig_str_distance / total if total else 0.0

    @property
    def control_share(self) -> float:
        return min(1.0, self.control_seconds / self.fight_seconds) if self.fight_seconds else 0.0


_QUERY = """
select
  b.id::text                              as bout_id,
  v.youtube_video_id,
  v.title,
  e.date::date::text                      as event_date,
  v.duration_seconds,
  b.scheduled_rounds,
  b.round_finished,
  coalesce(b.method::text, 'unknown')     as method,
  coalesce(sum(rs.sig_str_distance_landed), 0)::int as sig_str_distance,
  coalesce(sum(rs.sig_str_clinch_landed), 0)::int   as sig_str_clinch,
  coalesce(sum(rs.sig_str_ground_landed), 0)::int   as sig_str_ground,
  coalesce(sum(rs.control_time_seconds), 0)::int    as control_seconds,
  coalesce(sum(rs.takedowns_landed), 0)::int        as takedowns,
  coalesce(sum(rs.knockdowns), 0)::int              as knockdowns,
  ((b.round_finished - 1) * %(round_seconds)s
     + coalesce(b.time_finished_seconds, 0))::int   as fight_seconds
from bout_video v
join bout b   on b.id = v.bout_id
join event e  on e.id = b.event_id
left join bout_round_stats rs on rs.bout_id = b.id
where b.round_finished is not null
  and v.duration_seconds is not null
group by b.id, v.youtube_video_id, v.title, e.date, v.duration_seconds,
         b.scheduled_rounds, b.round_finished, b.method, b.time_finished_seconds
order by e.date desc
"""


def load_corpus() -> tuple[list[Fight], list[dict]]:
    """Return (usable fights, rejected rows with the reason)."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(_QUERY, {"round_seconds": ROUND_SECONDS})
        cols = [d.name for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    usable: list[Fight] = []
    rejected: list[dict] = []
    for row in rows:
        slack = row["duration_seconds"] - row["fight_seconds"]
        if slack < MIN_SLACK_SECONDS:
            rejected.append(
                {**row, "reason": f"video shorter than the fight by {-slack}s — a clip, not the bout"}
            )
            continue
        if slack > MAX_SLACK_SECONDS:
            rejected.append(
                {**row, "reason": f"video overruns the fight by {slack}s — compilation or wrong match"}
            )
            continue
        usable.append(Fight(**row))

    return usable, rejected


def write_manifest() -> Path:
    usable, rejected = load_corpus()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS / "manifest.json"
    path.write_text(
        json.dumps(
            {
                "usable_count": len(usable),
                "rejected_count": len(rejected),
                "round_seconds": ROUND_SECONDS,
                "slack_band": [MIN_SLACK_SECONDS, MAX_SLACK_SECONDS],
                "fights": [asdict(f) for f in usable],
                "rejected": rejected,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return path


def read_manifest() -> list[Fight]:
    path = ARTIFACTS / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing — run scripts/build_manifest.py first")
    data = json.loads(path.read_text())
    return [Fight(**f) for f in data["fights"]]
