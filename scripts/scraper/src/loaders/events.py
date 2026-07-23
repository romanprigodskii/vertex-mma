from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import psycopg

from ..parsers.event_details import BoutRow, EventDetails
from ..parsers.events import EventListItem
from ..utils.countries import map_country
from ..utils.logger import log
from ..utils.slugify import slug_with_id
from .change_events import (
    KIND_BOUT_REMOVED,
    KIND_OPPONENT_SWAPPED,
    KIND_PROVISIONAL_MERGED,
    SOURCE_UFCSTATS,
    pair_signature,
    record_change,
)


@dataclass
class UpsertCounts:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0


def _location_city(location: str | None) -> str | None:
    if not location:
        return None
    parts = [p.strip() for p in location.split(",") if p.strip()]
    return parts[0] if parts else None


def upsert_event_listing(
    conn: psycopg.Connection,
    items: Iterable[EventListItem],
    *,
    status: str,
    dry_run: bool = False,
) -> UpsertCounts:
    """Insert events from the completed/upcoming listing. Idempotent on ufc_stats_id."""
    counts = UpsertCounts()
    now = datetime.now(timezone.utc)

    with conn.cursor() as cur:
        for item in items:
            slug = slug_with_id(item.name, item.ufc_stats_id)
            city = _location_city(item.location)
            country = map_country(item.location)
            date_value = item.date or now

            if dry_run:
                log.info(
                    f"[DRY] event upsert ufc={item.ufc_stats_id} name={item.name!r} "
                    f"date={date_value.date().isoformat()} status={status}"
                )
                counts.inserted += 1
                continue

            # Reconcile: claim a provisional event (ufc_stats_id IS NULL) that
            # the news pipeline created for this card before UFCStats listed it,
            # so the upsert below updates it IN PLACE — preserving its id and any
            # attached bouts / markets / predictions — instead of inserting a
            # duplicate. The provisional name is the news hint ("UFC 330" or, for
            # a Fight Night, the city — "UFC Belgrade"); the official name is the
            # full card ("UFC 330: Pereira vs Ankalaev", "UFC Fight Night: Medic
            # vs. Rodriguez"), so we match on:
            #   - exact name, OR
            #   - the official name STARTING WITH the hint (numbered cards —
            #     robust even if the LLM's date was wrong), OR
            #   - same UTC calendar day + a weak name-similarity signal (Fight
            #     Nights, once the published-date-anchored year is reliable), OR
            #   - same UTC calendar day + the host CITY: a Fight Night the news
            #     filed under "UFC <City>" carries no name overlap with the
            #     official "Medic vs. Rodriguez" headline, but the city is the
            #     shared signal — match when the official city appears in the
            #     provisional name or its location_city. UFC runs at most one
            #     card per day, so day + city is safe.
            # The day-only branches always require a second signal (name OR city)
            # so two different cards on the same Saturday can't merge. Day
            # comparison is pinned to UTC so a non-UTC session timezone can't
            # shift the calendar day.
            cur.execute(
                """
                UPDATE event SET ufc_stats_id = %(uid)s
                WHERE id = (
                    SELECT e.id FROM event e
                    WHERE e.ufc_stats_id IS NULL AND e.promotion = 'ufc'
                      -- Never stamp an id that already lives on another row:
                      -- when the official event already exists (a dupe that an
                      -- earlier scrape failed to adopt), claiming a provisional
                      -- twin here would hit the ufc_stats_id unique index and
                      -- abort the whole scrape. Those leftovers are merged by
                      -- reconcile_duplicate_events instead; adoption only fires
                      -- on the FIRST scrape, before any official row exists.
                      AND NOT EXISTS (
                        SELECT 1 FROM event x WHERE x.ufc_stats_id = %(uid)s
                      )
                      AND (
                        lower(e.name) = lower(%(name)s)
                        OR lower(%(name)s) LIKE lower(e.name) || '%%'
                        OR (
                          %(date)s IS NOT NULL
                          AND (e.date AT TIME ZONE 'UTC')::date
                              = (%(date)s AT TIME ZONE 'UTC')::date
                          AND similarity(e.name, %(name)s) > 0.3
                        )
                        OR (
                          %(date)s IS NOT NULL
                          AND %(city)s::text IS NOT NULL AND length(trim(%(city)s::text)) > 0
                          AND (e.date AT TIME ZONE 'UTC')::date
                              = (%(date)s AT TIME ZONE 'UTC')::date
                          AND (
                            e.name ILIKE '%%' || %(city)s::text || '%%'
                            OR lower(e.location_city) = lower(%(city)s::text)
                          )
                        )
                      )
                    ORDER BY
                      (lower(%(name)s) LIKE lower(e.name) || '%%') DESC,
                      (lower(e.name) = lower(%(name)s)) DESC,
                      similarity(e.name, %(name)s) DESC
                    LIMIT 1
                )
                """,
                {
                    "uid": item.ufc_stats_id,
                    "name": item.name,
                    "date": item.date,
                    "city": city,
                },
            )

            cur.execute(
                """
                INSERT INTO event (
                    slug, name, short_name, promotion, date,
                    location_city, location_country, venue, status, ufc_stats_id
                )
                VALUES (%s, %s, %s, 'ufc', %s, %s, %s, NULL, %s::event_status, %s)
                ON CONFLICT (ufc_stats_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    date = EXCLUDED.date,
                    location_city = COALESCE(EXCLUDED.location_city, event.location_city),
                    location_country = COALESCE(EXCLUDED.location_country, event.location_country),
                    status = EXCLUDED.status,
                    updated_at = now()
                RETURNING (xmax = 0) AS inserted
                """,
                (slug, item.name, item.name, date_value, city, country, status, item.ufc_stats_id),
            )
            row = cur.fetchone()
            if row and row[0]:
                counts.inserted += 1
            else:
                counts.updated += 1

    return counts


