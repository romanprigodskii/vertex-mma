"""Discover bestfightodds event URLs by spidering fighter pages.

Direct /events/<id> URLs redirect to homepage — you can't fetch an
event without its full slug. The cheapest way to enumerate all event
slugs is to:

  1. Search bestfightodds for our DB's top UFC fighters (covers most
     of the bout history because they share opponents).
  2. Each fighter page lists every event they fought on, with full slug.
  3. Dedupe across fighters → a complete set of /events/<slug>-<id> URLs.

For a typical "top 300 fighters by UFC bouts" seed, the discovery
phase converges to ~700-800 unique UFC events (very close to the full
UFC history)."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import quote_plus

from bs4 import BeautifulSoup
from rich.console import Console

from .http import RateLimitedClient

console = Console()

# Only fetch UFC event pages — bestfightodds covers every promotion
# (Bellator, ONE, PFL, regional MMA…), most of which we don't need.
UFC_SLUG_RE = re.compile(r"^ufc[-/]", re.IGNORECASE)
EVENT_HREF_RE = re.compile(r"^/events/([a-z0-9-]+?)-(\d+)$", re.IGNORECASE)
FIGHTER_HREF_RE = re.compile(r"^/fighters/([A-Za-z0-9-]+?)-(\d+)$")


@dataclass
class BfoFighter:
    bfo_slug: str
    bfo_id: int
    name: str


@dataclass
class BfoEvent:
    bfo_slug: str
    bfo_id: int
    url: str  # always /events/<slug>-<id>


def search_fighter(client: RateLimitedClient, query: str) -> BfoFighter | None:
    """First search hit. bestfightodds search ranks by relevance; the
    canonical fighter is almost always #1 when the name is unambiguous."""
    resp = client.get(f"/search?query={quote_plus(query)}")
    if resp.status_code != 200:
        return None
    soup = BeautifulSoup(resp.text, "html.parser")
    # bestfightodds rewrites to the canonical fighter page when there's
    # only one match — handle both the redirected-page case (a link to
    # the same fighter in the breadcrumb) and the proper SERP.
    for a in soup.select("a[href^='/fighters/']"):
        href = a.get("href", "")
        m = FIGHTER_HREF_RE.match(href)
        if m:
            slug = m.group(1)
            try:
                fid = int(m.group(2))
            except ValueError:
                continue
            # Skip nav links to "popular fighters" sidebars when search
            # returned a redirect — those tend to live in elements that
            # don't have a name text content matching the query.
            text = a.get_text(strip=True)
            if not text:
                continue
            return BfoFighter(bfo_slug=slug, bfo_id=fid, name=text)
    return None


def fetch_events_on_fighter_page(
    client: RateLimitedClient, fighter: BfoFighter, *, ufc_only: bool = True
) -> list[BfoEvent]:
    """Pull all /events/<slug>-<id> links off this fighter's page."""
    resp = client.get(f"/fighters/{fighter.bfo_slug}-{fighter.bfo_id}")
    if resp.status_code != 200:
        return []
    soup = BeautifulSoup(resp.text, "html.parser")
    out: list[BfoEvent] = []
    seen: set[int] = set()
    for a in soup.select("a[href^='/events/']"):
        href = a.get("href", "")
        m = EVENT_HREF_RE.match(href)
        if not m:
            continue
        slug = m.group(1)
        try:
            eid = int(m.group(2))
        except ValueError:
            continue
        if ufc_only and not UFC_SLUG_RE.match(slug):
            continue
        if eid in seen:
            continue
        seen.add(eid)
        out.append(BfoEvent(bfo_slug=slug, bfo_id=eid, url=f"/events/{slug}-{eid}"))
    return out


def discover_events(
    client: RateLimitedClient,
    fighter_names: Iterable[str],
    *,
    log_every: int = 25,
) -> list[BfoEvent]:
    """Resolve each fighter name to a BFO page, then accumulate event
    URLs across all of them. Return one BfoEvent per unique event."""
    events: dict[int, BfoEvent] = {}
    miss = 0
    for i, name in enumerate(fighter_names, start=1):
        fighter = search_fighter(client, name)
        if fighter is None:
            miss += 1
            continue
        for ev in fetch_events_on_fighter_page(client, fighter):
            events.setdefault(ev.bfo_id, ev)
        if i % log_every == 0:
            console.log(
                f"discovery {i:,} fighters · {len(events):,} unique events · "
                f"{miss:,} unresolved"
            )
    return list(events.values())
