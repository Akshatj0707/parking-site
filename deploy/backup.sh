#!/usr/bin/env bash
#
# Copies the bookings file to /var/backups/bayfind/bookings-DATE_TIME.json and deletes copies older than 30 days.
# The server runs this every night (bayfind-backup.timer). To make a copy right now:
#
#   sudo bash /opt/bayfind/deploy/backup.sh
#
set -Eeuo pipefail

# The BAYFIND_* names exist only for testing; on a real server leave them alone.
STATE_DIR="${BAYFIND_STATE_DIR:-/var/lib/bayfind}"
BACKUP_DIR="${BAYFIND_BACKUP_DIR:-/var/backups/bayfind}"
KEEP_DAYS="${BAYFIND_KEEP_DAYS:-30}"
SOURCE="$STATE_DIR/bookings.json"

if [ ! -f "$SOURCE" ]; then
  echo "There is no bookings file yet, so there is nothing to back up."
  exit 0
fi

umask 077
mkdir -p "$BACKUP_DIR"
target="$BACKUP_DIR/bookings-$(date +%Y-%m-%d_%H%M%S).json"
trap 'rm -f "$target.partial"' EXIT

# The site replaces the file in one step, so a copy is always a whole file. Check that it reads as JSON anyway.
cp "$SOURCE" "$target.partial"
if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$target.partial"; then
  echo "The bookings file could not be read as JSON, so it was NOT backed up." >&2
  exit 1
fi
mv "$target.partial" "$target"

find "$BACKUP_DIR" -maxdepth 1 -name 'bookings-*.json' -mtime "+$KEEP_DAYS" -delete
echo "Backed up the bookings to $target"