def reconcile_duplicate_events(conn: psycopg.Connection) -> int:
    """Merge a news-created provisional event (ufc_stats_id IS NULL) into its
    official same-day twin when an earlier scrape failed to adopt it in place —
    e.g. the news filed a Fight Night under "UFC <City>" but UFCStats listed it
    as "UFC Fight Night: <A> vs. <B>", so the name-based adopt in
    upsert_event_listing never matched and a second (official) row was inserted.

    The match key mirrors that adopt branch's city signal: same UTC calendar day
    + the host city (the official city appears in the provisional name, or their
    location_city values match). UFC runs at most one card per day, so day + city
    is safe; a same-day card from another city or promotion (e.g. a PFL event)
    won't match.

    Merge is deliberately CONSERVATIVE — it never destroys user data. Each
    provisional bout is MOVED onto the official event (UPDATE event_id), which
    keeps its id and every referrer (markets, bets, predictions, news links)
    intact. Two cases make a twin UNSAFE to auto-merge, and it is then SKIPPED
    (logged for manual handling) rather than risk data loss:
      - the official card already lists one of the provisional pairs AND that
        provisional bout carries a market OR a fixed-odds bet OR a parlay leg
        (deleting it would CASCADE-wipe staked coins with no refund);
      - the provisional event has its own prediction pool (prediction_event),
        whose merge into the official pool (UNIQUE(event_id), UNIQUE(user,bout),
        leaderboards) is not something to automate blindly.
    A dup provisional bout with NO bet of any kind is safe to drop (after
    repointing any news link to the official bout); no prediction_pick can
    reference it because the no-prediction-pool gate already held. Each twin runs inside its own
    SAVEPOINT so one problem pair can't roll back the others. Idempotent — a
    second run finds nothing. Returns the number of events merged.
    """
    merged = 0
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id::text, o.id::text, p.name, o.name
            FROM event p
            JOIN event o
              ON o.ufc_stats_id IS NOT NULL AND o.promotion = 'ufc' AND o.id <> p.id
             AND (o.date AT TIME ZONE 'UTC')::date = (p.date AT TIME ZONE 'UTC')::date
             AND o.location_city IS NOT NULL AND length(trim(o.location_city)) > 0
             AND (
               p.name ILIKE '%' || o.location_city || '%'
               OR lower(p.location_city) = lower(o.location_city)
             )
            WHERE p.ufc_stats_id IS NULL AND p.promotion = 'ufc'
            """
        )
        twins = cur.fetchall()

        for provisional_id, official_id, p_name, o_name in twins:
            # A prediction pool on the provisional event would need a real
            # pool-merge (out of scope for an automated scrape) — leave it.
            cur.execute(
                "SELECT 1 FROM prediction_event WHERE event_id = %s::uuid",
                (provisional_id,),
            )
            if cur.fetchone():
                log.warning(
                    f"  skip event merge {p_name!r} -> {o_name!r}: "
                    f"provisional event has a prediction pool — needs manual merge"
                )
                continue

            # Classify each provisional bout: MOVE (no twin on the official
            # card) vs DROP (official already has the pair, and the provisional
            # twin carries no market so it can be removed safely).
            cur.execute(
                "SELECT id::text, fighter_a_id::text, fighter_b_id::text "
                "FROM bout WHERE event_id = %s::uuid",
                (provisional_id,),
            )
            bouts = cur.fetchall()
            moves: list[str] = []
            drops: list[tuple[str, str]] = []  # (provisional_bout, official_bout)
            unsafe = False
            for bout_id, fa, fb in bouts:
                cur.execute(
                    """
                    SELECT id::text FROM bout
                    WHERE event_id = %s::uuid
                      AND ((fighter_a_id = %s::uuid AND fighter_b_id = %s::uuid)
                        OR (fighter_a_id = %s::uuid AND fighter_b_id = %s::uuid))
                    LIMIT 1
                    """,
                    (official_id, fa, fb, fb, fa),
                )
                official_bout = cur.fetchone()
                if official_bout is None:
                    moves.append(bout_id)
                    continue
                # A provisional twin we'd DROP must carry no user money. The
                # DROP is a hard DELETE and bout has ON DELETE CASCADE from
                # market.bet, fixed_odds_bet and parlay_leg — so deleting it
                # would silently wipe staked coins with no refund. Guard on all
                # three bet products (not just the LMSR market): if any exists,
                # the twin is unsafe to auto-merge → skip to manual handling.
                cur.execute(
                    "SELECT 1 FROM market WHERE bout_id = %s::uuid "
                    "UNION ALL "
                    "SELECT 1 FROM fixed_odds_bet WHERE bout_id = %s::uuid "
                    "UNION ALL "
                    "SELECT 1 FROM parlay_leg WHERE bout_id = %s::uuid "
                    "LIMIT 1",
                    (bout_id, bout_id, bout_id),
                )
                if cur.fetchone():
                    unsafe = True
                    break
                drops.append((bout_id, official_bout[0]))

            if unsafe:
                log.warning(
                    f"  skip event merge {p_name!r} -> {o_name!r}: a duplicate "
                    f"provisional bout carries a market or sportsbook bet "
                    f"(deleting it would wipe staked coins) — needs manual merge"
                )
                continue

            cur.execute("SAVEPOINT merge_twin")
            try:
                for prov_bout, off_bout in drops:
                    cur.execute(
                        "UPDATE news_item SET related_bout_id = %s::uuid "
                        "WHERE related_bout_id = %s::uuid",
                        (off_bout, prov_bout),
                    )
                    # Same reasoning as the cross-event twin merge in
                    # upsert_bouts: the provisional row is the earliest record
                    # that this fight was booked, so its creation mark is
                    # carried over to the surviving row before it is dropped.
                    cur.execute(
                        "SELECT created_at, weight_class::text, status::text "
                        "FROM bout WHERE id = %s::uuid",
                        (prov_bout,),
                    )
                    prov_row = cur.fetchone()
                    record_change(
                        cur,
                        bout_id=off_bout,
                        event_id=official_id,
                        kind=KIND_PROVISIONAL_MERGED,
                        source=SOURCE_UFCSTATS,
                        signature=prov_bout,
                        payload={
                            "provisional_bout_id": prov_bout,
                            "provisional_event_id": provisional_id,
                            "provisional_event_name": p_name,
                            "provisional_created_at": prov_row[0] if prov_row else None,
                            "provisional_weight_class": prov_row[1] if prov_row else None,
                            "surviving_bout_id": off_bout,
                            "official_event_name": o_name,
                            "reason": "duplicate_event_merge",
                        },
                    )
                    cur.execute(
                        "DELETE FROM bout WHERE id = %s::uuid", (prov_bout,)
                    )
                for prov_bout in moves:
                    cur.execute(
                        "UPDATE bout SET event_id = %s::uuid, updated_at = now() "
                        "WHERE id = %s::uuid",
                        (official_id, prov_bout),
                    )
                # Provisional event now has no bouts and no prediction pool.
                cur.execute(
                    "DELETE FROM event WHERE id = %s::uuid", (provisional_id,)
                )
            except Exception as exc:  # noqa: BLE001 — isolate one bad twin
                cur.execute("ROLLBACK TO SAVEPOINT merge_twin")
                cur.execute("RELEASE SAVEPOINT merge_twin")
                log.error(
                    f"  event merge {p_name!r} -> {o_name!r} failed, skipped — {exc!r}"
                )
                continue
            cur.execute("RELEASE SAVEPOINT merge_twin")
            merged += 1
            log.info(f"  merged provisional event {p_name!r} -> {o_name!r}")
    return merged


def cancel_past_scheduled_bouts(conn: psycopg.Connection) -> int:
    """Mark as 'cancelled' any bout still 'scheduled' on an event whose date is
    in the past. The card has happened; a bout with no result that the results
    scrape never filled is a scratched / pulled fight. Without this they linger
    as 'scheduled' and leak into upcoming/simulation views as phantom fights.

    Idempotent; runs each events scrape. A 1-day grace avoids touching a card
    that's mid-event. If a real result lands later, the bout upsert flips the
    status back to 'completed' (EXCLUDED.status wins), so this is reversible.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE bout SET status = 'cancelled', updated_at = now()
            WHERE status = 'scheduled'
              AND event_id IN (
                SELECT id FROM event WHERE date < CURRENT_DATE - INTERVAL '1 day'
              )
            """
        )
        return cur.rowcount or 0


def upsert_event_details(
    conn: psycopg.Connection,
    *,
    ufc_stats_id: str,
    details: EventDetails,
    dry_run: bool = False,
) -> None:
    """Refresh an event row with the details page data (location, date).

    Bouts are written by `upsert_bouts`.
    """
    if dry_run:
        log.info(
            f"[DRY] event detail refresh ufc={ufc_stats_id} location={details.location!r}"
        )
        return

    city = _location_city(details.location)
    country = map_country(details.location)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE event SET
                location_city = COALESCE(%s, location_city),
                location_country = COALESCE(%s, location_country),
                date = COALESCE(%s, date),
                updated_at = now()
            WHERE ufc_stats_id = %s
            """,
            (city, country, details.date, ufc_stats_id),
        )


