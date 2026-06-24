#!/bin/bash
# Hourly news pipeline: scrape RSS -> extract bodies -> classify (Haiku) ->
# rephrase -> translate. Also auto-creates/reconciles provisional events+bouts
# from announcements (loaders/news.py). Best-effort code sync first.
export PATH=/usr/local/bin:/usr/bin:/bin
LOG=/var/log/vertex-news.log
ts() { date "+%Y-%m-%d %H:%M:%S"; }
git_sync() {
  ( cd /opt/vertex-cron/vertex-mma \
    && git fetch --quiet origin main 2>/dev/null \
    && git reset --quiet --hard origin/main 2>/dev/null \
    && echo "$(ts) git: synced to $(git rev-parse --short HEAD)" \
    || echo "$(ts) git: sync skipped — staying on pinned $(git -C /opt/vertex-cron/vertex-mma rev-parse --short HEAD 2>/dev/null)" )
}
{
  # Own lock (separate from the scrape lock) so a stuck news run can't stack.
  exec 8>/var/lock/vertex-news.lock
  if ! flock -n 8; then echo "===== $(ts) news: lock busy, skipping ====="; exit 0; fi

  echo "===== $(ts) news start ====="
  cd /opt/vertex-cron/vertex-mma || { echo "$(ts) checkout missing"; exit 1; }
  git_sync
  VENV=scripts/scraper/venv
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -r scripts/scraper/requirements.txt || echo "$(ts) pip warned"
  cd scripts/scraper
  for step in 09_scrape_news 09b_extract_article_bodies 10_classify_news 11_rephrase_news 15_translate_news; do
    echo "$(ts) news step: $step"
    venv/bin/python "scripts/$step.py" || echo "$(ts) step $step FAILED (continuing)"
  done
  echo "===== $(ts) news done ====="
} >> "$LOG" 2>&1
