#!/bin/bash
# Nightly backup of the self-hosted Postgres.
#
# Supabase was taking daily backups; moving the database onto this box moved
# that responsibility here too. The whole database is ~24 MB compressed, so
# retention is cheap and there is no reason to be clever about it.
#
# Every dump is verified before the old ones are pruned: pg_restore --list on a
# corrupt custom-format file fails, and a backup nobody has ever read is not a
# backup. A failed verification keeps the existing retention untouched.
#
# Installed as: 0 2 * * * /opt/vertex-cron/db-backup.sh
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin

CONTAINER=vertex-postgres
DB=vertexmma
DEST=/opt/vertex-db/backups
KEEP_DAYS=14
LOG=/var/log/vertex-db-backup.log

ts() { date "+%Y-%m-%d %H:%M:%S"; }

{
  echo "===== $(ts) db-backup start ====="
  mkdir -p "$DEST"

  if ! docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
    echo "$(ts) $CONTAINER is not accepting connections — aborting, keeping existing backups"
    exit 1
  fi

  STAMP=$(date +%Y%m%d-%H%M%S)
  OUT="$DEST/${DB}-${STAMP}.dump"
  INNER="/tmp/${DB}-${STAMP}.dump"

  # Dump to a file inside the container, verify it there, and only then copy it
  # out. The host has no postgres client, and a custom-format archive piped
  # through stdin cannot be seeked, so both halves of this have to happen where
  # pg_restore actually lives.
  if ! docker exec "$CONTAINER" pg_dump -U postgres -d "$DB" -Fc -f "$INNER"; then
    echo "$(ts) pg_dump FAILED — keeping existing backups"
    docker exec "$CONTAINER" rm -f "$INNER" 2>/dev/null
    exit 1
  fi

  # A dump that cannot be listed cannot be restored. Check before pruning.
  if ! docker exec "$CONTAINER" pg_restore --list "$INNER" >/dev/null 2>&1; then
    echo "$(ts) dump did not verify — discarding it, keeping existing backups"
    docker exec "$CONTAINER" rm -f "$INNER" 2>/dev/null
    exit 1
  fi

  if ! docker cp "$CONTAINER:$INNER" "$OUT"; then
    echo "$(ts) copy out of the container FAILED — keeping existing backups"
    docker exec "$CONTAINER" rm -f "$INNER" 2>/dev/null
    rm -f "$OUT"
    exit 1
  fi
  docker exec "$CONTAINER" rm -f "$INNER" 2>/dev/null

  SIZE=$(du -h "$OUT" | cut -f1)
  echo "$(ts) wrote and verified $(basename "$OUT") ($SIZE)"

  # Prune only after a good dump landed, so a run of failures can never leave
  # us with nothing.
  DELETED=$(find "$DEST" -name "${DB}-*.dump" -type f -mtime +${KEEP_DAYS} -print -delete | wc -l)
  echo "$(ts) pruned $DELETED backup(s) older than ${KEEP_DAYS} days; $(find "$DEST" -name "${DB}-*.dump" | wc -l) retained"
  echo "===== $(ts) db-backup done ====="
} >> "$LOG" 2>&1
