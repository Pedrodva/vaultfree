#!/usr/bin/env bash
# Daily local snapshot of the data directory, keeping the newest N. Protects against mistakes and
# corruption that a live mirror would copy too. Also copy a snapshot OFF this cloud now and then.
set -euo pipefail
. "$(dirname "$0")/node.conf"
DATA_DIR="${DATA_DIR:-/srv/vaultfree/data}"; BACKUP_DIR="${BACKUP_DIR:-/srv/vaultfree/backups}"; KEEP_BACKUPS="${KEEP_BACKUPS:-14}"

[ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ] || { echo "$(date -Is) data dir empty, nothing to back up"; exit 0; }
install -d -m 700 "$BACKUP_DIR"
out="$BACKUP_DIR/vaultfree-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$DATA_DIR" --exclude='*.tmp' -czf "$out" .
echo "$(date -Is) wrote $out ($(du -h "$out" | cut -f1))"
# keep the newest $KEEP_BACKUPS
ls -1t "$BACKUP_DIR"/vaultfree-*.tar.gz | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f --