def _record_removed_bouts(cur, event_id: str, seen_ids: list[str]) -> int:
    """Log every scheduled bout that is about to be DELETEd for having
    disappeared off its UFCStats event page.

    This runs immediately before the delete and is the whole reason
    bout_change_event exists. A fight coming off a card is a withdrawal, an
    injury or a scratch — the booking circumstance we have no other record of —
    and the delete that follows destroys the only evidence it was ever booked.
    Everything a later analysis could want is copied into the payload, because
    after the DELETE the bout row is not there to join to.
    """
    cur.execute(
        """
        SELECT b.id::text, b.ufc_stats_id,
               b.fighter_a_id::text, b.fighter_b_id::text,
               fa.name_en, fb.name_en,
               b.weight_class::text, b.bout_order,
               b.is_title_fight, b.is_main_event, e.date
        FROM bout b
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        LEFT JOIN event e ON e.id = b.event_id
        WHERE b.event_id = %s::uuid AND b.status = 'scheduled'
          AND b.ufc_stats_id IS NOT NULL AND NOT (b.ufc_stats_id = ANY(%s))
        """,
        (event_id, seen_ids),
    )
    doomed = cur.fetchall()
    today = datetime.now(timezone.utc).date()
    written = 0
    for (
        bout_id, ufc_id, fa_id, fb_id, fa_name, fb_name,
        weight_class, bout_order, is_title, is_main, event_date,
    ) in doomed:
        # Days of notice left on the clock when the fight came off. Negative
        # would mean the card has already happened, which the 'scheduled'
        # filter mostly rules out; kept as-is rather than clamped, since a
        # surprising value should look surprising.
        days_to_event = (event_date.date() - today).days if event_date else None
        if record_change(
            cur,
            bout_id=bout_id,
            event_id=event_id,
            kind=KIND_BOUT_REMOVED,
            source=SOURCE_UFCSTATS,
            # The bout's own id: pulled → re-added → pulled again is two real
            # events and gets two rows; one removal re-observed gets one.
            signature=ufc_id,
            payload={
                "ufc_stats_id": ufc_id,
                "fighter_a_id": fa_id,
                "fighter_b_id": fb_id,
                "fighter_a_name": fa_name,
                "fighter_b_name": fb_name,
                "weight_class": weight_class,
                "bout_order": bout_order,
                "is_title_fight": is_title,
                "is_main_event": is_main,
                "event_date": event_date,
                "days_to_event": days_to_event,
                "previous_status": "scheduled",
            },
        ):
            written += 1
            log.info(
                f"  bout removed from card: {fa_name} vs {fb_name} "
                f"(ufc={ufc_id}, {days_to_event}d out)"
            )
    return written


