#!/usr/bin/env bash
# Voidswarm - consistent online backup of the SQLite database (accounts, loot, chat log); keeps 14 days.
set -euo pipefail
DATA_DIR=/var/lib/voidswarm
DB="$DATA_DIR/voidswarm.db"
OUT_DIR="$DATA_DIR/backups"
[[ -f "$DB" ]] || exit 0
stamp=$(date +%F)
sqlite3 "$DB" ".backup '$OUT_DIR/voidswarm-$stamp.db'"
chown voidswarm:voidswarm "$OUT_DIR/voidswarm-$stamp.db"
chmod 640 "$OUT_DIR/voidswarm-$stamp.db"
find "$OUT_DIR" -name 'voidswarm-*.db' -type f -mtime +14 -delete
