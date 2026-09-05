#!/bin/bash
# Nightly backup of the self-hosted Postgres.
#
# Supabase was taking daily backups; moving the databases onto this box moved
# that responsibility here too. Both databases together are well under 100 MB
# compressed, so retention is cheap and there is no reason to be clever.
#
# Every database on the instance is backed up, discovered at run time rather
# than listed here, so a database added later is not silently left unprotected.
#
# Every dump is verified before the old ones are pruned: pg_restore --list on a
# corrupt custom-format file fails, and a backup nobody has ever read is not a
# backup. A failure keeps that database's existing retention untouched.
#
# Installed as: 0 2 * * * /opt/vertex-cron/db-backup.sh
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin

CONTAINER=vertex-postgres
DEST=/opt/vertex-db/backups
KEEP_DAYS=14
LOG=/var/log/vertex-db-backup.log

ts() { date "+%Y-%m-%d %H:%M:%S"; }

backup_one() {
  local db="$1" stamp="$2"
  local out="$DEST/${db}-${stamp}.dump"
  local inner="/tmp/${db}-${stamp}.dump"

  # Dump to a file inside the container, verify it there, and only then copy it
  # out. The host has no postgres client, and a custom-format archive piped
  # through stdin cannot be seeked, so both halves have to happen where
  # pg_restore actually lives.
  if ! docker exec "$CONTAINER" pg_dump -U postgres -d "$db" -Fc -f "$inner"; then
    echo "$(ts) [$db] pg_dump FAILED — keeping existing backups"
    docker exec "$CONTAINER" rm -f "$inner" 2>/dev/null
    return 1
  fi

  if ! docker exec "$CONTAINER" pg_restore --list "$inner" >/dev/null 2>&1; then
    echo "$(ts) [$db] dump did not verify — discarding it, keeping existing backups"
    docker exec "$CONTAINER" rm -f "$inner" 2>/dev/null
    return 1
  fi

  if ! docker cp "$CONTAINER:$inner" "$out"; then
    echo "$(ts) [$db] copy out of the container FAILED — keeping existing backups"
    docker exec "$CONTAINER" rm -f "$inner" 2>/dev/null
    rm -f "$out"
    return 1
  fi
  docker exec "$CONTAINER" rm -f "$inner" 2>/dev/null

  echo "$(ts) [$db] wrote and verified $(basename "$out") ($(du -h "$out" | cut -f1))"

  # Prune only after a good dump landed, so a run of failures can never leave
  # this database with nothing.
  local deleted
  deleted=$(find "$DEST" -name "${db}-*.dump" -type f -mtime +${KEEP_DAYS} -print -delete | wc -l)
  echo "$(ts) [$db] pruned $deleted old backup(s); $(find "$DEST" -name "${db}-*.dump" | wc -l) retained"
  return 0
}

{
  echo "===== $(ts) db-backup start ====="
  mkdir -p "$DEST"

  if ! docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    echo "$(ts) $CONTAINER is not accepting connections — aborting, keeping existing backups"
    exit 1
  fi

  DBS=$(docker exec "$CONTAINER" psql -U postgres -d postgres -X -A -t \
        -c "select datname from pg_database where not datistemplate and datname <> 'postgres' order by datname")
  if [ -z "$DBS" ]; then
    echo "$(ts) no databases found — aborting rather than pruning against an empty list"
    exit 1
  fi

  STAMP=$(date +%Y%m%d-%H%M%S)
  FAILED=0
  for db in $DBS; do
    backup_one "$db" "$STAMP" || FAILED=$((FAILED + 1))
  done

  echo "===== $(ts) db-backup done ($FAILED failure(s)) ====="
  [ "$FAILED" -eq 0 ]
} >> "$LOG" 2>&1
