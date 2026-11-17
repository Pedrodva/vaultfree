# Always-on private deployment with a warm standby (free tiers + Tailscale)

A small, no-cost way to run VaultFree for a few people: **one primary server, one standby, reachable only through [Tailscale](https://tailscale.com)** (nothing is exposed to the public internet). Everything here is plain shell and Docker Compose; the app itself needs no changes.

```
 you / friend (Tailscale installed)
        │ https://<primary>.ts.net      (Tailscale Serve, automatic certificate)
        ▼
 PRIMARY  ── VaultFree (Docker) ── /srv/vaultfree/data ──┐  rsync every 15 min over the tailnet
                                                         ▼
 STANDBY  ── VaultFree stopped ───  /srv/vaultfree/data (mirror)     promote.sh starts it when needed
```

## Design decisions
- **Warm standby, not active-active.** Two servers each accepting writes would diverge (split brain). The standby keeps a mirror and stays stopped; `promote.sh` refuses to start while the primary still answers.
- **The primary's sync refuses to run while the standby is serving**, so a primary coming back with stale data can never overwrite notes written during the outage.
- **Data-loss window = the sync interval** (15 minutes) in the worst case. Local daily snapshots (kept 14 days) protect against mistakes that a live mirror would copy too. Keep an off-cloud copy as well (below).
- **The standby has a different Tailscale address.** Users switch to it during an outage (or you can check whether Tailscale Services gives both nodes one stable name).
- Image pinned to a version (`VAULTFREE_VERSION`), never `latest`, so both nodes always run the same build. Both `linux/amd64` and `linux/arm64` images are published.

## Install (per server)
Requirements: Ubuntu/Debian, a user with passwordless `sudo`, Tailscale account.

```bash
# from your computer: copy the folder, then run it on the server
scp -r deploy USER@SERVER:~/deploy
ssh USER@SERVER 'sudo tailscale up'            # open the printed link and approve the device
ssh USER@SERVER 'sudo ~/deploy/install-node.sh primary 0.1.0'   # or: standby
```

Then authorise each node's printed sync key on the other (append to `~/.ssh/authorized_keys` of the sync user), and fill `/opt/vaultfree/node.conf` (`PEER_HOST`, `PEER_URL`; see `node.conf.example`). Enable *HTTPS Certificates* in the Tailscale admin console (DNS page) once.

The first account you register becomes the administrator; then create the friend's account with an invite link and keep sign-up closed.

## Failover
```bash
# on the standby, when the primary is down
sudo /opt/vaultfree/promote.sh

# when the primary is healthy again (on the standby)
sudo /opt/vaultfree/failback.sh
```
`failback.sh` stops the standby, moves the primary's old data aside (never deletes it), copies the newer data back and restarts the primary.

## Backups off the cloud
Snapshots live in `/srv/vaultfree/backups`. Pull one to a machine you own now and then:

```bash
scp USER@SERVER:/srv/vaultfree/backups/$(ssh USER@SERVER 'ls -1t /srv/vaultfree/backups | head -1') .
```
`vaultfree verify` (inside the container) checks a data directory's integrity.

## Known limits
- Free tiers can change or reclaim idle machines (for example Oracle Always Free instances with very low CPU and network use). That is why a standby on another provider exists; check both providers' current terms.
- `rsync` of a live directory can copy a note mid-write; the next sync fixes it and VaultFree reconciles on read. Run `vaultfree verify` after a failover.
- Failover is manual on purpose.
