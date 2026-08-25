"""Turn found YouTube titles into bouts we can actually use.

A title is not a bout. "Jon Jones vs Daniel Cormier" names two fights
four years apart, and the corpus already carries the scar of a match
made on names alone. So: both surnames must resolve to fighters who met
in exactly one completed bout, and that bout's true length — round and
clock — must agree with the video's runtime. Rematches that survive
both tests are reported, never guessed.

Then the number that matters: how many fighters end up with enough
fights on tape to have a trajectory at all.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.db import get_connection  # noqa: E402
from src.manifest import MAX_SLACK_SECONDS, MIN_SLACK_SECONDS, ROUND_SECONDS  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
MIN_TOKEN = 4

# "Joshua Van vs Brandon Royval" pulled in Brandon MORENO's bouts,
# because a single shared token was enough to nominate a fighter. Names
# have to match as names: every token of a fighter's name must be
# present, so a shared first name alone nominates nobody.
#
# And the ordinal is the one trustworthy disambiguator. Titles carry it
# — "Poirier vs Gaethje 1", "Holloway vs Poirier 3" — and it says which
# meeting this is. The trailing event tag does NOT: "Holloway vs Poirier
# 3 | UFC 329" is the card the clip was posted around, while the fight
# itself is UFC 318. Matching on that tag would be confidently wrong,
# which is worse than ambiguous.
ORDINAL = re.compile(r"\bvs\.?\s+[^|]*?\b([1-4])\b")


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def main() -> None:
    src = ARTIFACTS / "youtube_census_full.json"
    if not src.exists():
        src = ARTIFACTS / "youtube_census.json"
    fights = json.loads(src.read_text())["fights"]
    print(f"census: {len(fights)} candidate videos ({src.name})")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("select id::text, name_en from fighter where name_en is not null")
        fighter_tokens = {}
        index = defaultdict(list)
        for fid, name in cur.fetchall():
            toks = [t for t in norm(name).split() if len(t) >= MIN_TOKEN]
            if not toks:
                continue
            fighter_tokens[fid] = set(toks)
            for tok in toks:
                index[tok].append(fid)
        cur.execute(
            """select b.id::text, b.fighter_a_id::text, b.fighter_b_id::text,
                      e.date::date::text,
                      ((b.round_finished-1)*%s + coalesce(b.time_finished_seconds,0))::int
               from bout b join event e on e.id=b.event_id
               where b.status='completed' and b.round_finished is not null""",
            (ROUND_SECONDS,))
        bouts = {}
        for bid, a, b, date, secs in cur.fetchall():
            bouts.setdefault(frozenset((a, b)), []).append(
                {"bout_id": bid, "a": a, "b": b, "date": date, "secs": secs})
        cur.execute("select youtube_video_id from bout_video")
        already = {r[0] for r in cur.fetchall()}

    matched, ambiguous, unmatched = [], 0, 0
    for f in fights:
        toks = set(norm(f["title"]).split())
        hits = {fid for t in toks for fid in index.get(t, [])}
        # Every token of the name, not merely one of them.
        hits = {fid for fid in hits if fighter_tokens[fid] <= toks}
        cands = [c for a in hits for b in hits if a < b
                 for c in bouts.get(frozenset((a, b)), [])]
        uniq = {c["bout_id"]: c for c in cands}
        if not uniq:
            unmatched += 1
            continue
        try:
            dur = int(float(f["duration"]))
        except (TypeError, ValueError):
            unmatched += 1
            continue
        ok = [c for c in uniq.values()
              if MIN_SLACK_SECONDS <= dur - c["secs"] <= MAX_SLACK_SECONDS]

        # A rematch that runtime cannot separate is still separable if
        # the title numbers it. Meetings are ordered by date, so "3" is
        # the third time these two fought.
        if len(ok) != 1 and len(uniq) > 1:
            m = ORDINAL.search(f["title"])
            if m:
                nth = int(m.group(1))
                ordered = sorted(uniq.values(), key=lambda c: c["date"])
                if 1 <= nth <= len(ordered):
                    pick = ordered[nth - 1]
                    if MIN_SLACK_SECONDS <= dur - pick["secs"] <= MAX_SLACK_SECONDS:
                        ok = [pick]

        if len(ok) != 1:
            ambiguous += 1
            continue
        c = ok[0]
        matched.append({**c, "video_id": f["id"], "title": f["title"],
                        "duration": dur, "new": f["id"] not in already})

    print(f"  matched to a single bout : {len(matched)}")
    print(f"  ambiguous (rematches)    : {ambiguous}")
    print(f"  no bout found            : {unmatched}")
    fresh = [m for m in matched if m["new"]]
    print(f"  NEW, not in bout_video   : {len(fresh)}")

    per = defaultdict(int)
    for m in matched:
        per[m["a"]] += 1
        per[m["b"]] += 1
    dist = defaultdict(int)
    for v in per.values():
        dist[v] += 1
    print(f"\nfighters on tape: {len(per)}")
    for k in sorted(dist, reverse=True):
        print(f"  with {k} fights: {dist[k]}")
    for thr in (2, 3, 4):
        print(f"  >= {thr} fights: {sum(v for k, v in dist.items() if k >= thr)}")

    (ARTIFACTS / "census_matched.json").write_text(
        json.dumps({"matched": matched}, indent=2, ensure_ascii=False))
    print(f"\nwritten: {ARTIFACTS / 'census_matched.json'}")


if __name__ == "__main__":
    main()
