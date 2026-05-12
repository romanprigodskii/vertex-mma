# Vertex MMA — Photo Scraper

Resolves Wikipedia articles for fighters in the Vertex MMA database, downloads the article photo (license-permitting), normalizes it to WebP, uploads to Supabase Storage, and updates the fighter row.

## Prerequisites

1. `.env.local` at the project root with `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
2. Run the two SQL scripts in **Supabase → SQL Editor** before fetching anything:
   - [`drizzle/migrations/0001_fighter_with_stats_view.sql`](../../drizzle/migrations/0001_fighter_with_stats_view.sql)
   - [`drizzle/migrations/0002_storage_bucket.sql`](../../drizzle/migrations/0002_storage_bucket.sql)
3. Make sure the new `photo_*` columns have been applied (root `pnpm db:push`).

## Setup

```bash
cd scripts/photo_scraper
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Usage

```bash
# Smoke test: parse first 5 fighters (most-fought first), don't write anything.
./venv/bin/python scripts/fetch_photos.py --limit 5 --dry-run

# Small real run.
./venv/bin/python scripts/fetch_photos.py --limit 20

# Full enrichment.
./venv/bin/python scripts/fetch_photos.py
```

## Etiquette

- 1.0 s rate limit between requests, exponential backoff on 429/5xx.
- User-Agent identifies the project per Wikimedia policy.
- License check is **mandatory**. Photos are only kept when the license metadata matches one of:
  - CC0 / Public Domain
  - CC BY / CC BY-SA (any version)
- Anything else → fighter row marked `photo_fetch_status = 'license_blocked'`, no upload.

## Matching strategy

For each fighter (ordered by bout count desc, so big names ship first):

1. MediaWiki `opensearch` on `name_en`, up to 5 titles.
2. For each title, fetch the REST summary.
3. Reject disambiguation pages.
4. Require name similarity ≥ 0.80 (NFKD-normalized, stripped of accents/punct).
5. Require an MMA keyword (`mixed martial artist`, `UFC`, `Bellator`, `PFL`, `ONE Championship`, etc.) in the page extract or description.
6. First candidate that passes → download the image.

If nothing qualifies → `photo_fetch_status = 'no_match'`, `photo_url` stays NULL, and the UI falls back to `/images/silhouette-fighter-male.svg`.

## Outputs

- `scripts/photo_scraper/.errors.jsonl` — per-fighter non-fatal failures (storage upload, image decode).
- `fighter.photo_fetch_status` is the per-row outcome: `success | no_match | license_blocked | fetch_error`.

## Layout

```
scripts/photo_scraper/
  requirements.txt
  pyproject.toml
  README.md
  src/
    config.py
    db.py
    http.py
    wikipedia.py        # opensearch + REST summary + Commons license lookup
    image_processor.py  # Pillow: WebP full + 200x200 thumbnail
    storage.py          # Supabase Storage REST upload
    parsers/wikipedia_article.py  # reserved for future deep-parsing
    loaders/photo.py
    utils/logger.py, similarity.py
  scripts/
    _path.py
    fetch_photos.py     # CLI: --limit / --dry-run
```
