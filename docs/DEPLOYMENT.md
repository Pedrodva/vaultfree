# Deployment

## Docker
```bash
docker compose up -d
```
Data lives in the `vaultfree-data` Docker volume (mounted at `/data`). Back it up by copying that volume; `vaults/<id>/` inside it is plain Markdown.

## Automatic HTTPS with your own domain
```bash
echo "VAULTFREE_DOMAIN=notes.example.com" >> .env   # DNS A record -> this machine, ports 80/443 open
docker compose --profile https up -d
```
The bundled Caddy obtains and renews the certificate; VaultFree switches to secure cookies and proxy trust automatically (`VAULTFREE_PUBLIC_URL` is derived from the domain).

## Share online (quick tunnel)
Admin → 🔗 → **Start sharing online** runs `cloudflared` (included in the Docker image) and shows a public `https://*.trycloudflare.com` address. It is meant for demos and small groups: the address changes on every start, and the tunnel stops with the server. For a permanent server use your own domain above. Outside Docker, install `cloudflared` yourself (or set `VAULTFREE_CLOUDFLARED=/path/to/cloudflared`).

## Permanent public address with a named Cloudflare tunnel
Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), map a public hostname to `http://localhost:3000`, then set in `.env`:
```
VAULTFREE_TUNNEL_TOKEN=<tunnel token>
VAULTFREE_DOMAIN=notes.example.com   # the hostname you mapped
```
The server starts `cloudflared` itself and restarts it if it drops; the address never changes, so API tokens and MCP configs keep working. The in-app *Share online* button shows the permanent address instead of opening a temporary tunnel.

## Remote MCP (HTTP)
Clients that support HTTP MCP can connect to `https://<your-address>/mcp` with `Authorization: Bearer vf_<token>`. OAuth is not supported yet.

## Invite links
Vault owner → 🔗 → create link. Invited users need no admin help and sign-up can stay closed. Links are single-use by default, can be set to expire (1 day to 30 days) or to never expire, and can be revoked.

## Public demo mode
`VAULTFREE_DEMO=true` turns a server into a public playground. The sign-in screen gets a **Try the demo** button: each click creates a throwaway account that owns its own sandbox vault, seeded with sample notes, a teammate's edit and an AI-agent proposal waiting for review. Visitors can edit, rename, accept proposals and create API tokens, but cannot create more vaults, upload files, invite people, copy vaults or reach admin features; requests are capped at 256 KB and sandboxes at 300 notes. Sandboxes and their accounts are erased after `VAULTFREE_DEMO_TTL_HOURS` (24) and at most `VAULTFREE_DEMO_MAX` (200) exist at once (the oldest is dropped first). Self-registration is always off in demo mode; create an admin with `vaultfree user add` if you need one.

One click on Render (free plan, no disk needed): [deploy](https://render.com/deploy?repo=https://github.com/Pedrodva/vaultfree) uses [`render.yaml`](../render.yaml). Locally: `VAULTFREE_DEMO=true npm start`.

## Behind another HTTPS proxy (Caddy/nginx)
```
notes.example.com {
  reverse_proxy 127.0.0.1:3000
}
```
Set `VAULTFREE_TRUST_PROXY=1` and `VAULTFREE_SECURE_COOKIES=1`. SSE needs response buffering disabled (nginx: `proxy_buffering off;`).

## Environment
| Variable | Default | |
|---|---|---|
| `VAULTFREE_DATA` | `./data` | data directory |
| `VAULTFREE_PORT` / `VAULTFREE_HOST` | `3000` / `127.0.0.1` | Docker image uses `0.0.0.0` |
| `VAULTFREE_ALLOW_SIGNUP` | `false` | open self-registration |
| `VAULTFREE_USERS_CAN_CREATE_VAULTS` | `true` | |
| `VAULTFREE_PUBLIC_URL` | empty | public address; if `https://…`, secure cookies and proxy trust turn on |
| `VAULTFREE_DOMAIN` | empty | compose only: domain for the `https` profile |
| `VAULTFREE_TUNNEL_TOKEN` | empty | run a named Cloudflare tunnel (see above) |
| `VAULTFREE_TRUST_PROXY` | `false` | use `X-Forwarded-*` |
| `VAULTFREE_SECURE_COOKIES` | `false` | add `Secure` to cookies |
| `VAULTFREE_DEMO` | `false` | public demo mode (see above) |
| `VAULTFREE_DEMO_TTL_HOURS` / `VAULTFREE_DEMO_MAX` | `24` / `200` | sandbox lifetime / how many at once |

## Operations
- `vaultfree verify` — checks every note against its hash, every history object, and the audit chain.
- `vaultfree user add alice --admin` / `user passwd alice` — manage accounts from the shell.
- A vault folder can be edited with Obsidian, git or a sync tool while the server runs: changes are picked up automatically (and re-checked before every save, so they are merged, never overwritten).
- Single-process design: run one instance per data directory.
