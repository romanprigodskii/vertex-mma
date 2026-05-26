"""
Pull videos from UFC's YouTube channel, restrict to titles that literally
contain "FULL FIGHT", "FREE FIGHT", or "ПОЛНЫЙ БОЙ" (case-insensitive —
UFC's canonical labels for actual fight uploads; "Free Fight" is the older
branding for the same content type), parse out the `<A> vs <B>` pair, and
link them to bouts in our DB. Sibling labels — "Finish Fight", "Highlights",
"Fight Motion", "Fight Recap" — are deliberately excluded.

Match strategy: normalize fighter names (lower, strip accents/punctuation),
then look for a bout where BOTH fighters appear. If a year/event hint is
present in the title (e.g. "UFC 243" or "UFC Vegas 117"), prefer the bout
whose event slug or name contains that hint. Otherwise pick the most-recent
matching bout (UFC reposts old fights too — newest fight match wins).

Idempotent: bout_video has a UNIQUE(bout_id, youtube_video_id) constraint
and we use ON CONFLICT DO NOTHING.
"""
from __future__ import annotations

import _path  # noqa: F401

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone

import yt_dlp

from src.db import get_connection
from src.utils.logger import log

UFC_CHANNEL_URL = "https://www.youtube.com/@UFC/videos"

# How many videos to pull from the channel feed. The channel has 10k+ items
# historically — fetching everything once is fine but takes a few minutes.
# Set to None to fetch all.
DEFAULT_PLAYLIST_END: int | None = None

