// Starter notes: a small interlinked graph so the graph view is alive on first run.
export const WELCOME_NOTES = {
  'Welcome.md': `---
tags: [start]
---
# Welcome to VaultFree

VaultFree is an open-source, self-hosted knowledge base. Your notes are plain Markdown files.

- Link notes with [[Wikilinks]] — see [[Graph View]] to visualise them.
- Organise with \`#tags\` and [[Projects/Roadmap|folders]].
- Several people and AI agents can edit at once: see [[Collaboration]] and [[AI Integration]].

Press **Ctrl+O** to jump to a note, **Ctrl+G** for the graph, **Ctrl+P** for commands.
`,
  'Wikilinks.md': `# Wikilinks

Type \`[[\` to link to another note. Links create **backlinks** automatically.
Use \`[[Note#Heading|alias]]\` for sections and custom text. Back to [[Welcome]].

Links to notes that don't exist yet, like [[Future idea]], show as unresolved nodes in the [[Graph View]].
`,
  'Graph View.md': `---
tags: [feature]
---
# Graph View

Every note is a node, every link an edge. Hover a node to highlight its neighbours, drag to rearrange, scroll to zoom.
Filter by \`#tags\`, folders or search. The local graph in the side panel shows the neighbours of the open note.

Related: [[Wikilinks]], [[Welcome]].
`,
  'Collaboration.md': `---
tags: [feature, team]
---
# Collaboration

Every save carries the revision you started from. If someone else changed the note meanwhile,
VaultFree performs a **three-way merge** so nobody's work is lost; real conflicts are shown to you instead of overwritten.
Full version history is kept: restore any revision. See [[AI Integration]].
`,
  'AI Integration.md': `---
tags: [feature, ai]
---
# AI Integration

- REST API with scoped tokens (\`/llms.txt\` documents it for agents)
- Built-in **MCP server**: \`vaultfree mcp\`
- \`/context\` returns an LLM-ready context pack, \`/chunks\` returns RAG-ready chunks

AI agents write through the same conflict-safe path as humans. See [[Collaboration]] and [[Projects/Roadmap]].
`,
  'Projects/Roadmap.md': `---
tags: [project]
---
# Roadmap

- [x] Markdown vaults, wikilinks, backlinks
- [x] Graph view
- [x] Multi-user, merge-on-save
- [ ] Semantic search (embeddings)
- [ ] Plugins

Part of [[Welcome]]. Uses ideas from [[AI Integration]].
`,
};
