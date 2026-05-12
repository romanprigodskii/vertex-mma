from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, ImageOps

from .config import FULL_MAX_SIZE, THUMBNAIL_SIZE


@dataclass
class ProcessedImage:
    full_webp: bytes
    thumbnail_webp: bytes


def process(raw: bytes) -> ProcessedImage:
    """Decode `raw`, produce a centered square thumbnail and a max-bounded full image, both as WebP."""
    src = Image.open(io.BytesIO(raw))
    src = ImageOps.exif_transpose(src)
    if src.mode not in ("RGB", "RGBA"):
        src = src.convert("RGBA" if "A" in src.mode else "RGB")
    if src.mode == "RGBA":
        # Composite onto white for thumbnail/full (WebP keeps alpha but jpg-source rarely needs it).
        bg = Image.new("RGB", src.size, (255, 255, 255))
        bg.paste(src, mask=src.split()[-1])
        src = bg

    # Full: fit within FULL_MAX_SIZE preserving aspect ratio.
    full = src.copy()
    full.thumbnail(FULL_MAX_SIZE, Image.Resampling.LANCZOS)

    # Thumbnail: center-crop to square, then downscale.
    thumb = ImageOps.fit(src, THUMBNAIL_SIZE, Image.Resampling.LANCZOS, centering=(0.5, 0.4))

    full_buf = io.BytesIO()
    full.save(full_buf, format="WEBP", quality=85, method=6)

    thumb_buf = io.BytesIO()
    thumb.save(thumb_buf, format="WEBP", quality=85, method=6)

    return ProcessedImage(full_webp=full_buf.getvalue(), thumbnail_webp=thumb_buf.getvalue())
