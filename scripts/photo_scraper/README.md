# Vertex MMA — Photo Scraper

Resolves Wikipedia articles for fighters in the Vertex MMA database, downloads the article photo (license-permitting), normalizes it to WebP, writes it into the local photo store, and updates the fighter row. `publish_photos.sh` then rsyncs the store to the origin that serves it ([`ops/photos`](../../ops/photos)).

Photos used to be uploaded straight to a Supabase storage bucket. That project was deleted, taking 2,400 photos with it; [`rehost_photos.py`](scripts/rehost_photos.py) refetched them from the sources every row had recorded.

## Prerequisites

1. `.env.local` at the project root with `DATABASE_URL`. Postgres is bound to
   localhost on the VPS, so from a laptop that means a tunnel:
   `ssh -fNL 5434:127.0.0.1:5433 root@<vps>`.
2. SSH access to the VPS (`~/.ssh/vertexmma_vps_ed25519`) — publishing is an rsync.
3. Make sure the `photo_*` columns have been applied (root `pnpm db:push`).

Run it from a **residential connection**: ufc.com answers the VPS with a 403, so
neither fetching nor a cron on the box can do this job.

Optional overrides: `PHOTO_STORE_DIR` (default `~/.cache/vertexmma-photos`),
`PHOTO_PUBLIC_BASE`, `PHOTO_REMOTE_HOST`, `PHOTO_REMOTE_ROOT`, `PHOTO_SSH_KEY`.

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

# Repair: refetch every photo whose URL points at the dead Supabase bucket,
# repoint the rows, then push the store to the origin.
./venv/bin/python scripts/rehost_photos.py --dry-run --limit 5
./venv/bin/python scripts/rehost_photos.py --publish

# Push the store on its own.
scripts/publish_photos.sh
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

- `scripts/photo_scraper/.errors.jsonl` — per-fighter non-fatal failures (store write, image decode).
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
    storage.py          # local photo store + rsync to the origin
    parsers/wikipedia_article.py  # reserved for future deep-parsing
    loaders/photo.py
    utils/logger.py, similarity.py
  scripts/
    _path.py
    fetch_photos.py     # CLI: --limit / --dry-run
    fetch_photos_ufc.py # CLI: official UFC cutouts for fighters Wikipedia missed
    rehost_photos.py    # CLI: refetch what the deleted bucket was holding
    publish_photos.sh   # rsync the store to the origin
```
