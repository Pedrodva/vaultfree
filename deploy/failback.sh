#!/usr/bin/env bash
# Run on the STANDBY after it served as primary and the original primary is healthy again:
# stops the standby app, copies its (newer) data back to the primary, then starts the primary.
#
# The primary's old data is first moved aside on the primary (not deleted), so nothing is lost either way.
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)"
. "$APP/node.conf"
DATA_DIR="${DATA_DIR:-/srv/vaultfree/data}"
SSH="ssh -i ${SYNC_KEY:-/root/.ssh/vf_sync} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
PEER="${SYNC_USER:-ubuntu}@$PEER_HOST"

echo "1/5 stopping the app on this node (the standby)"
tailscale serve reset || true
(cd "$APP" && docker compose -f docker-compose.prod.yml --env-file .env down)

echo "2/5 stopping the app on the primary and setting its old data aside"
$SSH "$PEER" "cd /opt/vaultfree && sudo docker compose -f docker-compose.prod.yml --env-file .env down; sudo mv $DATA_DIR $DATA_DIR.before-failback-\$(date +%Y%m%d-%H%M%S) && sudo install -d -o 1000 -g 1000 $DATA_DIR"

echo "3/5 copying this node's data to the primary"
rsync -a --numeric-ids --exclude='*.tmp' -e "$SSH" --rsync-path="sudo rsync" "$DATA_DIR"/ "$PEER:$DATA_DIR/"

echo "4/5 starting the primary"
$SSH "$PEER" "cd /opt/vaultfree && sudo docker compose -f docker-compose.prod.yml --env-file .env up -d && sudo tailscale serve --bg 3000"

echo "5/5 done. The primary serves again; this node is a standby (app stopped)."
echo "The primary's previous data is in $DATA_DIR.before-failback-* on the primary; delete it when you are happy."
