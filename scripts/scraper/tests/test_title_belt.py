"""Pin that a bonus icon is never read as a championship belt.

UFCStats renders the belt icon and the POST-FIGHT bonus icons (Performance
of the Night, Fight of the Night) in the same weight-class cell. The parser
used to treat "an image is present" as "this is a title fight", which set
`bout.is_title_fight` on ~30 % of completed bouts against a real title rate
near 5 % — including 1,855 three-round "title fights", and a title fight is
five rounds, always.

That is not merely wrong, it leaks the outcome: bonuses go to finishes, so
among three-round bouts the flag marked an 84.1 % finish rate against 41.3 %
unflagged. Anything trained on the column inherited the leak, and unfought
bouts carry no bonus icon, so the flag also meant something different at
serve time than it did in training. Found by the method-leg lab, which had
made it its largest feature by gain
(scripts/simulation/docs/method_leg.md §7).

The regression is invisible from any scrape-level check — the flag stays a
plausible boolean — so it is pinned here.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/tests/test_title_belt.py
"""
from __future__ import annotations

import sys
from pathlib import Path

_SCRAPER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_SCRAPER_ROOT))

from src.parsers.event_details import parse_event_details  # noqa: E402
from src.utils.weight_classes import is_belt_image, is_title_bout  # noqa: E402

BELT = "http://1e49bc5171d173577ecd-1323f4090557a33db01577564f60846c.r80.cf1.rackcdn.com/belt.png"
PERF = "http://1e49bc5171d173577ecd-1323f4090557a33db01577564f60846c.r80.cf1.rackcdn.com/perf.png"
FOTN = "http://1e49bc5171d173577ecd-1323f4090557a33db01577564f60846c.r80.cf1.rackcdn.com/fight.png"


def test_is_belt_image() -> None:
    assert is_belt_image(BELT)
    assert is_belt_image("/img/belt.png")
    for bonus in (PERF, FOTN, "/img/perf.png", "/img/ko.png", "/img/sub.png"):
        assert not is_belt_image(bonus), bonus
    assert not is_belt_image(None)
    assert not is_belt_image("")
    print("ok   only the belt filename reads as a belt")


def test_is_title_bout_still_reads_the_text() -> None:
    # The text path is the fallback for pages that label the bout inline.
    assert is_title_bout("UFC Lightweight Title Bout", False)
    assert not is_title_bout("Lightweight", False)
    assert is_title_bout("Lightweight", True)
    print("ok   the weight-class text fallback is unchanged")


def _row(*img_srcs: str) -> str:
    imgs = "".join(f'<img src="{s}">' for s in img_srcs)
    return f"""
    <tr class="b-fight-details__table-row js-fight-details-click"
        data-link="http://ufcstats.com/fight-details/aaaaaaaaaaaaaaaa">
      <td class="b-fight-details__table-col"><p class="b-fight-details__table-text">win</p></td>
      <td class="b-fight-details__table-col">
        <a class="b-link b-link_style_black" href="/fighter-details/1111111111111111">A Fighter</a>
        <a class="b-link b-link_style_black" href="/fighter-details/2222222222222222">B Fighter</a>
      </td>
      <td class="b-fight-details__table-col"></td>
      <td class="b-fight-details__table-col"></td>
      <td class="b-fight-details__table-col"></td>
      <td class="b-fight-details__table-col"></td>
      <td class="b-fight-details__table-col">Lightweight{imgs}</td>
      <td class="b-fight-details__table-col"><p class="b-fight-details__table-text">KO/TKO</p></td>
      <td class="b-fight-details__table-col"><p class="b-fight-details__table-text">2</p></td>
      <td class="b-fight-details__table-col"><p class="b-fight-details__table-text">3:21</p></td>
    </tr>
    """


def _parse_one(*img_srcs: str):
    html = f"""<html><body>
      <span class="b-content__title-highlight">UFC Test Event</span>
      <table>{_row(*img_srcs)}</table>
    </body></html>"""
    details = parse_event_details(html)
    assert len(details.bouts) == 1, details.bouts
    return details.bouts[0]


def test_parser_separates_belt_from_bonus() -> None:
    assert _parse_one().is_title_bout is False
    assert _parse_one(PERF).is_title_bout is False, "Performance of the Night is not a belt"
    assert _parse_one(FOTN).is_title_bout is False, "Fight of the Night is not a belt"
    assert _parse_one(PERF, FOTN).is_title_bout is False, "two bonuses are still not a belt"
    assert _parse_one(BELT).is_title_bout is True
    assert _parse_one(PERF, BELT).is_title_bout is True, "a belt beside a bonus is still a belt"
    print("ok   a bonus icon never becomes a title fight, a belt always does")


def main() -> int:
    test_is_belt_image()
    test_is_title_bout_still_reads_the_text()
    test_parser_separates_belt_from_bonus()
    print("\nall title-belt checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
