#!/usr/bin/env bash
# Prepares one server (Ubuntu/Debian, amd64 or arm64) to run VaultFree behind Tailscale.
#
#   sudo ./install-node.sh primary  [version]    # runs VaultFree now and serves it on your tailnet
#   sudo ./install-node.sh standby  [version]    # prepares everything but leaves the app stopped
#
# Tailscale must already be logged in on this machine ("sudo tailscale up"): it is an account step.
set -euo pipefail

ROLE="${1:-}"; VERSION="${2:-0.1.0}"
case "$ROLE" in primary | standby) ;; *) echo "usage: sudo $0 primary|standby [version]" >&2; exit 1 ;; esac
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/vaultfree

install -d "$APP" /srv/vaultfree/data /srv/vaultfree/backups
if [ "$SRC" != "$APP" ]; then cp "$SRC"/*.sh "$SRC"/docker-compose.prod.yml "$SRC"/node.conf.example "$APP"/; fi
chmod +x "$APP"/*.sh
chown 1000:1000 /srv/vaultfree/data   # the container runs as uid 1000 ("node")

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
command -v rsync >/dev/null || { apt-get update -y && apt-get install -y rsync; }
command -v curl >/dev/null || apt-get install -y curl

if ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale is not logged in on this machine. Run: sudo tailscale up   (then run this script again)" >&2
  exit 1
fi
DNS="$(tailscale status --json --peers=false | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1)"
DNS="${DNS%.}"
[ -n "$DNS" ] || { echo "Could not read this machine's Tailscale name (is MagicDNS enabled?)." >&2; exit 1; }

# .env is only created once so that re-running the script never changes a pinned version by accident
if [ ! -f "$APP/.env" ]; then
  cat > "$APP/.env" <<EOF
VAULTFREE_VERSION=$VERSION
VAULTFREE_PUBLIC_URL=https://$DNS
VAULTFREE_DATA_DIR=/srv/vaultfree/data
EOF
fi
[ -f "$APP/node.conf" ] || { sed "s/^ROLE=.*/ROLE=$ROLE/" "$APP/node.conf.example" > "$APP/node.conf"; }

# a dedicated key for node-to-node sync (public half is printed so it can be authorised on the peer)
if [ ! -f /root/.ssh/vf_sync ]; then
  install -d -m 700 /root/.ssh
  ssh-keygen -t ed25519 -N "" -C "vaultfree-sync-$ROLE" -f /root/.ssh/vf_sync >/dev/null
fi

cd "$APP"
docker compose -f docker-compose.prod.yml --env-file .env pull

# scheduled jobs: daily local backup everywhere, 15-minute sync from the primary
echo "17 3 * * * root $APP/backup.sh >> /var/log/vaultfree-backup.log 2>&1" > /etc/cron.d/vaultfree
if [ "$ROLE" = primary ]; then
  echo "*/15 * * * * root $APP/sync-standby.sh >> /var/log/vaultfree-sync.log 2>&1" >> /etc/cron.d/vaultfree
fi
chmod 644 /etc/cron.d/vaultfree

if [ "$ROLE" = primary ]; then
  docker compose -f docker-compose.prod.yml --env-file .env up -d
  tailscale serve --bg 3000
  echo "VaultFree $VERSION is running. Tailnet address: https://$DNS"
else
  echo "Standby ready (app stopped). If the primary fails, run: sudo $APP/promote.sh"
  echo "This node's address once promoted: https://$DNS"
fi
echo "Sync public key of this node:"; cat /root/.ssh/vf_sync.pub