VS_RE = re.compile(r"\s+vs\.?\s+", re.IGNORECASE)
# Trailing "2" / "3" / "II" on a fighter name = rematch indicator we want to
# strip before matching (DB stores them as separate bouts, not a name suffix).
REMATCH_TAIL_RE = re.compile(r"\s+(?:[1-9]|II|III|IV)$", re.IGNORECASE)
# UFC event hint, e.g. "UFC 243", "UFC Vegas 117", "UFC Macau", "UFC Fight Night 250".
EVENT_HINT_RE = re.compile(
    r"\bUFC\b(?:\s+[A-Za-z]+)*\s*\d*",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ParsedTitle:
    fighter_a_raw: str
    fighter_b_raw: str
    fighter_a_norm: str
    fighter_b_norm: str
    event_hint: str | None


def normalize(name: str) -> str:
    """Lowercase, strip accents and non-alphanumeric, collapse whitespace."""
    name = name.strip().lower()
    # Decompose accents (Ó → O), drop combining marks.
    nfkd = unicodedata.normalize("NFKD", name)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    # Common ascii substitutions UFC uses freely.
    no_accents = no_accents.replace("'", "").replace("'", "").replace("`", "")
    no_accents = no_accents.replace(".", " ")
    cleaned = re.sub(r"[^a-z0-9 ]+", " ", no_accents)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def strip_rematch_tail(name: str) -> str:
    """Drop trailing rematch number — 'Daniel Cormier 2' → 'Daniel Cormier'."""
    return REMATCH_TAIL_RE.sub("", name).strip()


NON_FIGHT_TOKENS = (
    "weigh-in",
    "weigh in",
    "weigh-ins",
    "faceoff",
    "face-off",
    "face off",
    "press conference",
    "countdown",
    "promo",
    "embedded",
    "preview",
    "prediction",
    "predictions",
    "open workout",
    "open workouts",
    "media day",
    "fight promo",
    "build up",
    "build-up",
    "cold open",
    "prelim open",
    "media scrum",
    "behind the scenes",
    "ufc journey",
    "the walk",
    "fight motion",
    "fight pass exclusive interview",
    " pride ",
    "pride full fight",
    "boxing match",
    "paintball",
)


def parse_title(title: str) -> ParsedTitle | None:
    """Extract (fighter_a, fighter_b, event_hint) if the title matches a
    `<A> vs <B>` UFC fight pattern. Returns None for non-fight content
    (interviews, promos, KO compilations, training pieces, etc.).

    Hard requirement: title MUST contain "full fight", "free fight", or
    "полный бой" (case-insensitive). UFC uses many sibling labels for
    near-fight content — "Finish Fight", "Highlights", "Fight Recap",
    "Fight Motion" — none of which are actual fight uploads, so we exclude
    them by demanding one of the canonical full-fight labels."""
    lower_title = title.lower()
    if " vs " not in lower_title and " vs." not in lower_title:
        return None
    if (
        "full fight" not in lower_title
        and "free fight" not in lower_title
        and "полный бой" not in lower_title
    ):
        return None
    for token in NON_FIGHT_TOKENS:
        if token in lower_title:
            return None

    head = title

    # "Free Fight: A vs B | …" → drop the prefix so we don't snag it onto A.
    head = re.sub(r"^\s*(free\s+fight|full\s+fight|fight\s+of\s+the\s+night)\s*[:\-—–]\s*", "", head, flags=re.IGNORECASE)

    # Split on first vs occurrence.
    parts = VS_RE.split(head, maxsplit=1)
    if len(parts) != 2:
        return None
    left, right = parts

    # Right side ends at first separator: |, :, -, –, —
    # ...but keep hyphenated names intact (e.g. "Jean-Pierre"); we only split
    # on a separator surrounded by spaces, or by a pipe.
    right_split = re.split(r"\s*[|:•·]\s*|\s+[-–—]\s+", right, maxsplit=1)
    right_a = right_split[0].strip()
    tail = right_split[1] if len(right_split) > 1 else ""

    # Left side: usually the title starts with the fighter's name. If there's
    # a leading "FREE FIGHT" badge or similar, strip prior tokens after the
    # last separator.
    left_split = re.split(r"\s*[|:•·]\s*", left)
    left_a = left_split[-1].strip()

    # Drop rematch suffix.
    fighter_a = strip_rematch_tail(left_a)
    fighter_b = strip_rematch_tail(right_a)

    if not fighter_a or not fighter_b:
        return None

    norm_a = normalize(fighter_a)
    norm_b = normalize(fighter_b)

    # Sanity: each side should be 1-5 words, mostly alphabetic.
    def looks_like_name(s: str) -> bool:
        words = s.split()
        if not (1 <= len(words) <= 5):
            return False
        # First word must start with a letter (not "the", "best", etc. — but
        # we allow common fighter words). Reject obvious non-name leading
        # tokens.
        bad_leads = {"the", "best", "every", "all", "top", "watch", "his",
                     "her", "highlights", "knockouts", "ko", "kos",
                     "submissions", "subs", "moments"}
        if words[0] in bad_leads:
            return False
        return True

    if not looks_like_name(norm_a) or not looks_like_name(norm_b):
        return None

    event_hint = None
    if tail:
        m = EVENT_HINT_RE.search(tail)
        if m:
            event_hint = m.group(0).strip()
        else:
            # If tail itself is short and contains "UFC", treat the whole tail.
            if "ufc" in tail.lower():
                event_hint = tail.strip()

    return ParsedTitle(
        fighter_a_raw=fighter_a,
        fighter_b_raw=fighter_b,
        fighter_a_norm=norm_a,
        fighter_b_norm=norm_b,
        event_hint=event_hint,
    )


@dataclass(frozen=True)
class BoutCandidate:
    bout_id: str
    fighter_a_norm: str
    fighter_b_norm: str
    event_name_norm: str
    event_slug: str
    event_date: datetime


@dataclass
class BoutIndex:
    full: dict[tuple[str, str], list[BoutCandidate]]
    last_name: dict[tuple[str, str], list[BoutCandidate]]


def _last_token(norm_name: str) -> str:
    tokens = norm_name.split()
    return tokens[-1] if tokens else norm_name


def load_bout_index(conn) -> BoutIndex:
    """One-shot read of every bout with normalized fighter name pair as key
    (sorted alphabetically so we can match either order). Also builds a
    last-name-only index for titles like 'Malott vs Burns'."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT b.id::text,
                   fa.name_en,
                   fb.name_en,
                   e.name,
                   e.slug,
                   e.date
            FROM bout b
            JOIN fighter fa ON fa.id = b.fighter_a_id
            JOIN fighter fb ON fb.id = b.fighter_b_id
            JOIN event e ON e.id = b.event_id
            """
        )
        rows = cur.fetchall()

    full: dict[tuple[str, str], list[BoutCandidate]] = {}
    last_name: dict[tuple[str, str], list[BoutCandidate]] = {}
    for bout_id, a_name, b_name, ev_name, ev_slug, ev_date in rows:
        a_norm = normalize(a_name)
        b_norm = normalize(b_name)
        cand = BoutCandidate(
            bout_id=bout_id,
            fighter_a_norm=a_norm,
            fighter_b_norm=b_norm,
            event_name_norm=normalize(ev_name),
            event_slug=ev_slug,
            event_date=ev_date,
        )
        full.setdefault(tuple(sorted([a_norm, b_norm])), []).append(cand)
        last_name.setdefault(
            tuple(sorted([_last_token(a_norm), _last_token(b_norm)])),
            [],
        ).append(cand)
    return BoutIndex(full=full, last_name=last_name)


