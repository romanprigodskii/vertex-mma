from __future__ import annotations

import re

WEIGHT_CLASS_MAP: dict[str, str] = {
    "Strawweight": "strawweight",
    "Women's Strawweight": "strawweight",
    "Flyweight": "flyweight",
    "Women's Flyweight": "flyweight",
    "Bantamweight": "bantamweight",
    "Women's Bantamweight": "bantamweight",
    "Featherweight": "featherweight",
    "Women's Featherweight": "featherweight",
    "Lightweight": "lightweight",
    "Welterweight": "welterweight",
    "Middleweight": "middleweight",
    "Light Heavyweight": "light_heavyweight",
    "Heavyweight": "heavyweight",
    "Catch Weight": "catchweight",
    "Open Weight": "openweight",
}


def map_weight_class(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()
    # UFCStats sometimes appends "Title Bout" or includes belt note inline.
    cleaned = cleaned.replace("Title Bout", "").strip()
    return WEIGHT_CLASS_MAP.get(cleaned)


# Images UFCStats renders in the weight-class cell. Only the first is a belt;
# the rest are POST-FIGHT bonus awards, and they share the cell.
BELT_IMAGE_MARKER = "belt"
BONUS_IMAGE_MARKERS = ("perf", "fight", "ko", "sub")


def is_belt_image(src: str | None) -> bool:
    """True only for the championship belt icon.

    The weight-class cell on an event page carries the belt icon AND the
    Performance/Fight of the Night bonus icons. Treating "an image is
    present" as "this is a title fight" set the flag on ~30 % of completed
    bouts against a real rate near 5 %, including 1,855 three-round bouts —
    a title fight is five rounds, always. Because bonuses go to finishes, the
    corrupted flag also leaked the outcome into anything that consumed it;
    see scripts/simulation/docs/method_leg.md.

    Matching on the filename rather than excluding known bonus names is
    deliberate: a bonus icon UFCStats adds later must not silently become a
    belt."""
    if not src:
        return False
    return BELT_IMAGE_MARKER in src.rsplit("/", 1)[-1].lower()


def is_title_bout(weight_class_text: str | None, has_belt_img: bool) -> bool:
    """`has_belt_img` must come from `is_belt_image`, not from "any <img>"."""
    if has_belt_img:
        return True
    if not weight_class_text:
        return False
    return "Title" in weight_class_text
