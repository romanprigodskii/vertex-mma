from __future__ import annotations

import re
from dataclasses import dataclass

from selectolax.parser import HTMLParser

from ..utils.measures import parse_height_to_cm, parse_int, parse_reach_to_cm
from ..utils.stance import map_stance

_FIGHTER_ID_RE = re.compile(r"/fighter-details/([a-z0-9]+)")


@dataclass
class FighterListItem:
    ufc_stats_id: str
    name_en: str
    nickname: str | None
    height_cm: int | None
    reach_cm: int | None
    stance: str
    wins: int | None
    losses: int | None
    draws: int | None
    is_champion: bool


def parse_fighters_listing(html: str) -> list[FighterListItem]:
    tree = HTMLParser(html)
    items: list[FighterListItem] = []

    # Pages have one big table; rows with data have 11 td cells.
    for row in tree.css("tr.b-statistics__table-row"):
        cells = row.css("td.b-statistics__table-col, td.b-statistics__table-col_type_small")
        if len(cells) < 11:
            continue

        first_link = cells[0].css_first("a")
        if first_link is None:
            continue
        href = first_link.attributes.get("href") or ""
        m = _FIGHTER_ID_RE.search(href)
        if not m:
            continue
        ufc_stats_id = m.group(1)

        first_name = first_link.text(strip=True)
        last_link = cells[1].css_first("a")
        last_name = last_link.text(strip=True) if last_link is not None else ""
        name_en = " ".join(part for part in (first_name, last_name) if part).strip()
        if not name_en:
            continue

        nickname_link = cells[2].css_first("a")
        nickname = nickname_link.text(strip=True) if nickname_link is not None else ""
        nickname = nickname or None

        ht_text = cells[3].text(strip=True)
        # cells[4] is weight, ignored — we use weight class instead.
        reach_text = cells[5].text(strip=True)
        stance_text = cells[6].text(strip=True)

        wins = parse_int(cells[7].text(strip=True))
        losses = parse_int(cells[8].text(strip=True))
        draws = parse_int(cells[9].text(strip=True))

        is_champion = cells[10].css_first("img") is not None

        items.append(
            FighterListItem(
                ufc_stats_id=ufc_stats_id,
                name_en=name_en,
                nickname=nickname,
                height_cm=parse_height_to_cm(ht_text),
                reach_cm=parse_reach_to_cm(reach_text),
                stance=map_stance(stance_text),
                wins=wins,
                losses=losses,
                draws=draws,
                is_champion=is_champion,
            )
        )

    return items