def match_bout(
    parsed: ParsedTitle,
    index: BoutIndex,
    published_at: datetime | None,
) -> BoutCandidate | None:
    """Look up by sorted normalized name pair. If multiple bouts share the
    pair (rematches), tie-break by event hint, then by closest-to-publish
    date (UFC posts old fights years later, so we can't always assume
    most-recent; but for the no-hint case, the most-recent bout is the
    best guess). Fallback: last-name-only index for titles like
    'Malott vs Burns', but only if the resulting pair is unambiguous."""
    key = tuple(sorted([parsed.fighter_a_norm, parsed.fighter_b_norm]))
    candidates = index.full.get(key, [])
    if not candidates:
        # Last-name fallback: titles with no first names. Only accept if a
        # single unique bout matches — otherwise we'd silently pick the wrong
        # fighter pair (e.g. multiple "Silva"s and "Souza"s in UFC history).
        ln_key = tuple(sorted([
            _last_token(parsed.fighter_a_norm),
            _last_token(parsed.fighter_b_norm),
        ]))
        # Skip if either token is too short or generic to be a unique last
        # name (e.g. "ko", "the", "a").
        if any(len(t) < 3 for t in ln_key):
            return None
        ln_candidates = index.last_name.get(ln_key, [])
        if not ln_candidates:
            return None
        # Multiple bouts share the same last-name pair only when it's a
        # rematch between the SAME two fighters; if there are >1 candidates
        # with different fighter IDs, treat as ambiguous and skip.
        fighter_pairs = {
            tuple(sorted([c.fighter_a_norm, c.fighter_b_norm]))
            for c in ln_candidates
        }
        if len(fighter_pairs) != 1:
            return None
        candidates = ln_candidates
    if len(candidates) == 1:
        return candidates[0]

    # Multiple bouts (rematch). Prefer event-hint match.
    if parsed.event_hint:
        hint_norm = normalize(parsed.event_hint)
        # Strip the "ufc" word to get the discriminator (number or city).
        hint_disc = hint_norm.replace("ufc", "").strip()
        scored: list[tuple[int, BoutCandidate]] = []
        for c in candidates:
            score = 0
            if hint_disc and hint_disc in c.event_name_norm:
                score += 10
            elif hint_norm in c.event_name_norm:
                score += 5
            scored.append((score, c))
        scored.sort(key=lambda t: (-t[0], t[1].event_date), reverse=False)
        # Sort by descending score; tie-break by date (closest to publish).
        scored.sort(key=lambda t: -t[0])
        top = scored[0]
        if top[0] > 0:
            return top[1]

    # Fallback — pick the most recent bout (the channel mostly reposts ancient
    # classics under the "UFC Classics" banner, but more often promotes the
    # latest occurrence first).
    return max(candidates, key=lambda c: c.event_date)


