#!/usr/bin/env bash
# Run on the STANDBY when the primary is down: starts VaultFree on the last synced data and serves it
# on the tailnet. Refuses if the primary still answers, so two nodes never accept writes at once.
#
#   sudo ./promote.sh            # normal
#   sudo ./promote.sh --force    # primary looks alive but you know it must not serve (e.g. you shut it down)
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)"
. "$APP/node.conf"
DATA_DIR="${DATA_DIR:-/srv/vaultfree/data}"

if [ "${1:-}" != "--force" ] && [ -n "${PEER_URL:-}" ] && curl -fsS -m 10 "$PEER_URL/api/health" >/dev/null 2>&1; then
  echo "The primary answers at $PEER_URL. Not promoting (two writers would diverge). Use --force only if you are sure." >&2
  exit 1
fi
[ -s "$DATA_DIR/auth.json" ] || { echo "No synced data in $DATA_DIR: nothing to promote." >&2; exit 1; }

cd "$APP"
docker compose -f docker-compose.prod.yml --env-file .env up -d
tailscale serve --bg 3000
for i in $(seq 1 30); do curl -fsS -m 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break || sleep 2; done
curl -fsS -m 5 http://127.0.0.1:3000/api/health && echo
URL="$(sed -n 's/^VAULTFREE_PUBLIC_URL=//p' .env)"
echo "STANDBY IS NOW SERVING at $URL"
echo "Data written here since the last sync exists only on this node. The primary's sync job will refuse to run while this node serves."
echo "When the primary is back, fail back with: sudo $APP/failback.sh"
