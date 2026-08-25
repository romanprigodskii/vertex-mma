"""Ship the per-fighter anchor so the GPU box needs no database.

manifest.json already carries bout-level ground truth. Attribution needs
something it does not: control time PER CORNER, which is what tells us
which pose group is which fighter. Same pattern — export once, ship a
file, keep Postgres out of the rented machine entirely.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.db import get_connection  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"

_QUERY = """
select b.id::text,
       b.fighter_a_id::text, b.fighter_b_id::text,
       fa.name_en, fb.name_en,
       e.date::date::text,
       coalesce(sum(rs.control_time_seconds)
                filter (where rs.fighter_id = b.fighter_a_id), 0)::int,
       coalesce(sum(rs.control_time_seconds)
                filter (where rs.fighter_id = b.fighter_b_id), 0)::int,
       coalesce(sum(rs.sig_str_landed)
                filter (where rs.fighter_id = b.fighter_a_id), 0)::int,
       coalesce(sum(rs.sig_str_landed)
                filter (where rs.fighter_id = b.fighter_b_id), 0)::int,
       (b.winner_id = b.fighter_a_id) as a_won
from bout b
join event e on e.id = b.event_id
join fighter fa on fa.id = b.fighter_a_id
join fighter fb on fb.id = b.fighter_b_id
left join bout_round_stats rs on rs.bout_id = b.id
where b.id = any(%s::uuid[])
group by b.id, b.fighter_a_id, b.fighter_b_id, fa.name_en, fb.name_en,
         e.date, b.winner_id
"""


def main() -> None:
    src = ARTIFACTS / "census_matched.json"
    matched = json.loads(src.read_text())["matched"]
    bout_ids = sorted({m["bout_id"] for m in matched})
    print(f"{len(bout_ids)} bouts from {src.name}")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(_QUERY, (bout_ids,))
        rows = cur.fetchall()

    video_of = {}
    for m in matched:
        video_of.setdefault(m["bout_id"], m["video_id"])

    anchor = []
    for (bid, fa, fb, na, nb, date, ca, cb, sa, sb, a_won) in rows:
        anchor.append({
            "bout_id": bid, "video_id": video_of.get(bid),
            "date": date,
            "fighter_a": fa, "fighter_b": fb,
            "name_a": na, "name_b": nb,
            "control_a": ca, "control_b": cb,
            "sig_a": sa, "sig_b": sb,
            "a_won": bool(a_won) if a_won is not None else None,
        })

    usable = [a for a in anchor if a["control_a"] + a["control_b"] > 0]
    path = ARTIFACTS / "anchor.json"
    path.write_text(json.dumps({"bouts": anchor}, indent=2, ensure_ascii=False))
    print(f"  with control time      : {len(usable)}")
    print(f"  with a decided winner  : {sum(1 for a in anchor if a['a_won'] is not None)}")
    print(f"written: {path}")


if __name__ == "__main__":
    main()
