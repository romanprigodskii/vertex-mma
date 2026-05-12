from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

from selectolax.parser import HTMLParser, Node

from ..utils.dates import parse_event_date, parse_round_time
from ..utils.methods import map_method
from ..utils.weight_classes import is_title_bout, map_weight_class

_FIGHT_ID_RE = re.compile(r"/fight-details/([a-z0-9]+)")
_FIGHTER_ID_RE = re.compile(r"/fighter-details/([a-z0-9]+)")


@dataclass
class BoutRow:
    ufc_stats_id: str
    bout_order: int
    fighter_a_ufc_id: str
    fighter_a_name: str
    fighter_b_ufc_id: str
    fighter_b_name: str
    winner_side: str | None  # 'a', 'b', None (draw/nc)
    weight_class: str | None
    method: str | None
    is_title_bout: bool
    round_finished: int | None
    time_finished_seconds: int | None
    status: str  # 'completed' | 'scheduled'


@dataclass
class EventDetails:
    name: str
    date: datetime | None
    location: str | None
    bouts: list[BoutRow] = field(default_factory=list)


def _cell_two_lines(cell: Node) -> tuple[str, str]:
    paragraphs = cell.css("p.b-fight-details__table-text")
    if len(paragraphs) >= 2:
        return paragraphs[0].text(strip=True), paragraphs[1].text(strip=True)
    if len(paragraphs) == 1:
        only = paragraphs[0].text(strip=True)
        return only, ""
    return "", ""


def _result_side(row: Node) -> str | None:
    """Return 'a', 'b', or None based on the win/loss flag on the row.

    UFCStats puts a single `<a class="b-flag b-flag_style_green">` on the row when
    fighter A won. For draws and NCs it shows the grey flag style and there is no
    winner. For a loss on the first fighter, no flag is rendered at all — the row
    still implies fighter A is listed first / fighter B is the winner. UFCStats
    doesn't actually swap, so we treat absence-of-green as "no recorded winner here"
    and fall back to inspecting the flag text.
    """
    flag = row.css_first("a.b-flag.b-flag_style_green i.b-flag__text")
    if flag is not None:
        text = (flag.text() or "").strip().lower()
        if text.startswith("win"):
            return "a"
    # Grey flag → draw / NC.
    grey = row.css_first("a.b-flag.b-flag_style_grey i.b-flag__text")
    if grey is not None:
        return None
    # Row without a green flag in the W/L column = no win recorded (upcoming or N/A).
    return None


def parse_event_details(html: str) -> EventDetails:
    tree = HTMLParser(html)

    name_node = tree.css_first("span.b-content__title-highlight")
    name = (name_node.text(strip=True) if name_node else "").strip()

    date: datetime | None = None
    location: str | None = None
    for li in tree.css("li.b-list__box-list-item"):
        title_node = li.css_first("i.b-list__box-item-title")
        if title_node is None:
            continue
        label = (title_node.text() or "").strip().rstrip(":").lower()
        # Strip the label out of the li text to get the value.
        full = li.text(strip=True)
        value = full[len(title_node.text(strip=True)) :].strip() if full.startswith(title_node.text(strip=True)) else full
        if label == "date":
            date = parse_event_date(value)
        elif label == "location":
            location = value

    bouts: list[BoutRow] = []
    rows = tree.css("tr.b-fight-details__table-row.js-fight-details-click")
    for idx, row in enumerate(rows, start=1):
        data_link = row.attributes.get("data-link") or ""
        m = _FIGHT_ID_RE.search(data_link)
        if not m:
            continue
        ufc_stats_id = m.group(1)

        cells = row.css("td.b-fight-details__table-col")
        if len(cells) < 10:
            continue

        # Fighters cell (index 1).
        fighter_links = cells[1].css("a.b-link.b-link_style_black")
        if len(fighter_links) < 2:
            continue
        f_a_href = fighter_links[0].attributes.get("href") or ""
        f_b_href = fighter_links[1].attributes.get("href") or ""
        f_a_id_m = _FIGHTER_ID_RE.search(f_a_href)
        f_b_id_m = _FIGHTER_ID_RE.search(f_b_href)
        if not f_a_id_m or not f_b_id_m:
            continue
        f_a_id = f_a_id_m.group(1)
        f_b_id = f_b_id_m.group(1)
        f_a_name = fighter_links[0].text(strip=True)
        f_b_name = fighter_links[1].text(strip=True)

        winner_side = _result_side(row)

        # Weight class + title belt (index 6).
        wc_text = cells[6].text(strip=True)
        has_belt = cells[6].css_first("img") is not None
        weight_class = map_weight_class(wc_text)
        title = is_title_bout(wc_text, has_belt)

        # Method (index 7).
        method_text = cells[7].text(strip=True)
        method = map_method(method_text)

        # Round (index 8), Time (index 9).
        round_text = cells[8].text(strip=True)
        time_text = cells[9].text(strip=True)
        try:
            round_finished = int(round_text) if round_text and round_text != "--" else None
        except ValueError:
            round_finished = None
        time_finished_seconds = parse_round_time(time_text)

        # Status: if we have a method or a winner, it's completed; otherwise scheduled.
        status = "completed" if (method or winner_side or round_finished or time_finished_seconds) else "scheduled"

        bouts.append(
            BoutRow(
                ufc_stats_id=ufc_stats_id,
                bout_order=idx,
                fighter_a_ufc_id=f_a_id,
                fighter_a_name=f_a_name,
                fighter_b_ufc_id=f_b_id,
                fighter_b_name=f_b_name,
                winner_side=winner_side,
                weight_class=weight_class,
                method=method,
                is_title_bout=title,
                round_finished=round_finished,
                time_finished_seconds=time_finished_seconds,
                status=status,
            )
        )

    return EventDetails(name=name, date=date, location=location, bouts=bouts)
