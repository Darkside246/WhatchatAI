#!/bin/sh
# Runs inside the `postgres-backup` service in docker-compose.yml. Real,
# tested backup mechanism for the Droplet's single Postgres volume - before
# this, postgres-data had zero backup of any kind: a bad `docker volume rm`,
# a corrupted volume, or Droplet disk loss meant permanent loss of every
# tenant's data with no recovery path.
#
# This is a same-host backup (writes into the separate `postgres-backups`
# volume, on the same Droplet/disk as postgres-data) - it protects against
# volume-level accidents (an operator removing the wrong volume, a bad
# migration corrupting data) but NOT against full Droplet/disk loss. A real
# off-host copy (DigitalOcean Spaces or equivalent) needs real credentials
# this environment does not have - see docs/DOCKER.md's "Known gaps".
set -eu

BACKUP_DIR=/backups
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"

backup_once() {
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$BACKUP_DIR/whatchatai-$timestamp.sql.gz"
  tmp="$dest.tmp"
  echo "[postgres-backup] starting dump -> $dest"
  if pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain | gzip > "$tmp"; then
    mv "$tmp" "$dest"
    echo "[postgres-backup] wrote $dest ($(du -h "$dest" | cut -f1))"
  else
    echo "[postgres-backup] dump FAILED - leaving no partial file" >&2
    rm -f "$tmp"
    return 1
  fi
  find "$BACKUP_DIR" -maxdepth 1 -name 'whatchatai-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete
}

while true; do
  backup_once || echo "[postgres-backup] this cycle failed - will retry next interval, previous backups untouched" >&2
  sleep "$INTERVAL_SECONDS"
done
