"""Fetch official UFC athlete cutouts and composite them onto a site-themed
background. UFC athlete pages serve transparent-background PNGs (a head+shoulders
`event_results_athlete_headshot` and a full-body `athlete_bio_full_body`), which
makes background compositing clean. These are UFC promotional images — used here
under an editorial/fan-site decision, not a free license; attribution is stored."""
from __future__ import annotations

import io
import re
import unicodedata
from dataclasses import dataclass

import httpx
from PIL import Image, ImageOps

from .config import FULL_MAX_SIZE, REQUEST_TIMEOUT, THUMBNAIL_SIZE, USER_AGENT

UFC_ATHLETE_URL = "https://www.ufc.com/athlete/{slug}"
# Preference: the full-body cutout is the highest-res transparent variant UFC
# serves publicly (~460x700); the headshot style is only ~256x160, so it's just
# a fallback. Originals (no /styles/ segment) are 403-blocked.
_IMG_STYLES = ("athlete_bio_full_body", "event_results_athlete_headshot")


def ufc_slug(name_en: str) -> str:
    """Carlos Ulberg → carlos-ulberg; José Aldo → jose-aldo."""
    s = unicodedata.normalize("NFKD", name_en)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("'", "").replace("'", "").replace(".", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def _client() -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=REQUEST_TIMEOUT,
    )


def _find_image_url(html: str) -> str | None:
    for style in _IMG_STYLES:
        m = re.search(rf'https://[^"\s]*{style}[^"\s]*\.png[^"\s]*', html)
        if m:
            return m.group(0).replace("&amp;", "&")
    m = re.search(r'property="og:image"[^>]+content="([^"]+\.(?:png|jpg))', html)
    return m.group(1).replace("&amp;", "&") if m else None


@dataclass
class UfcImage:
    raw: bytes
    page_url: str


def fetch_ufc_image(name_en: str) -> tuple[UfcImage | None, str]:
    """Returns (UfcImage, reason). On failure UfcImage is None and reason says why."""
    slug = ufc_slug(name_en)
    page_url = UFC_ATHLETE_URL.format(slug=slug)
    with _client() as c:
        r = c.get(page_url)
        if r.status_code == 404:
            return None, "page_404"
        if r.status_code != 200:
            return None, f"page_http_{r.status_code}"
        img_url = _find_image_url(r.text)
        if not img_url:
            return None, "no_image_on_page"
        ir = c.get(img_url)
        if ir.status_code != 200:
            return None, f"image_http_{ir.status_code}"
        if not ir.headers.get("content-type", "").startswith("image/"):
            return None, "image_not_image"
        return UfcImage(raw=ir.content, page_url=page_url), "ok"


@dataclass
class ProcessedImage:
    full_webp: bytes
    thumbnail_webp: bytes


def _head_crop(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Square crop of head+shoulders for the avatar, from the top of the alpha
    silhouette, centered on the figure. Keeps transparency."""
    alpha = img.split()[-1]
    bbox = alpha.getbbox()
    if bbox is None:
        return ImageOps.fit(img, size, Image.Resampling.LANCZOS, centering=(0.5, 0.3))
    left, top, right, _bottom = bbox
    w = right - left
    cx = (left + right) // 2
    side = max(1, w)  # square as wide as the figure → head + shoulders
    x0 = cx - side // 2
    # Crop beyond image bounds is padded transparent by PIL, which is fine.
    crop = img.crop((x0, top, x0 + side, top + side))
    return crop.resize(size, Image.Resampling.LANCZOS)


def process_cutout(raw: bytes) -> ProcessedImage:
    """Keep the UFC cutout transparent (no background). Emit a native-res full
    image (never upscaled past the source) and a head+shoulders square avatar,
    both WebP with alpha preserved."""
    src = Image.open(io.BytesIO(raw))
    src = ImageOps.exif_transpose(src)
    if src.mode != "RGBA":
        src = src.convert("RGBA")

    full = src.copy()
    full.thumbnail(FULL_MAX_SIZE, Image.Resampling.LANCZOS)  # shrink-only

    thumb = _head_crop(src, THUMBNAIL_SIZE)

    fb, tb = io.BytesIO(), io.BytesIO()
    full.save(fb, format="WEBP", quality=92, method=6)
    thumb.save(tb, format="WEBP", quality=92, method=6)
    return ProcessedImage(full_webp=fb.getvalue(), thumbnail_webp=tb.getvalue())
