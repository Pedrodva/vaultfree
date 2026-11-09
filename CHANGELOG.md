# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [0.1.0] — first public release

### Added
- Public demo mode (`VAULTFREE_DEMO=true`): one-click throwaway sandbox vaults with sample notes and a pending agent proposal, guard rails for public servers, automatic erasure; one-click Render deploy (`render.yaml`)
- Markdown vaults stored as plain files; wikilinks, embeds, nested tags, frontmatter, backlinks, rename with link rewriting
- Writes and proposals made with an API token are attributed to the token's name (`user(api:token name)`), so several agents are told apart in the feed and in proposals
- Import files or a whole folder (e.g. an Obsidian vault) from the file panel or by drag and drop; existing notes are skipped, hidden folders are ignored
- End-to-end test of the real `vaultfree mcp` process over stdio
- Agent proposals: tokens with a `propose` scope cannot write, they leave a pending change (update, new note or append); people review a diff in the Activity panel and accept (merged safely) or dismiss; MCP tools `vaultfree_propose_change` and `vaultfree_list_proposals`
- The map note card can be dragged, resized, minimized and scrolled
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
