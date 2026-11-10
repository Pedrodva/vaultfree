# Architecture

VaultFree is a small system on purpose: one Node.js process, no database, no build step, no runtime dependencies. This document explains how it fits together and, more importantly, **why** it is built this way and what it costs.

- [The big picture](#the-big-picture)
- [Storage: why files and not a database](#storage-why-files-and-not-a-database)
- [Concurrency: why three-way merge and not a CRDT](#concurrency-why-three-way-merge-and-not-a-crdt)
- [Integrity: history, audit chain, verify](#integrity-history-audit-chain-verify)
- [Editing outside the app](#editing-outside-the-app)
- [AI integration: tokens, MCP and proposals](#ai-integration-tokens-mcp-and-proposals)
- [Security model](#security-model)
- [Indexing, search and the graph](#indexing-search-and-the-graph)
- [Frontend](#frontend)
- [Why zero dependencies](#why-zero-dependencies)
- [Known limits and trade-offs](#known-limits-and-trade-offs)
- [Testing](#testing)

## The big picture

```
 Browser (vanilla ES modules, canvas graph)        AI clients (Claude, Cursor, scripts)
        │  cookie session                                   │  Bearer vf_… token
        │  REST + SSE                                       │  REST  /  MCP (stdio or HTTP)
        ▼                                                   ▼
 ┌──────────────────────────── server/app.js ─────────────────────────────┐
 │ router · auth gate · CSRF (Origin) · token scopes · demo guard rails    │
 └───────┬───────────────┬───────────────────────┬─────────────────────────┘
         │               │                       │
   server/auth.js   server/vaults.js        server/mcp.js ──(calls the REST API
   users, sessions, VaultManager:            tools → HTTP     with the caller's
   tokens, invites  roles, fork, trash       against itself)  own token)
   (auth.json)           │
                         ▼
                  server/vault.js  ←── shared/merge.js, parse.js, resolve.js
                  one instance per vault   (also loaded by the browser)
                  ├─ per-note mutex
                  ├─ in-memory index (server/indexer.js): links, search, graph
                  └─ disk:  <vault>/*.md              ← your notes, plain Markdown
                            <vault>/.vaultfree/       ← history, trash, audit, proposals
```

Three ideas drive everything:

1. **The files are the source of truth.** The in-memory index is rebuilt from disk at startup and reconciled with disk before every operation.
2. **Every write names the version it started from** (`baseRev`). The server can therefore tell a lost update from a normal one and fix it.
3. **AI agents are ordinary collaborators** that go through the same permission and merge path as people, with an extra, safer way to participate (proposals).

## Storage: why files and not a database

A vault is a folder of `.md` files plus a hidden `.vaultfree/` directory:

```
.vaultfree/
├── vault.json        name, members and roles, settings
├── objects/ab/<sha>  every version ever saved, addressed by SHA-256 of its content
├── history/<note>.jsonl   one line per change: time, rev, user, operation
├── trash/            deleted notes (restorable)
├── proposals.json    pending/decided agent proposals
└── audit.log         hash-chained log of every operation
```

**Why files**

- *No lock-in.* Open the same folder in Obsidian, edit it with git, back it up with `cp`. The product's promise ("your notes stay yours") is structural, not a policy.
- *Debuggable.* Everything is readable with `cat`. There is no schema to migrate.
- *Free tooling.* Backups, `grep`, syncing and version control already exist.

**What it costs**

- No cross-note transactions. A rename that rewrites links in many notes is a sequence of single-file writes, not one atomic step (see [limits](#known-limits-and-trade-offs)).
- The whole vault index lives in memory. That is fine for thousands of notes; it is not designed for millions.
- Writes use write-to-temp-then-rename (`_atomic`), so a crash never leaves a half-written note.

**Revisions are content hashes.** `rev = sha256(content)`. Two identical contents always have the same rev, equality checks are trivial, and the object store de-duplicates for free.

## Concurrency: why three-way merge and not a CRDT

The requirement: several people and AI agents can edit the same note and **nobody's work is lost**.

The protocol (`server/vault.js`, `write`):

1. `GET note` returns `{content, rev}`.
2. `PUT note {content, baseRev: rev}`.
3. Under a per-note mutex, the server first reconciles with disk, then compares `baseRev` with the current rev:
   - Same → store it.
   - Different → load the base version from the object store and run `merge3(base, yours, current)` (`shared/merge.js`, a line-based diff3).
     - Non-overlapping edits merge cleanly: the save succeeds and the response says `merged: true`.
     - Overlapping edits → `409 conflict` carrying `current`, `yours` and `mergedWithMarkers`. The UI offers *keep mine / use theirs / merge manually*. **Nothing is ever silently overwritten.**
   - Missing `baseRev` on an existing note → `409 base_rev_required`. A client cannot overwrite blindly by forgetting it.
4. `POST /ops/append` never conflicts, so agents can log and capture without reading first.

**Why not a CRDT / operational transform?**

| | Merge on save (chosen) | CRDT (e.g. Yjs) |
|---|---|---|
| Fits the data model | Yes: notes are plain files, a save produces plain text | No: needs a CRDT document per note, and the file becomes a derived artifact |
| Obsidian/git interoperability | Native | Breaks the "files are the truth" promise |
| Real-time character-level co-editing | No | Yes |
| Complexity and dependencies | ~75 lines, zero deps | Large; needs a sync server and persistence |
| Failure mode | Explicit conflict the user can see | Silent merge that can interleave text oddly |

Merge-on-save is the right trade for a knowledge base where people mostly edit different notes or different parts of one, and where agents write in bursts. Live co-editing is on the roadmap as an *addition* for the open note, not a replacement for the file model.

`diffLines` and `merge3` fall back to "conflict" instead of guessing when a diff would exceed a cell budget (`MAX_CELLS`), so pathological inputs cannot hang the server or produce wrong merges.

## Integrity: history, audit chain, verify

- **History.** Every stored version goes into the content-addressed object store and is appended to the note's `history/*.jsonl`. Any revision can be read or restored, and merges need only the base rev to find their common ancestor.
- **Audit log.** `server/audit.js` appends one JSON line per operation and links each record to the previous one:

  ```
  record = { ts, user, action, path, rev, …, prev: <hash of previous record> }
  hash   = sha256(JSON.stringify(record))
  ```

  Editing, deleting or reordering any line breaks the chain from that point on. This is a tamper-*evident* log (not tamper-proof: someone with disk access can rewrite the whole chain, so for strong guarantees ship the latest hash somewhere else).
- **`vaultfree verify`** (and `GET /verify`) re-hashes every note on disk and compares it with the indexed revision (catching missing or silently modified files), re-hashes every stored object against its file name (catching corruption), and walks the audit chain. It is a cheap, meaningful health check.

## Editing outside the app

Because notes are plain files, someone can change them behind the server's back (Obsidian, git pull, a sync client).

- `fs.watch` (recursive, debounced) picks changes up while the server runs.
- Independently, **every operation first calls `_sync(path)` under the note's lock**, which re-reads the file and reconciles the index. So even if the watcher misses an event (or the platform does not support recursive watching), a save can never merge against stale state.
- External changes are recorded in history and the audit log as user `external`, and broadcast to connected clients.

## AI integration: tokens, MCP and proposals

**Tokens** (`vf_…`) belong to a user and carry scopes: `read`, `write`, `propose`, optionally limited to certain vaults. Only a hash is stored; the secret is shown once. A token can never exceed its owner's role in a vault.

**Attribution.** Writes made with a token are recorded as `user(api:token name)`, so the Activity panel can tell "research agent" from "docs bot".

**MCP** is implemented twice from one handler (`server/mcp.js`):

- **stdio** (`vaultfree mcp`): for Claude Desktop and similar clients.
- **HTTP** (`POST /mcp`): Streamable-HTTP-style JSON-RPC. Bearer tokens only (cookies are rejected, which also removes CSRF risk from this endpoint).

The MCP layer is deliberately a *thin adapter*: each tool call becomes an authenticated request against the server's own REST API using the caller's token. That means there is a single enforcement point for permissions, scopes, conflict handling and audit, and nothing in MCP can do more than REST can. The HTTP endpoint skips the global "write scope required" gate and relies on each inner REST call being checked individually, so a read-only token can search but not write.

**Proposals: "agents propose, people approve."** A token with `read + propose` cannot modify notes. It can only `POST /proposals` with new content (or an append) and a message. The proposal is stored with the revision it was based on. A person sees a coloured diff and:

- **Accepts** → the change is applied through the normal `write` path, so if the note changed meanwhile it is *merged* (or a conflict is reported) rather than blindly applied.
- **Dismisses** → nothing changes.

This is the answer to "how do I let an AI touch my notes without trusting it": it can read everything and suggest anything, but a human is the only writer.

## Security model

| Concern | Measure |
|---|---|
| Passwords | scrypt with per-user salt; minimum length; constant-time compare |
| Sessions | random 256-bit tokens, only the hash is stored; HttpOnly + SameSite=Lax cookies; `Secure` over HTTPS; 90-day sliding expiry |
| CSRF | state-changing cookie requests must carry a same-origin `Origin` header; bearer-token requests are not cookie-authenticated, so they are immune |
| Brute force | login throttling per IP+username (and per user for password changes) |
| Tokens and invites | stored hashed, shown once, revocable; invites can expire and are use-limited |
| XSS | the Markdown renderer escapes by default and builds DOM from a small allow-list; strict CSP; uploaded SVGs are served with a sandbox CSP and non-images as downloads |
| Path traversal | every path is normalised and checked to stay inside the vault root; symlinks are ignored |
| Sign-up | closed by default; first user becomes admin; others join by invite or admin |
| Container | runs as a non-root user |
| Public demo | throwaway accounts cannot create vaults, upload files, invite, copy or reach admin features; request and note size are capped (see [DEPLOYMENT](DEPLOYMENT.md#public-demo-mode)) |

The renderer is hand-written (no dependency), which is a risk in itself. It is mitigated by escaping everything by default and by tests that feed it hostile input (`test/hardening.test.js`).

## Indexing, search and the graph

`server/indexer.js` keeps one in-memory index per vault:

- parsed notes (frontmatter, headings, tags, links, embeds), updated on every write;
- a **link resolver** shared with the browser (`shared/resolve.js`) that follows Obsidian's rules (shortest unique path, aliases, headings) so server and client agree on what a link points to;
- an inverted index for **full-text search** with accent folding and operators (`"phrase"`, `tag:`, `path:`);
- the **graph** (nodes, edges, optional unresolved links and tags, local neighbourhoods by depth);
- **LLM-oriented views**: `/context` builds a token-budgeted pack of the most relevant notes, `/chunks` splits notes by heading for RAG.

Semantic (embedding) search is not implemented; it is the first roadmap item.

## Frontend

- **No framework, no bundler.** ES modules served as static files; the browser loads `shared/` directly, so merge and link resolution run identically on both sides (the editor can merge locally when it receives a remote change to the open note).
- **The graph** is a canvas force simulation with a Barnes-Hut quadtree (`web/js/graph.js`) so repulsion is O(n log n) instead of O(n²), plus extra forces for collection "islands". Colour can encode collection or freshness.
- **Live updates** use Server-Sent Events (`/events`): one-way, auto-reconnecting, works through plain HTTP proxies, and is all that is needed (client → server goes through ordinary requests). Presence ("who is online") rides on the same stream.
- **i18n:** UI labels are translated (English/Spanish) through a small dictionary; explanations stay in English.

## Why zero dependencies

- **Supply-chain surface is a feature to minimise** in a self-hosted tool that holds people's knowledge. There is nothing to audit but this repository and Node itself.
- **Install is `docker run` or `node bin/vaultfree.js`**: no `npm install`, no build, no native modules.
- It forces simple designs (the merge, the router and the auth are each a few hundred lines).

The cost is real: things like HTTP routing, Markdown rendering and the MCP protocol are implemented in-house and need their own tests. Dev tooling (if added) would live in `devDependencies` only, keeping the runtime at zero.

## Known limits and trade-offs

- **Line-based merge.** Two people editing the *same line* get a conflict, and moving a paragraph while someone edits it can conflict. A CRDT or a structure-aware merge would do better at the price of the file model.
- **Multi-file operations are not atomic.** Renaming a note rewrites links in other notes one file at a time; a crash in the middle leaves a mix of old and new links (each file is still individually consistent, and history lets you restore).
- **Single process, single node.** Locks and presence live in memory. Running several replicas against the same data directory is not supported.
- **Scale.** The index is in memory and `search` scans an inverted index in-process; fine for personal and team vaults, untested at very large scale.
- **Audit log is tamper-evident, not tamper-proof** (see above).
- **Auth.** Local accounts only; OAuth for remote MCP clients and SSO are not implemented.
- **Attachments** are stored as files and not versioned.

## Testing

`npm test` runs the Node built-in test runner (no dependencies) with suites for parsing, merge, vault operations, the HTTP API, auth, invites, folders, forking, activity, account management, proposals, external edits, XSS, MCP over HTTP, and a **real `vaultfree mcp` process over stdio** talking to a live server. CI runs everything on Linux and Windows with Node 20 and 22 and builds the Docker image.

There are no browser-level UI tests yet; the UI was verified manually. Adding a few end-to-end tests (Playwright, as a dev-only dependency) is the most valuable next testing step.
