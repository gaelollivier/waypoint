#!/usr/bin/env bash
set -euo pipefail

DB_DIR="$HOME/.waypoint"
DB_PATH="$DB_DIR/waypoint.db"

if [ ! -f "$DB_PATH" ]; then
  echo "Error: database not found at $DB_PATH" >&2
  exit 1
fi

timestamp=$(date +"%Y-%m-%d_%H-%M-%S")
snapshot="$DB_DIR/waypoint_snapshot_${timestamp}.db"

# Use SQLite VACUUM INTO for a consistent snapshot even if the server is running.
# This produces a clean, standalone copy without WAL or SHM files.
sqlite3 "$DB_PATH" "VACUUM INTO '${snapshot}';"

echo "Snapshot saved: $snapshot"
