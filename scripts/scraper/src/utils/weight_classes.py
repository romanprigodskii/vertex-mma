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


def is_title_bout(weight_class_text: str | None, has_belt_img: bool) -> bool:
    if has_belt_img:
        return True
    if not weight_class_text:
        return False
    return "Title" in weight_class_text
