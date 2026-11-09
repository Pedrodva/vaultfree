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

// Extra notes for public demo sandboxes: a small team knowledge base with several collections.
export const DEMO_NOTES = {
  'Try this first.md': `---
tags: [start]
---
# Try this first

This is your own sandbox: edit anything, nothing here is shared, and it is erased after a day.

1. Open the **Activity** panel: an AI agent ("research agent") proposed a change to [[Projects/Roadmap]]. Review the diff and accept or dismiss it.
2. Open [[Projects/Launch plan]] in two browser tabs, edit different lines in each and save: the edits are merged, nothing is lost.
3. Rename [[People/Ana]] — every link to her note is updated.
4. Press **Ctrl+G** for the map and click a collection in the dock.

Start from [[Welcome]].
`,
  'Projects/Launch plan.md': `---
tags: [project, team]
---
# Launch plan

Owner: [[People/Ana]] · Reviewer: [[People/Marco]]

- Announce on the blog, see [[Research/Positioning]]
- Demo for the [[Meetings/2026-11-03 Weekly|weekly meeting]]
- Agents draft release notes through [[AI Integration|proposals]]
`,
  'Research/Positioning.md': `---
tags: [research]
---
# Positioning

Self-hosted, plain Markdown, built for teams **and** AI agents.
Competitors keep notes in a database; we keep files you can open in any editor.
Interview notes: [[Research/User interviews]]. Feeds the [[Projects/Launch plan]].
`,
  'Research/User interviews.md': `---
tags: [research]
---
# User interviews

- "I want my agent to suggest edits, not overwrite my notes." → [[Collaboration]]
- "Our wiki is a black box; I want files." → [[Research/Positioning]]
- Run by [[People/Marco]].
`,
  'Research/Embeddings.md': `---
tags: [research, ai]
---
# Embeddings

Notes on adding semantic search to the [[Projects/Roadmap]]. Chunks from \`/chunks\` are already heading-aware, see [[AI Integration]].
`,
  'Meetings/2026-11-03 Weekly.md': `---
tags: [meeting]
---
# Weekly — 3 Nov

Present: [[People/Ana]], [[People/Marco]]

- Launch date agreed, see [[Projects/Launch plan]]
- Follow-up: record a short demo video
`,
  'Meetings/2026-10-27 Weekly.md': `---
tags: [meeting]
---
# Weekly — 27 Oct

- Reviewed [[Research/User interviews]]
- Decided to prioritise [[Research/Embeddings]] after launch
`,
  'People/Ana.md': `---
tags: [person]
---
# Ana

Product lead. Owns the [[Projects/Launch plan]].
`,
  'People/Marco.md': `---
tags: [person]
---
# Marco

Research. Ran the [[Research/User interviews]].
`,
};
