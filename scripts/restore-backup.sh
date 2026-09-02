#!/bin/sh
# Real, tested restore procedure for a backup produced by
# scripts/postgres-backup.sh (verified round-trip: pg_dump | gzip, then
# gunzip | psql, against a real seeded database - row counts matched
# exactly before and after).
#
# This REPLACES data in the target database with what's in the backup -
# it is not a merge. Stop app-server and app-worker first
# (`docker compose stop app-server app-worker`) so nothing writes to the
# database mid-restore, and be certain you're restoring into the database
# you intend to.
#
# Usage (run from the Droplet, or anywhere with `docker compose` access to
# the same stack):
#   ./scripts/restore-backup.sh /path/to/whatchatai-<timestamp>.sql.gz
set -eu

BACKUP_FILE="${1:?Usage: restore-backup.sh <path-to-backup.sql.gz>}"
[ -f "$BACKUP_FILE" ] || { echo "No such file: $BACKUP_FILE" >&2; exit 1; }

POSTGRES_USER="${POSTGRES_USER:-whatchatai}"
POSTGRES_DB="${POSTGRES_DB:-whatchatai_dev}"

echo "About to restore '$BACKUP_FILE' into database '$POSTGRES_DB'."
echo "This REPLACES existing data. Make sure app-server and app-worker are stopped."
printf 'Type the database name (%s) to confirm: ' "$POSTGRES_DB"
read -r confirm
if [ "$confirm" != "$POSTGRES_DB" ]; then
  echo "Confirmation did not match - aborting, nothing was touched." >&2
  exit 1
fi

gunzip -c "$BACKUP_FILE" | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
echo "Restore complete."
