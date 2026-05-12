from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from selectolax.parser import HTMLParser

from ..utils.dates import parse_event_date

_EVENT_ID_RE = re.compile(r"/event-details/([a-z0-9]+)")


@dataclass
class EventListItem:
    ufc_stats_id: str
    detail_url: str
    name: str
    date: datetime | None
    location: str | None


def parse_events_listing(html: str) -> list[EventListItem]:
    """Parse `/statistics/events/completed?page=all` or the `upcoming` variant.

    Skips header rows and empty separator rows.
    """
    tree = HTMLParser(html)
    items: list[EventListItem] = []

    table = tree.css_first("table.b-statistics__table-events")
    if table is None:
        return items

    for row in table.css("tr.b-statistics__table-row"):
        link = row.css_first("a.b-link.b-link_style_black")
        if link is None:
            continue
        href = link.attributes.get("href") or ""
        m = _EVENT_ID_RE.search(href)
        if not m:
            continue
        ufc_stats_id = m.group(1)
        name = (link.text() or "").strip()

        date_node = row.css_first("span.b-statistics__date")
        date_text = (date_node.text() if date_node else "").strip()
        date = parse_event_date(date_text)

        cells = row.css("td.b-statistics__table-col, td.b-statistics__table-col_style_big-top-padding")
        # Last visible td is the location.
        location = None
        for cell in reversed(cells):
            text = (cell.text() or "").strip()
            if text and text != name and text != date_text:
                location = " ".join(text.split())
                break

        items.append(
            EventListItem(
                ufc_stats_id=ufc_stats_id,
                detail_url=href,
                name=name,
                date=date,
                location=location,
            )
        )

    return items
