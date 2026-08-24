"""Ingest a directory of fight videos and match each file to a bout.

The pipeline should not care where footage came from. YouTube gave us
110 fights and then stopped giving; Fight Pass, a hard drive, or a
colleague's export should all drop into the same place. So the source of
truth for "what is this file" is the filename plus our own bout table,
not any provider's catalogue.

Matching is deliberately paranoid. A single surname is not evidence —
Silva, Santos, Oliveira and Nascimento each name dozens of fighters in
this database. The rule here is that BOTH sides of a bout must appear in
the filename and must meet in exactly ONE bout, and that bout's true
length (round-and-clock) must be consistent with the file's runtime.
Anything ambiguous is reported, never guessed. This is the same standard
the Sherdog matcher holds, and for the same reason: a wrong match does
not announce itself downstream, it just quietly poisons a correlation.
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .manifest import ARTIFACTS, MAX_SLACK_SECONDS, MIN_SLACK_SECONDS, ROUND_SECONDS

VIDEO_SUFFIXES = {".mp4", ".mkv", ".mov", ".m4v", ".webm", ".ts"}

# Surnames shorter than this match too much noise inside filenames
# ("UFC", "vs", "HD", quality tags, release-group names).
MIN_TOKEN_LENGTH = 4


@dataclass(frozen=True)
class LocalMatch:
    path: str
    bout_id: str | None
    title: str | None
    event_date: str | None
    duration_seconds: int | None
    fight_seconds: int | None
    status: str          # matched | ambiguous | unmatched | inconsistent
    detail: str


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def probe_duration(path: Path) -> int | None:
    """Runtime in whole seconds, via ffprobe."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        return int(float(proc.stdout.strip()))
    except ValueError:
        return None


def _load_fighter_index(conn) -> dict[str, list[str]]:
    """Distinctive name token -> fighter ids carrying it."""
    with conn.cursor() as cur:
        cur.execute("select id::text, name_en from fighter where name_en is not null")
        rows = cur.fetchall()

    index: dict[str, list[str]] = {}
    for fid, name in rows:
        for token in _normalise(name).split():
            if len(token) >= MIN_TOKEN_LENGTH:
                index.setdefault(token, []).append(fid)
    return index


def _load_bouts(conn) -> dict[tuple[str, str], dict]:
    """(fighter_a, fighter_b) -> bout, keyed both ways round."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select b.id::text, b.fighter_a_id::text, b.fighter_b_id::text,
                   fa.name_en, fb.name_en, e.date::date::text,
                   ((b.round_finished - 1) * %s
                      + coalesce(b.time_finished_seconds, 0))::int
            from bout b
            join event e   on e.id = b.event_id
            join fighter fa on fa.id = b.fighter_a_id
            join fighter fb on fb.id = b.fighter_b_id
            where b.status = 'completed' and b.round_finished is not null
            """,
            (ROUND_SECONDS,),
        )
        rows = cur.fetchall()

    bouts: dict[tuple[str, str], dict] = {}
    for bid, fa, fb, na, nb, date, secs in rows:
        record = {
            "bout_id": bid, "title": f"{na} vs {nb}",
            "event_date": date, "fight_seconds": secs,
        }
        bouts[(fa, fb)] = record
        bouts[(fb, fa)] = record
    return bouts


def match_directory(directory: Path) -> list[LocalMatch]:
    from .db import get_connection

    files = sorted(
        p for p in directory.rglob("*") if p.suffix.lower() in VIDEO_SUFFIXES
    )
    if not files:
        return []

    with get_connection() as conn:
        index = _load_fighter_index(conn)
        bouts = _load_bouts(conn)

    results: list[LocalMatch] = []
    for path in files:
        tokens = set(_normalise(path.stem).split())
        hits: set[str] = set()
        for token in tokens:
            hits.update(index.get(token, []))

        candidates = [
            bouts[(a, b)]
            for a in hits
            for b in hits
            if a < b and (a, b) in bouts
        ]
        # The same pair can meet more than once (rematches); dedupe by bout.
        unique = {c["bout_id"]: c for c in candidates}

        if not unique:
            results.append(LocalMatch(str(path), None, None, None, None, None,
                                      "unmatched",
                                      "no pair of fighters in this filename meets in a completed bout"))
            continue

        duration = probe_duration(path)

        if len(unique) > 1:
            # A rematch is the usual cause. Runtime breaks the tie only if
            # exactly one candidate is consistent with it.
            if duration is not None:
                consistent = [
                    c for c in unique.values()
                    if MIN_SLACK_SECONDS <= duration - c["fight_seconds"] <= MAX_SLACK_SECONDS
                ]
                if len(consistent) == 1:
                    unique = {consistent[0]["bout_id"]: consistent[0]}
            if len(unique) > 1:
                names = ", ".join(f"{c['title']} ({c['event_date']})" for c in unique.values())
                results.append(LocalMatch(str(path), None, None, None, duration, None,
                                          "ambiguous",
                                          f"{len(unique)} candidate bouts and runtime does not separate them: {names}"))
                continue

        bout = next(iter(unique.values()))

        if duration is None:
            results.append(LocalMatch(str(path), bout["bout_id"], bout["title"],
                                      bout["event_date"], None, bout["fight_seconds"],
                                      "inconsistent", "ffprobe could not read a duration"))
            continue

        slack = duration - bout["fight_seconds"]
        if not (MIN_SLACK_SECONDS <= slack <= MAX_SLACK_SECONDS):
            results.append(LocalMatch(str(path), bout["bout_id"], bout["title"],
                                      bout["event_date"], duration, bout["fight_seconds"],
                                      "inconsistent",
                                      f"runtime off by {slack}s against {bout['title']} — a clip, an event replay, or a wrong match"))
            continue

        results.append(LocalMatch(str(path), bout["bout_id"], bout["title"],
                                  bout["event_date"], duration, bout["fight_seconds"],
                                  "matched", f"matched {bout['title']} ({bout['event_date']})"))

    return results


def write_local_manifest(matches: list[LocalMatch]) -> Path:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS / "local_manifest.json"
    payload = [m.__dict__ for m in matches]
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return path
