#!/usr/bin/env bash
# PRIMARY -> STANDBY mirror of the data directory (cron: every 15 minutes).
#
# Safety rules, because a wrong mirror direction destroys data:
#   * runs only if this node is the primary AND healthy AND has data;
#   * refuses to run if the standby is currently serving (it was promoted and may hold newer notes).
set -euo pipefail
. "$(dirname "$0")/node.conf"
DATA_DIR="${DATA_DIR:-/srv/vaultfree/data}"

[ "${ROLE:-}" = primary ] || { echo "$(date -Is) not a primary, skipping"; exit 0; }
curl -fsS -m 10 http://127.0.0.1:3000/api/health >/dev/null || { echo "$(date -Is) local VaultFree not healthy, skipping"; exit 0; }
[ -s "$DATA_DIR/auth.json" ] || { echo "$(date -Is) no auth.json yet, skipping"; exit 0; }
[ -n "${PEER_HOST:-}" ] || { echo "$(date -Is) PEER_HOST not set, skipping"; exit 0; }

if [ -n "${PEER_URL:-}" ] && curl -fsS -m 10 "$PEER_URL/api/health" >/dev/null 2>&1; then
  echo "$(date -Is) STANDBY IS SERVING: not syncing so it cannot be overwritten. Fail back first (see deploy/README.md)." >&2
  exit 1
fi

SSH="ssh -i ${SYNC_KEY:-/root/.ssh/vf_sync} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
rsync -a --delete --numeric-ids --exclude='*.tmp' \
  -e "$SSH" --rsync-path="sudo rsync" \
  "$DATA_DIR"/ "${SYNC_USER:-ubuntu}@$PEER_HOST:$DATA_DIR/"
echo "$(date -Is) synced to $PEER_HOST"