def _record_provisional_merges(cur, event_id: str) -> int:
    """Log the cross-event provisional twins that are about to be DELETEd in
    favour of the official row for the same pair at `event_id`.

    Predicate is identical to the DELETE that follows. The row is filed under
    the SURVIVING bout so it stays joinable, and carries the twin's created_at
    — a news-born provisional bout was created when the announcement was
    published, which is the earliest evidence of the booking anywhere in the
    database.
    """
    cur.execute(
        """
        SELECT prov.id::text, prov.event_id::text, prov.created_at,
               prov.weight_class::text, prov.status::text,
               real.id::text, real.ufc_stats_id
        FROM bout prov, bout real
        WHERE prov.ufc_stats_id IS NULL AND prov.status = 'scheduled'
          AND prov.event_id <> %s::uuid
          AND real.event_id = %s::uuid AND real.ufc_stats_id IS NOT NULL
          AND (
            (real.fighter_a_id = prov.fighter_a_id AND real.fighter_b_id = prov.fighter_b_id)
            OR (real.fighter_a_id = prov.fighter_b_id AND real.fighter_b_id = prov.fighter_a_id)
          )
        """,
        (event_id, event_id),
    )
    written = 0
    for (
        prov_id, prov_event_id, prov_created_at, prov_weight,
        real_id, real_ufc_id,
    ) in cur.fetchall():
        if record_change(
            cur,
            bout_id=real_id,
            event_id=event_id,
            kind=KIND_PROVISIONAL_MERGED,
            source=SOURCE_UFCSTATS,
            signature=prov_id,
            payload={
                "provisional_bout_id": prov_id,
                "provisional_event_id": prov_event_id,
                "provisional_created_at": prov_created_at,
                "provisional_weight_class": prov_weight,
                "surviving_bout_id": real_id,
                "surviving_ufc_stats_id": real_ufc_id,
                "reason": "cross_event_twin",
            },
        ):
            written += 1
    return written


