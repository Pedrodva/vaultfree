export const LLMS_TXT = `# VaultFree

> Self-hosted, multi-user Markdown knowledge base with a link graph. Notes are plain .md files with [[wikilinks]], #tags and YAML frontmatter.

## Authentication
Send \`Authorization: Bearer vf_...\` (create a token in the UI: Account -> API tokens). Scopes: read, write.

## Core endpoints (all under /api/vaults/{vault})
- GET  /notes                      list notes (path,title,tags,rev,mtime)
- GET  /notes/{path}               read a note: content, rev, links, backlinks, headings
- PUT  /notes/{path}               {content, baseRev}  update (baseRev = rev you read; omit only when creating)
- POST /ops/append                 {path, text}        append safely, no conflicts
- POST /ops/rename                 {from, to}          rename and rewrite incoming [[links]]
- DELETE /notes/{path}?baseRev=    move to trash
- GET  /search?q=                  full text; supports "phrase", tag:x, path:folder
- GET  /graph?center={path}&depth=2  link graph (nodes, edges)
- GET  /context?q=&budget=12000    LLM-ready context pack of the most relevant notes
- GET  /chunks?maxChars=1500       RAG-ready chunks with heading paths
- GET  /export?format=jsonl        full export
- GET  /history?path=              revisions;  POST /ops/restore {path, rev}

## Concurrency
Every note has a \`rev\` (sha-256 of its content). Updates send \`baseRev\`. If the note changed meanwhile the server three-way merges;
on a real conflict it returns HTTP 409 with \`current\`, \`yours\` and \`mergedWithMarkers\` - re-read, reconcile, retry. Nothing is silently overwritten.

## MCP
Run \`vaultfree mcp --url <server> --token <vf_token>\` to expose these as Model Context Protocol tools.
`;
