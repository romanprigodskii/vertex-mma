from __future__ import annotations

BASE_URL = "http://ufcstats.com"
EVENTS_COMPLETED_URL = f"{BASE_URL}/statistics/events/completed?page=all"
EVENTS_UPCOMING_URL = f"{BASE_URL}/statistics/events/upcoming?page=all"
FIGHTERS_URL_TEMPLATE = f"{BASE_URL}/statistics/fighters?char={{letter}}&page=all"

USER_AGENT = "VertexMMA-Scraper/1.0 (research; contact@vertexmma.com)"

RATE_LIMIT_SECONDS = 0.6
RATE_LIMIT_ENRICH_SECONDS = 1.0  # heavier pages get extra breathing room

MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0

REQUEST_TIMEOUT = 30.0

# Re-sync fighter detail pages older than this (days).
FIGHTER_RESYNC_DAYS = 30

# Checkpoint cadence
CHECKPOINT_EVERY_FIGHTERS = 50
CHECKPOINT_EVERY_BOUTS = 100