def _existing_pairs(cur, ufc_ids: list[str]) -> dict[str, tuple[str, str, str, str, str]]:
    """Current (bout_id, fighter_a_id, fighter_b_id, name_a, name_b) for each
    already-stored ufc_stats_id, so the upsert can tell an opponent swap from
    a routine re-scrape. Read BEFORE any provisional row is adopted: adoption
    only ever matches on an identical pair, so a freshly adopted bout has no
    prior state to differ from and correctly logs nothing."""
    if not ufc_ids:
        return {}
    cur.execute(
        """
        SELECT b.ufc_stats_id, b.id::text,
               b.fighter_a_id::text, b.fighter_b_id::text,
               fa.name_en, fb.name_en
        FROM bout b
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        WHERE b.ufc_stats_id = ANY(%s)
        """,
        (ufc_ids,),
    )
    return {r[0]: (r[1], r[2], r[3], r[4], r[5]) for r in cur.fetchall()}


def _resolve_fighter_ids(conn: psycopg.Connection, ufc_ids: list[str]) -> dict[str, str]:
    if not ufc_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ufc_stats_id, id::text FROM fighter WHERE ufc_stats_id = ANY(%s)",
            (ufc_ids,),
        )
        return {ufc: fid for ufc, fid in cur.fetchall()}


