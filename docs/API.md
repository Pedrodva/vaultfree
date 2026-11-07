# VaultFree REST API

Auth: browser session cookie, or `Authorization: Bearer vf_<token>` (create under 🔑). Tokens have `read` / `write` scopes and may be limited to vaults. Errors: `{ "error": { "code", "message", ...extra } }`.

## Auth & admin
| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | `{needsSetup, allowSignup, version}` (public) |
| POST | `/api/auth/register` | first user → admin; later only if `VAULTFREE_ALLOW_SIGNUP` |
| POST | `/api/auth/login` · `/logout` | sets HttpOnly cookie |
| GET | `/api/auth/me` | |
| POST | `/mcp` | MCP over HTTP (JSON-RPC, Streamable HTTP without streaming). Auth: `Authorization: Bearer vf_…` only (cookies are rejected) |
| GET/POST | `/api/tokens` · DELETE `/api/tokens/:id` | |
| POST | `/api/auth/password` | `{current, next}`; session only; signs out other sessions |
| GET/POST/PATCH | `/api/admin/users` | admin only (`POST /api/admin/users/:id/password` resets a password) |
| GET/POST/DELETE | `/api/admin/share` | admin: status / start / stop the public tunnel |
| GET/POST | `/api/vaults/:v/invites` · DELETE `/:id` | owner: `{role: viewer|editor, maxUses, hours}` → `{token}` (shown once) |
| GET/POST | `/api/invites/:token` · `/accept` | public: preview / join (creates the account if anonymous) |

## Vaults (`/api/vaults/:v/...`)
| Method | Path | Role | Notes |
|---|---|---|---|
| GET/POST | `/api/vaults` | | list / create `{name}` |
| GET | `/notes` | viewer | list `[{path,title,tags,rev,mtime}]` + attachments |
| GET | `/notes/{path}` | viewer | `content, rev, links, backlinks, headings, frontmatter` |
| PUT | `/notes/{path}` | editor | `{content, baseRev}`; omit `baseRev` only when creating |
| DELETE | `/notes/{path}?baseRev=` | editor | to trash (history kept) |
| POST | `/ops/append` | editor | `{path, text}` conflict-free |
| POST | `/ops/rename` | editor | `{from, to}`; rewrites incoming `[[links]]` |
| POST | `/ops/restore` | editor | `{path, rev}` |
| POST | `/ops/mkdir` | editor | `{path}` create a (possibly empty) folder |
| POST | `/ops/move-folder` | editor | `{from, to}` rename/move a folder; links to moved notes are rewritten |
| DELETE | `/folders/{path}` | editor | delete an empty folder (`not_empty` otherwise) |
| POST | `/ops/fork` | viewer | `{name, folder?}` → copies the vault (or a top folder) into a new vault owned by the caller; refused with `copy_disabled` if the owner turned it off |
| GET | `/history?path=` · `/revisions/:rev` | viewer | |
| POST | `/proposals` | editor | `{path, content \| append, baseRev?, message}` → pending proposal. Tokens with the `propose` scope may call only this write endpoint |
| GET | `/proposals?status=` · `/proposals/:id` | viewer | list / details (proposal, `current`, `base`) |
| POST | `/proposals/:id/accept` · `/reject` | editor | needs a session or a `write` token; accept applies the change with the usual merge (409 on a real conflict) |
| GET | `/trash` · POST `/ops/restore-trash` | editor | deleted notes and `{id}` to restore one |
| DELETE | `/api/vaults/:v?confirm=<id>` | owner | moves the whole vault to `<data>/.trash` |
| GET | `/activity?limit=` | viewer | recent changes of the whole vault (who, what, when); writes made with an API token appear as `user(api:token name)`, so several agents can be told apart |
| GET | `/search?q=&limit=` | viewer | `"phrase"`, `tag:x`, `path:x` |
| GET | `/graph` | viewer | `q, tag, folder, orphans, unresolved, tags, center, depth` → `{nodes, edges}` |
| GET | `/tags` | viewer | |
| GET | `/context?q=&budget=&limit=` | viewer | LLM-ready pack `{notes, text}` |
| GET | `/chunks?maxChars=&path=` | viewer | RAG chunks with heading paths |
| GET | `/export?format=json\|jsonl` | viewer | |
| GET | `/verify` | owner | integrity report |
| POST/GET | `/files/{path}` | editor/viewer | attachments (raw body, 25 MB) |
| GET | `/events` | viewer | SSE: `change`, `presence` |
| PATCH | `/api/vaults/:v` | owner | `{name, description, allowCopy}` (`allowCopy:false` blocks export and fork for non-owners) |
| PUT/DELETE | `/members/:username` | owner | `{role: viewer\|editor\|owner}` |

## Concurrency contract
`rev` = SHA-256 of the note. A write with a stale `baseRev` is merged server-side; otherwise `409`:
```json
{ "error": { "code": "conflict", "current": {"rev":"…","content":"…"}, "yours": "…", "mergedWithMarkers": "…" } }
```
Other codes: `base_rev_required`, `note_deleted`, `invalid_path`, `too_large`, `forbidden`.
