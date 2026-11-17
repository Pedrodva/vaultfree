#!/usr/bin/env bash
# Run on YOUR computer (not on the server): downloads the newest snapshot to a local folder,
# so a copy of the data exists outside the cloud account that hosts it.
#
#   ./pull-backup.sh USER@HOST [DEST_DIR] [SSH_KEY]
#   ./pull-backup.sh ubuntu@vaultfree.tailXXXX.ts.net ~/VaultFree-backups ~/.ssh/id_ed25519
set -euo pipefail
TARGET="${1:?usage: $0 USER@HOST [DEST_DIR] [SSH_KEY]}"
DEST="${2:-$HOME/VaultFree-backups}"
KEY="${3:-}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20)
[ -n "$KEY" ] && SSH+=(-i "$KEY")

mkdir -p "$DEST"
NAME="$("${SSH[@]}" "$TARGET" "sudo sh -c 'ls -1t /srv/vaultfree/backups/vaultfree-*.tar.gz | head -1'")"
[ -n "$NAME" ] || { echo "No snapshots found on the server." >&2; exit 1; }
OUT="$DEST/$(basename "$NAME")"
"${SSH[@]}" "$TARGET" "sudo cat '$NAME'" > "$OUT.part"
tar -tzf "$OUT.part" > /dev/null   # refuse to keep a truncated or corrupt download
mv "$OUT.part" "$OUT"
echo "saved $OUT ($(du -h "$OUT" | cut -f1))"
# keep the newest 30 local copies
ls -1t "$DEST"/vaultfree-*.tar.gz | tail -n +31 | xargs -r rm -f --