def upsert_bouts(
    conn: psycopg.Connection,
    *,
    event_ufc_id: str,
    bouts: list[BoutRow],
    dry_run: bool = False,
) -> UpsertCounts:
    """Insert/update bout rows for a given event. Skips bouts whose fighters
    aren't in our `fighter` table yet (logged for manual review).
    """
    counts = UpsertCounts()
    if not bouts:
        return counts

    # Resolve event id and fighter ids in batch.
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM event WHERE ufc_stats_id = %s", (event_ufc_id,))
        row = cur.fetchone()
        if not row:
            log.warning(f"event {event_ufc_id} not in DB — cannot insert bouts")
            counts.skipped = len(bouts)
            return counts
        event_id = row[0]

    needed_fighter_ufc_ids = list({b.fighter_a_ufc_id for b in bouts} | {b.fighter_b_ufc_id for b in bouts})
    fighter_map = _resolve_fighter_ids(conn, needed_fighter_ufc_ids)

    bout_status_map = {"completed": "completed", "scheduled": "scheduled"}

    with conn.cursor() as cur:
        # Snapshot the stored matchups before anything in this pass touches
        # them — the only chance to notice that a fight-details id now lists a
        # different pair of fighters.
        prior_pairs = (
            {}
            if dry_run
            else _existing_pairs(cur, [b.ufc_stats_id for b in bouts if b.ufc_stats_id])
        )

        for b in bouts:
            f_a = fighter_map.get(b.fighter_a_ufc_id)
            f_b = fighter_map.get(b.fighter_b_ufc_id)
            if not f_a or not f_b:
                log.warning(
                    f"bout {b.ufc_stats_id}: fighter not in db "
                    f"(a={b.fighter_a_ufc_id}/{f_a is not None} "
                    f"b={b.fighter_b_ufc_id}/{f_b is not None}) — skip"
                )
                counts.skipped += 1
                continue

            if not b.weight_class:
                # Schema requires weight_class NOT NULL. Default to catchweight when unknown.
                weight_class = "catchweight"
            else:
                weight_class = b.weight_class

            winner_id = None
            if b.winner_side == "a":
                winner_id = f_a
            elif b.winner_side == "b":
                winner_id = f_b

            status = bout_status_map.get(b.status, "scheduled")

            if dry_run:
                log.info(
                    f"[DRY] bout {b.ufc_stats_id}: {b.fighter_a_name} vs {b.fighter_b_name} "
                    f"wc={weight_class} method={b.method} status={status}"
                )
                counts.inserted += 1
                continue

            # An opponent swap on the SAME fight-details id: UFCStats edited
            # the matchup in place instead of retiring the id. Compared as
            # unordered pairs — the page routinely renders the two fighters in
            # the other order, and that is a rendering detail, not a booking
            # change.
            #
            # We LOG it and deliberately DO NOT update fighter_a_id /
            # fighter_b_id on the row (which is also what the loader has always
            # done — the columns are absent from the DO UPDATE SET below, so
            # until now the swap was simply ignored in silence). Rewriting the
            # fighters would retro-fit a different matchup onto a row that
            # already carries a prediction, a market and any placed bets, and
            # the model's whole point-in-time discipline rests on rows not
            # changing their meaning after the fact. The log records what
            # happened; repairing the row is a separate, deliberate decision.
            prior = prior_pairs.get(b.ufc_stats_id)
            if prior is not None:
                prior_bout_id, prior_a, prior_b, prior_a_name, prior_b_name = prior
                old_sig = pair_signature(prior_a, prior_b)
                new_sig = pair_signature(f_a, f_b)
                if old_sig != new_sig and record_change(
                    cur,
                    bout_id=prior_bout_id,
                    event_id=event_id,
                    kind=KIND_OPPONENT_SWAPPED,
                    source=SOURCE_UFCSTATS,
                    signature=f"{old_sig}->{new_sig}",
                    payload={
                        "ufc_stats_id": b.ufc_stats_id,
                        "old_fighter_a_id": prior_a,
                        "old_fighter_b_id": prior_b,
                        "old_fighter_a_name": prior_a_name,
                        "old_fighter_b_name": prior_b_name,
                        "new_fighter_a_id": f_a,
                        "new_fighter_b_id": f_b,
                        "new_fighter_a_name": b.fighter_a_name,
                        "new_fighter_b_name": b.fighter_b_name,
                        "weight_class": weight_class,
                        "bout_order": b.bout_order,
                        "row_updated": False,
                    },
                ):
                    log.info(
                        f"  opponent swapped on ufc={b.ufc_stats_id}: "
                        f"{prior_a_name} vs {prior_b_name} -> "
                        f"{b.fighter_a_name} vs {b.fighter_b_name} "
                        f"(logged, bout row left as booked)"
                    )

            # Reconcile a news-created provisional bout (ufc_stats_id IS NULL)
            # for the same pair at this event: claim it so the upsert updates it
            # in place (keeping its id and any linked markets/predictions)
            # instead of inserting a twin. Exact event + fighter-pair match —
            # always safe (a pair fights at most once per card).
            cur.execute(
                """
                UPDATE bout SET ufc_stats_id = %s
                WHERE ufc_stats_id IS NULL AND event_id = %s::uuid
                  AND (
                    (fighter_a_id = %s::uuid AND fighter_b_id = %s::uuid)
                    OR (fighter_a_id = %s::uuid AND fighter_b_id = %s::uuid)
                  )
                """,
                (b.ufc_stats_id, event_id, f_a, f_b, f_b, f_a),
            )

            cur.execute(
                """
                INSERT INTO bout (
                    event_id, fighter_a_id, fighter_b_id,
                    weight_class, is_title_fight, is_main_event, is_co_main_event,
                    scheduled_rounds, bout_order,
                    status, winner_id, method, method_detail, round_finished, time_finished_seconds,
                    ufc_stats_id
                ) VALUES (
                    %s, %s, %s,
                    %s::weight_class, %s, %s, %s,
                    %s, %s,
                    %s::bout_status, %s, %s::bout_method, %s, %s, %s,
                    %s
                )
                ON CONFLICT (ufc_stats_id) DO UPDATE SET
                    weight_class = EXCLUDED.weight_class,
                    is_title_fight = EXCLUDED.is_title_fight,
                    is_main_event = EXCLUDED.is_main_event,
                    is_co_main_event = EXCLUDED.is_co_main_event,
                    bout_order = EXCLUDED.bout_order,
                    -- Refresh scheduled_rounds so a provisional bout the news
                    -- pipeline created at the default 3 is corrected to the
                    -- real 5 (title/main event) on official adoption. GREATEST
                    -- so a re-scrape never downgrades a curated title co-main
                    -- (set to 5 by derive_title_fights, but bout_order != 1)
                    -- back to 3.
                    scheduled_rounds = GREATEST(EXCLUDED.scheduled_rounds, bout.scheduled_rounds),
                    -- A completed bout must never be demoted back to
                    -- 'scheduled' by a re-scrape: a degraded parse (layout
                    -- change, transient page) yields no method/winner/round
                    -- and would otherwise flip the row to 'scheduled' —
                    -- where the reconcile pass below is then allowed to
                    -- DELETE it. Results only ever move forward.
                    status = CASE
                        WHEN bout.status = 'completed' AND EXCLUDED.status = 'scheduled'
                        THEN bout.status
                        ELSE EXCLUDED.status
                    END,
                    winner_id = COALESCE(EXCLUDED.winner_id, bout.winner_id),
                    method = COALESCE(EXCLUDED.method, bout.method),
                    -- Wave 16: always refresh method_detail from the
                    -- scrape so a future fix to map_method can iterate
                    -- from the raw text without needing a re-scrape.
                    method_detail = COALESCE(EXCLUDED.method_detail, bout.method_detail),
                    round_finished = COALESCE(EXCLUDED.round_finished, bout.round_finished),
                    time_finished_seconds = COALESCE(EXCLUDED.time_finished_seconds, bout.time_finished_seconds),
                    updated_at = now()
                RETURNING (xmax = 0) AS inserted
                """,
                (
                    event_id,
                    f_a,
                    f_b,
                    weight_class,
                    b.is_title_bout,
                    b.bout_order == 1,
                    b.bout_order == 2,
                    5 if b.bout_order == 1 else 3,
                    b.bout_order,
                    status,
                    winner_id,
                    b.method,
                    b.method_detail,
                    b.round_finished,
                    b.time_finished_seconds,
                    b.ufc_stats_id,
                ),
            )
            row = cur.fetchone()
            if row and row[0]:
                counts.inserted += 1
            else:
                counts.updated += 1

        # --- Reconcile this card against the page (the UFCStats event page is
        # authoritative for which fights are on it). Only when we actually
        # parsed bouts, so a transient empty parse can't nuke a card.
        if not dry_run and bouts:
            seen_ids = [b.ufc_stats_id for b in bouts if b.ufc_stats_id]
            if seen_ids:
                # (B) A real SCHEDULED bout no longer on the page = opponent
                # swap / fight moved off this card. Drop it so it doesn't linger
                # with a stale date. Never touches completed or provisional bouts.
                #
                # RECORD IT FIRST. The DELETE below is the single most
                # informative thing the scraper does and, until this call
                # existed, the least recoverable: a fight coming off a card is
                # the withdrawal signal, and deleting the row erased the fact
                # that the booking had ever been made.
                _record_removed_bouts(cur, event_id, seen_ids)
                cur.execute(
                    """
                    UPDATE news_item SET related_bout_id = NULL
                    WHERE related_bout_id IN (
                        SELECT id FROM bout
                        WHERE event_id = %s::uuid AND status = 'scheduled'
                          AND ufc_stats_id IS NOT NULL AND NOT (ufc_stats_id = ANY(%s))
                    )
                    """,
                    (event_id, seen_ids),
                )
                cur.execute(
                    """
                    DELETE FROM bout
                    WHERE event_id = %s::uuid AND status = 'scheduled'
                      AND ufc_stats_id IS NOT NULL AND NOT (ufc_stats_id = ANY(%s))
                    """,
                    (event_id, seen_ids),
                )
            # (A) News may have mis-dated one of these fights onto ANOTHER card
            # as a provisional bout (ufc_stats_id NULL). Now that UFCStats places
            # it here, repoint that news link to this real bout, then drop the
            # cross-event provisional twin. (The same-event twin is already
            # claimed in-place by the UPDATE above the INSERT.)
            cur.execute(
                """
                UPDATE news_item ni SET related_bout_id = real.id
                FROM bout prov, bout real
                WHERE ni.related_bout_id = prov.id
                  AND prov.ufc_stats_id IS NULL AND prov.status = 'scheduled'
                  AND prov.event_id <> %s::uuid
                  AND real.event_id = %s::uuid AND real.ufc_stats_id IS NOT NULL
                  AND (
                    (real.fighter_a_id = prov.fighter_a_id AND real.fighter_b_id = prov.fighter_b_id)
                    OR (real.fighter_a_id = prov.fighter_b_id AND real.fighter_b_id = prov.fighter_a_id)
                  )
                """,
                (event_id, event_id),
            )
            # Record the merge against the SURVIVING row before the twin goes.
            # The provisional row was born from a news announcement, so its
            # created_at is the earliest mark we have of this fight existing —
            # older than anything the UFCStats scrape can offer. Deleting it
            # unrecorded throws that away.
            _record_provisional_merges(cur, event_id)
            cur.execute(
                """
                DELETE FROM bout prov USING bout real
                WHERE prov.ufc_stats_id IS NULL AND prov.status = 'scheduled'
                  AND prov.event_id <> %s::uuid
                  AND real.event_id = %s::uuid AND real.ufc_stats_id IS NOT NULL
                  AND (
                    (real.fighter_a_id = prov.fighter_a_id AND real.fighter_b_id = prov.fighter_b_id)
                    OR (real.fighter_a_id = prov.fighter_b_id AND real.fighter_b_id = prov.fighter_a_id)
                  )
                """,
                (event_id, event_id),
            )

    return counts


@dataclass
class UntranslatedEvent:
    id: str
    name: str


def fetch_untranslated_events(
    conn: psycopg.Connection, limit: int | None = None
) -> list[UntranslatedEvent]:
    """Events still missing a Russian name, newest first."""
    sql = (
        "SELECT id::text, name FROM event "
        "WHERE name_ru IS NULL ORDER BY date DESC NULLS LAST"
    )
    params: tuple = ()
    if limit is not None:
        sql += " LIMIT %s"
        params = (limit,)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [UntranslatedEvent(id=r[0], name=r[1]) for r in cur.fetchall()]


def save_event_name_ru(
    conn: psycopg.Connection, event_id: str, name_ru: str
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE event SET name_ru = %s WHERE id = %s::uuid",
            (name_ru, event_id),
        )
