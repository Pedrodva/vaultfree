# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [0.1.0] — first public release

### Added
- Markdown vaults stored as plain files; wikilinks, embeds, nested tags, frontmatter, backlinks, rename with link rewriting
- Trash dialog to restore deleted notes, account dialog to change your password, admin password reset, vault rename and delete (to the server trash)
- The map is the home screen: collections as islands, collection dock, search, floating note preview on click, colour by collection or freshness, radial "orbit" local graph
- Map / Document switch in the top bar and an Activity panel (recent changes, automatic merges, writes made through API tokens marked `API`, who is online) updated live; `GET /activity` endpoint
- Resizable and collapsible side panels (drag the edge, double-click to reset; remembered) and a compact, collapsible graph settings panel
- Graph view in a "Constellation" style (small stars, halos and labels on hubs; classic style optional) with hover highlight, zoom/pan/drag, filters, groups, forces, auto-fit, and a local graph per note
- Nested folders (including empty ones) with drag & drop, rename/move and delete
- Multi-user: accounts, roles (viewer/editor/owner), live updates, presence, version history with restore
- Three-way merge on save, so concurrent edits are never overwritten
- Invite links (read or edit, optional expiry), copy-vault-to-my-own, owner control over copy/export
- REST API, scoped tokens, MCP server over stdio and HTTP, `/context`, `/chunks`, JSONL export, `/llms.txt`
- Integrity: content-addressed history, hash-chained audit log, `vaultfree verify`
- Docker image and compose file (solo, LAN, automatic HTTPS with Caddy, optional Cloudflare tunnels)
- English and Spanish interface
- Edits made outside VaultFree (Obsidian, git) are detected and merged instead of overwritten; read-only tokens work with the MCP endpoint
- Regression tests for XSS in the Markdown renderer
