// In-memory index of one vault: metadata, link graph, full-text search.
import { parseNote, isAttachmentTarget, slugify } from '../shared/parse.js';
import { createResolver } from '../shared/resolve.js';

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const tokenize = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export class VaultIndex {
  constructor() {
    this.notes = new Map(); // path -> meta (+content, rev, mtime, size)
    this.postings = new Map(); // term -> Map(path -> tf)
    this.docTerms = new Map(); // path -> Set(term)
    this.dirty = true;
    this._g = null;
  }

  set(path, { content, rev, mtime }) {
    const meta = parseNote(path, content);
    Object.assign(meta, { content, rev, mtime, size: Buffer.byteLength(content) });
    this.unindexTerms(path);
    this.notes.set(path, meta);
    const tf = new Map();
    for (const t of tokenize(meta.title + ' ' + meta.aliases.join(' ') + ' ' + path + ' ' + content)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      if (!this.postings.has(t)) this.postings.set(t, new Map());
      this.postings.get(t).set(path, n);
    }
    this.docTerms.set(path, new Set(tf.keys()));
    this.dirty = true;
  }

  unindexTerms(path) {
    for (const t of this.docTerms.get(path) || []) {
      const p = this.postings.get(t);
      p?.delete(path);
      if (p && !p.size) this.postings.delete(t);
    }
    this.docTerms.delete(path);
  }

  remove(path) {
    this.unindexTerms(path);
    this.notes.delete(path);
    this.dirty = true;
  }

  paths() { return [...this.notes.keys()].sort(); }
  resolver() { return this._graph().resolve; }

  _graph() {
    if (!this.dirty && this._g) return this._g;
    const resolve = createResolver(this.paths());
    const out = new Map(), back = new Map(), unresolved = new Map();
    for (const p of this.notes.keys()) { out.set(p, new Set()); back.set(p, new Set()); unresolved.set(p, new Set()); }
    for (const [p, m] of this.notes) {
      for (const l of m.links) {
        if (!l.target || isAttachmentTarget(l.target)) continue;
        const r = resolve(l.target, p);
        if (r && r !== p) { out.get(p).add(r); back.get(r).add(p); }
        else if (!r) unresolved.get(p).add(l.target.replace(/\.md$/i, ''));
      }
    }
    this._g = { resolve, out, back, unresolved };
    this.dirty = false;
    return this._g;
  }

  summary(p) {
    const m = this.notes.get(p);
    return m && { path: p, title: m.title, folder: m.folder, tags: m.tags, rev: m.rev, mtime: m.mtime, size: m.size, words: m.words };
  }

  list() { return this.paths().map((p) => this.summary(p)); }

  details(p) {
    const m = this.notes.get(p);
    if (!m) return null;
    const g = this._graph();
    return {
      ...this.summary(p),
      frontmatter: m.frontmatter,
      headings: m.headings,
      links: [...g.out.get(p)].map((x) => ({ path: x, title: this.notes.get(x).title })),
      unresolved: [...g.unresolved.get(p)],
      backlinks: this.backlinks(p),
    };
  }

  backlinks(p) {
    const g = this._graph();
    return [...(g.back.get(p) || [])].sort().map((src) => {
      const m = this.notes.get(src);
      const name = p.split('/').pop().replace(/\.md$/i, '').toLowerCase();
      const line = m.content.split('\n').find((l) => l.toLowerCase().includes('[[') && l.toLowerCase().includes(name)) || '';
      return { path: src, title: m.title, context: line.trim().slice(0, 240) };
    });
  }

  tags() {
    const counts = new Map();
    for (const m of this.notes.values()) {
      const seen = new Set();
      for (const t of m.tags) {
        const parts = t.split('/');
        for (let i = 1; i <= parts.length; i++) seen.add(parts.slice(0, i).join('/'));
      }
      for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  hasTag(m, tag) {
    const t = tag.replace(/^#/, '').toLowerCase();
    return m.tags.some((x) => { const l = x.toLowerCase(); return l === t || l.startsWith(t + '/'); });
  }

  search(query, { limit = 20 } = {}) {
    const phrases = [], tagsF = [], pathsF = [], terms = [];
    const rest = query.replace(/"([^"]+)"/g, (_, ph) => { phrases.push(fold(ph)); return ' '; })
      .replace(/\btag:#?(\S+)/gi, (_, t) => { tagsF.push(t); return ' '; })
      .replace(/\bpath:(\S+)/gi, (_, t) => { pathsF.push(fold(t)); return ' '; });
    terms.push(...tokenize(rest));
    const N = this.notes.size || 1;
    const scores = new Map();
    const lastIdx = terms.length - 1;
    terms.forEach((term, ti) => {
      let keys = [term];
      if (ti === lastIdx && term.length >= 2) keys = [...this.postings.keys()].filter((k) => k.startsWith(term)).slice(0, 50);
      for (const k of keys) {
        const post = this.postings.get(k);
        if (!post) continue;
        const idf = Math.log(1 + N / post.size);
        for (const [p, tf] of post) {
          const m = this.notes.get(p);
          let s = idf * (tf / (tf + 1.2)) * (k === term ? 1 : 0.6);
          if (tokenize(m.title).includes(k)) s *= 3;
          scores.set(p, (scores.get(p) || 0) + s);
        }
      }
    });
    let cands;
    if (terms.length) cands = [...scores.keys()];
    else cands = this.paths();
    const hits = [];
    for (const p of cands) {
      const m = this.notes.get(p);
      if (tagsF.some((t) => !this.hasTag(m, t))) continue;
      if (pathsF.some((x) => !fold(p).includes(x))) continue;
      const lower = fold(m.content);
      if (phrases.some((ph) => !lower.includes(ph))) continue;
      hits.push({ p, score: (scores.get(p) || 0) + phrases.length, lower });
    }
    hits.sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
    return hits.slice(0, limit).map(({ p, score, lower }) => {
      const m = this.notes.get(p);
      const needles = [...phrases, ...terms];
      let at = -1;
      for (const n of needles) { at = lower.indexOf(n); if (at >= 0) break; }
      const from = Math.max(0, at - 70);
      const snippet = at < 0 ? m.content.slice(0, 160) : m.content.slice(from, at + 130);
      return { ...this.summary(p), score: Math.round(score * 1000) / 1000, snippet: snippet.replace(/\s+/g, ' ').trim() };
    });
  }

  /** Graph for the UI. Options: q, tag, folder, orphans, unresolved, tags, center, depth */
  graph({ q = '', tag = '', folder = '', orphans = true, unresolved = false, tags = false, center = '', depth = 1 } = {}) {
    const g = this._graph();
    let allowed = new Set(this.notes.keys());
    if (q) { const hit = new Set(this.search(q, { limit: 5000 }).map((h) => h.path)); allowed = new Set([...allowed].filter((p) => hit.has(p))); }
    if (tag) allowed = new Set([...allowed].filter((p) => this.hasTag(this.notes.get(p), tag)));
    if (folder) allowed = new Set([...allowed].filter((p) => p === folder || p.startsWith(folder.replace(/\/?$/, '/'))));

    const edgeMap = new Map();
    const addEdge = (a, b) => {
      const k = a < b ? `${a}\0${b}` : `${b}\0${a}`;
      const e = edgeMap.get(k);
      if (e) { if (e.source === b && e.target === a) e.mutual = true; } else edgeMap.set(k, { source: a, target: b });
    };
    for (const [p, outs] of g.out) {
      if (!allowed.has(p)) continue;
      for (const t of outs) if (allowed.has(t)) addEdge(p, t);
      if (unresolved) for (const u of g.unresolved.get(p)) addEdge(p, 'unresolved:' + u.toLowerCase());
    }
    if (tags) for (const p of allowed) for (const t of this.notes.get(p).tags) addEdge(p, 'tag:#' + t);

    let keep = null;
    if (center && this.notes.has(center)) {
      keep = new Set([center]);
      let frontier = [center];
      const adj = new Map();
      for (const e of edgeMap.values()) {
        (adj.get(e.source) || adj.set(e.source, []).get(e.source)).push(e.target);
        (adj.get(e.target) || adj.set(e.target, []).get(e.target)).push(e.source);
      }
      for (let d = 0; d < Math.max(1, Math.min(depth, 6)); d++) {
        const next = [];
        for (const n of frontier) for (const x of adj.get(n) || []) if (!keep.has(x)) { keep.add(x); next.push(x); }
        frontier = next;
      }
    }

    const deg = new Map();
    const edges = [];
    for (const e of edgeMap.values()) {
      if (keep && !(keep.has(e.source) && keep.has(e.target))) continue;
      edges.push(e);
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
    }
    const nodes = [];
    for (const p of allowed) {
      if (keep && !keep.has(p)) continue;
      const d = deg.get(p) || 0;
      if (!orphans && d === 0 && p !== center) continue;
      const m = this.notes.get(p);
      nodes.push({ id: p, label: m.title, type: 'note', folder: m.folder, tags: m.tags, degree: d, words: m.words, mtime: m.mtime });
    }
    for (const id of deg.keys()) {
      if (id.startsWith('unresolved:')) nodes.push({ id, label: id.slice(11), type: 'unresolved', degree: deg.get(id) });
      else if (id.startsWith('tag:#')) nodes.push({ id, label: id.slice(4), type: 'tag', degree: deg.get(id) });
    }
    return { nodes, edges, total: this.notes.size };
  }

  /** Split notes into retrieval-friendly chunks (for RAG pipelines). */
  chunks({ maxChars = 1500, path = '' } = {}) {
    const out = [];
    for (const [p, m] of this.notes) {
      if (path && p !== path) continue;
      const lines = m.content.split('\n');
      let startLine = 0;
      const fmEnd = /^---[ \t]*$/.test(lines[0] || '') ? lines.slice(1).findIndex((l) => /^---[ \t]*$/.test(l)) + 2 : 0;
      startLine = Math.max(0, fmEnd);
      const stack = [];
      let buf = [], bufHead = [], inFence = false, n = 0;
      const emit = () => {
        const text = buf.join('\n').trim();
        buf = [];
        if (!text) return;
        for (let i = 0; i < text.length; i += maxChars) {
          const piece = text.slice(i, i + maxChars);
          out.push({ id: `${p}#${n++}`, path: p, title: m.title, headings: [...bufHead], text: piece, tags: m.tags, rev: m.rev });
        }
      };
      for (let i = startLine; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
        const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*$/.exec(l);
        if (h) {
          emit();
          stack.length = h[1].length - 1;
          stack[h[1].length - 1] = h[2];
          bufHead = stack.filter(Boolean);
        }
        buf.push(l);
        if (buf.join('\n').length > maxChars * 1.5 && !inFence && l.trim() === '') emit();
      }
      emit();
    }
    return out;
  }

  /** Pack the most relevant notes + neighbours into an LLM-ready context block. */
  context(query, { budget = 12000, limit = 5 } = {}) {
    const hits = this.search(query, { limit });
    const g = this._graph();
    let used = 0;
    const notes = [];
    for (const h of hits) {
      const m = this.notes.get(h.path);
      const room = budget - used;
      if (room < 200) break;
      const body = m.content.length > room ? m.content.slice(0, room) + '\n…[truncated]' : m.content;
      used += body.length;
      notes.push({
        path: h.path, title: m.title, rev: m.rev, score: h.score, truncated: m.content.length > room, content: body,
        links: [...g.out.get(h.path)], backlinks: [...g.back.get(h.path)],
      });
    }
    const text = notes.map((n) => `## ${n.title} (${n.path})\n${n.content}`).join('\n\n---\n\n');
    return { query, notes, text, chars: used };
  }
}

export { slugify };
