from __future__ import annotations

WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_REST_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

USER_AGENT = (
    "VertexMMA-PhotoScraper/0.1 (https://vertexmma.com; contact@vertexmma.com)"
)

RATE_LIMIT_SECONDS = 1.0
REQUEST_TIMEOUT = 30.0
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0

NAME_SIMILARITY_THRESHOLD = 0.80

# License values we are willing to host on Supabase Storage. Anything else → skip.
ALLOWED_LICENSE_PATTERNS = (
    "cc0",
    "cc-zero",
    "public domain",
    "public-domain",
    "cc by",
    "cc-by",
    "cc by-sa",
    "cc-by-sa",
    "attribution-share alike",
    "attribution share-alike",
    "attribution-sharealike",
    "attribution",
    # PD-* tags (US government works, author-released, etc.)
    "pd-usgov",
    "pd-us",
    "pd-author",
    "pd-self",
    "pd-release",
    "pd-art",
    "pd ",
    # GFDL — Wikimedia legacy but explicitly compatible.
    "gfdl",
    "gnu free documentation license",
)

MMA_KEYWORDS = (
    "mixed martial artist",
    "mixed martial arts",
    " mma ",
    "ultimate fighting championship",
    "ufc",
    "bellator",
    "pfl ",
    "professional fighters league",
    "one championship",
    "rizin",
    "strikeforce",
    "pride fc",
    "kickboxer",
)

THUMBNAIL_SIZE = (200, 200)
FULL_MAX_SIZE = (800, 800)

STORAGE_BUCKET = "fighter-photos"
