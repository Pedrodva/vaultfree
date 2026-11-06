# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [0.1.0] — first public release

### Added
- Markdown vaults stored as plain files; wikilinks, embeds, nested tags, frontmatter, backlinks, rename with link rewriting
- Obsidian-style graph view (hover highlight, zoom/pan/drag, filters, groups, forces) and a local graph per note
- Nested folders (including empty ones) with drag & drop, rename/move and delete
- Multi-user: accounts, roles (viewer/editor/owner), live updates, presence, version history with restore
- Three-way merge on save, so concurrent edits are never overwritten
- Invite links (read or edit, optional expiry), copy-vault-to-my-own, owner control over copy/export
- REST API, scoped tokens, MCP server over stdio and HTTP, `/context`, `/chunks`, JSONL export, `/llms.txt`
- Integrity: content-addressed history, hash-chained audit log, `vaultfree verify`
- Docker image and compose file (solo, LAN, automatic HTTPS with Caddy, optional Cloudflare tunnels)
- English and Spanish interface
