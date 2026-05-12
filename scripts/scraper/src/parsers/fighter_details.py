from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from selectolax.parser import HTMLParser

from ..utils.dates import parse_birthdate
from ..utils.measures import (
    parse_float,
    parse_height_to_cm,
    parse_percent,
    parse_reach_to_cm,
)
from ..utils.stance import map_stance

_RECORD_RE = re.compile(r"Record:\s*(\d+)\s*-\s*(\d+)\s*-\s*(\d+)")


@dataclass
class FighterDetailStats:
    slpm: float | None = None
    str_acc: float | None = None
    sapm: float | None = None
    str_def: float | None = None
    td_avg: float | None = None
    td_acc: float | None = None
    td_def: float | None = None
    sub_avg: float | None = None


@dataclass
class FighterDetails:
    name_en: str
    nickname: str | None
    height_cm: int | None
    reach_cm: int | None
    stance: str
    dob: date | None
    wins: int | None
    losses: int | None
    draws: int | None
    stats: FighterDetailStats = field(default_factory=FighterDetailStats)


def _li_value(label: str, lis: list) -> str | None:
    needle = label.rstrip(":").lower()
    for li in lis:
        title = li.css_first("i.b-list__box-item-title")
        if title is None:
            continue
        if title.text(strip=True).rstrip(":").lower() != needle:
            continue
        full = li.text(strip=True)
        prefix = title.text(strip=True)
        if full.startswith(prefix):
            return full[len(prefix):].strip()
        return full.strip()
    return None


def parse_fighter_details(html: str) -> FighterDetails:
    tree = HTMLParser(html)

    name_node = tree.css_first("span.b-content__title-highlight")
    name_en = name_node.text(strip=True) if name_node else ""

    record_node = tree.css_first("span.b-content__title-record")
    record_text = record_node.text(strip=True) if record_node else ""
    wins = losses = draws = None
    rm = _RECORD_RE.search(record_text)
    if rm:
        wins, losses, draws = int(rm.group(1)), int(rm.group(2)), int(rm.group(3))

    nickname_node = tree.css_first("p.b-content__Nickname")
    nickname_raw = nickname_node.text(strip=True) if nickname_node else ""
    nickname = nickname_raw or None

    bio_lis = tree.css(
        "div.b-list__info-box_style_small-width li.b-list__box-list-item, "
        "div.b-list__info-box_style_small-width li.b-list__box-list-item.b-list__box-list-item_type_block"
    )
    # The biometric box has Height/Weight/Reach/STANCE/DOB.
    height_cm = parse_height_to_cm(_li_value("Height", bio_lis))
    reach_cm = parse_reach_to_cm(_li_value("Reach", bio_lis))
    stance = map_stance(_li_value("STANCE", bio_lis))
    dob = parse_birthdate(_li_value("DOB", bio_lis))

    # Career stats box.
    stat_lis = tree.css(
        "div.b-list__info-box-left li.b-list__box-list-item, "
        "div.b-list__info-box_style_middle-width li.b-list__box-list-item"
    )
    stats = FighterDetailStats(
        slpm=parse_float(_li_value("SLpM", stat_lis)),
        str_acc=parse_percent(_li_value("Str. Acc.", stat_lis)),
        sapm=parse_float(_li_value("SApM", stat_lis)),
        str_def=parse_percent(_li_value("Str. Def", stat_lis)),
        td_avg=parse_float(_li_value("TD Avg.", stat_lis)),
        td_acc=parse_percent(_li_value("TD Acc.", stat_lis)),
        td_def=parse_percent(_li_value("TD Def.", stat_lis)),
        sub_avg=parse_float(_li_value("Sub. Avg.", stat_lis)),
    )

    return FighterDetails(
        name_en=name_en,
        nickname=nickname,
        height_cm=height_cm,
        reach_cm=reach_cm,
        stance=stance,
        dob=dob,
        wins=wins,
        losses=losses,
        draws=draws,
        stats=stats,
    )