def detect_kind(title: str, duration: float | None) -> str:
    """Every video that gets through parse_title now carries the literal
    "full fight" / "полный бой" label, so they all map to free_fight. The
    highlights enum value is kept on the schema for forward-compat but is
    no longer produced by the scraper."""
    del title, duration  # unused — left in the signature to keep call sites stable.
    return "free_fight"


def fetch_channel_videos(
    channel_url: str = UFC_CHANNEL_URL,
    playlist_end: int | None = DEFAULT_PLAYLIST_END,
) -> list[dict]:
    """Use yt-dlp flat extraction — title + id + duration only, no per-video
    page hits. Fast enough for the whole channel in ~1 minute."""
    opts = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "socket_timeout": 60,
        "retries": 10,
        "extractor_retries": 10,
        "fragment_retries": 10,
    }
    if playlist_end is not None:
        opts["playlistend"] = playlist_end

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(channel_url, download=False)

    entries = info.get("entries") or []
    out: list[dict] = []
    for e in entries:
        if e is None:
            continue
        # extract_flat returns shallow rows.
        out.append({
            "id": e.get("id"),
            "title": e.get("title") or "",
            "duration": e.get("duration"),
            "timestamp": e.get("timestamp"),
            "thumbnail": (e.get("thumbnails") or [{}])[-1].get("url"),
        })
    return out


def main() -> None:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="cap channel pull")
    args = p.parse_args()

    log.info("YouTube ingest: fetching UFC channel video list...")
    videos = fetch_channel_videos(playlist_end=args.limit)
    log.info(f"  fetched {len(videos)} videos from channel")

    with get_connection() as conn:
        log.info("loading bout index from DB...")
        bout_index = load_bout_index(conn)
        log.info(
            f"  {len(bout_index.full)} unique fighter pairs in index "
            f"({len(bout_index.last_name)} last-name pairs)"
        )

        parsed_count = 0
        matched_count = 0
        inserted_count = 0
        skipped_existing = 0
        unmatched_examples: list[str] = []

        with conn.cursor() as cur:
            for v in videos:
                video_id = v.get("id")
                title = v.get("title") or ""
                duration = v.get("duration")
                ts = v.get("timestamp")
                published_at = (
                    datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None
                )
                thumbnail = v.get("thumbnail")
                if not video_id or not title:
                    continue

                parsed = parse_title(title)
                if parsed is None:
                    continue
                parsed_count += 1

                cand = match_bout(parsed, bout_index, published_at)
                if cand is None:
                    if len(unmatched_examples) < 8:
                        unmatched_examples.append(title)
                    continue
                matched_count += 1

                kind = detect_kind(title, duration)
                duration_int = int(duration) if duration else None

                cur.execute(
                    """
                    INSERT INTO bout_video (
                      bout_id, youtube_video_id, kind, title,
                      duration_seconds, published_at, thumbnail_url
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (bout_id, youtube_video_id) DO NOTHING
                    RETURNING id
                    """,
                    (
                        cand.bout_id,
                        video_id,
                        kind,
                        title,
                        duration_int,
                        published_at,
                        thumbnail,
                    ),
                )
                if cur.fetchone() is not None:
                    inserted_count += 1
                else:
                    skipped_existing += 1

        conn.commit()

    log.info(
        "YouTube ingest done: "
        f"parsed_titles={parsed_count} matched={matched_count} "
        f"inserted={inserted_count} already_present={skipped_existing}"
    )
    if unmatched_examples:
        log.info("  examples of parsed-but-unmatched titles (no bout in DB):")
        for t in unmatched_examples:
            log.info(f"    · {t}")


if __name__ == "__main__":
    main()
