// A vault is a plain folder of Markdown files (openable directly in Obsidian)
// plus a hidden `.vaultfree/` folder holding history, trash, metadata and audit log.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { VaultFreeError, KeyedMutex, normalizePath, sha256 } from './util.js';
import { VaultIndex } from './indexer.js';
import { AuditLog } from './audit.js';
import { merge3 } from '../shared/merge.js';
import { replaceWikiLinks, isAttachmentTarget, ATTACHMENT_EXT, extOf } from '../shared/parse.js';
import { createResolver } from '../shared/resolve.js';

export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const fsp = fs.promises;

export class Vault extends EventEmitter {
  constructor(root, meta) {
    super();
    this.root = root;
    this.meta = meta; // {id,name,description,members:{userId:role},createdAt}
    this.kdir = path.join(root, '.vaultfree');
    this.index = new VaultIndex();
    this.locks = new KeyedMutex();
    this.files = new Set(); // attachment paths
    this.folders = new Set(); // every (possibly empty) folder, vault-relative
    this.audit = new AuditLog(path.join(this.kdir, 'audit.log'));
    this.setMaxListeners(200);
  }

  get id() { return this.meta.id; }

  static async create(root, meta) {
    await fsp.mkdir(path.join(root, '.vaultfree', 'objects'), { recursive: true });
    await fsp.mkdir(path.join(root, '.vaultfree', 'history'), { recursive: true });
    const v = new Vault(root, meta);
    await v.saveMeta();
    return v;
  }

  async saveMeta() {
    await this._atomic(path.join(this.kdir, 'vault.json'), JSON.stringify(this.meta, null, 2));
  }

  async load() {
    await fsp.mkdir(path.join(this.kdir, 'objects'), { recursive: true });
    await fsp.mkdir(path.join(this.kdir, 'history'), { recursive: true });
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { this.folders.add(r); await walk(path.join(dir, e.name), r); }
        else if (/\.md$/i.test(e.name)) {
          const content = await fsp.readFile(path.join(dir, e.name), 'utf8');
          const st = await fsp.stat(path.join(dir, e.name));
          const rev = sha256(content);
          this.index.set(r, { content, rev, mtime: st.mtimeMs });
          await this.putObject(rev, content);
        } else if (ATTACHMENT_EXT.has(extOf(e.name))) this.files.add(r);
      }
    };
    await walk(this.root, '');
    this.watch();
    return this;
  }

  abs(rel) {
    const full = path.resolve(this.root, ...rel.split('/'));
    if (!full.startsWith(this.root + path.sep)) throw new VaultFreeError(400, 'invalid_path', 'Path escapes the vault');
    return full;
  }

  async _atomic(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  }

  // ---- content-addressed object store (history / merge bases) ----
  objPath(rev) { return path.join(this.kdir, 'objects', rev.slice(0, 2), rev); }
  async putObject(rev, content) {
    const f = this.objPath(rev);
    if (fs.existsSync(f)) return;
    await this._atomic(f, content);
  }
  async getObject(rev) {
    if (typeof rev !== 'string' || !/^[0-9a-f]{64}$/.test(rev)) return null;
    try { return await fsp.readFile(this.objPath(rev), 'utf8'); } catch { return null; }
  }

  histFile(p) { return path.join(this.kdir, 'history', encodeURIComponent(p) + '.jsonl'); }
  async logHistory(p, entry) {
    await fsp.appendFile(this.histFile(p), JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  }
  async history(rawPath, limit = 100) {
    const p = normalizePath(rawPath);
    try {
      const lines = (await fsp.readFile(this.histFile(p), 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
    } catch { return []; }
  }

  // ---- reads ----
  async read(rawPath) {
    const p = normalizePath(rawPath);
    await this.locks.run(p, () => this._sync(p));
    const m = this.index.notes.get(p);
    if (!m) throw new VaultFreeError(404, 'not_found', `Note not found: ${p}`);
    return { ...this.index.details(p), content: m.content };
  }

  // ---- writes ----
  async write(rawPath, content, { baseRev = null, user = 'system', op = 'write' } = {}) {
    const p = normalizePath(rawPath);
    if (typeof content !== 'string') throw new VaultFreeError(400, 'invalid_content', 'content must be a string');
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new VaultFreeError(413, 'too_large', 'Note exceeds 2 MB');
    return this.locks.run(p, async () => {
      await this._sync(p);
      const cur = this.index.notes.get(p);
      let final = content, merged = false;
      if (cur) {
        if (baseRev == null) {
          throw new VaultFreeError(409, 'base_rev_required', 'Note exists: send baseRev (the rev you last read) to update it.', { current: { rev: cur.rev, content: cur.content } });
        }
        if (cur.rev !== baseRev) {
          const base = await this.getObject(baseRev);
          const conflictErr = (mergedText) => new VaultFreeError(409, 'conflict', 'The note changed since you read it and could not be merged automatically.',
            { current: { rev: cur.rev, content: cur.content }, yours: content, mergedWithMarkers: mergedText });
          if (base == null) throw conflictErr(null);
          const r = merge3(base, content, cur.content);
          if (r.conflict) throw conflictErr(r.text);
          final = r.text;
          merged = true;
        }
        if (final === cur.content) return { path: p, rev: cur.rev, content: final, merged, unchanged: true };
      } else if (baseRev != null) {
        throw new VaultFreeError(409, 'note_deleted', 'The note no longer exists.', { yours: content });
      }
      await this._store(p, final, user, merged ? 'merge' : op);
      return { path: p, rev: sha256(final), content: final, merged, created: !cur };
    });
  }

  /** Reconcile one note with the disk (edits made by Obsidian, git, a sync tool…). Call inside the path lock. */
  async _sync(p) {
    let disk = null;
    try { disk = await fsp.readFile(this.abs(p), 'utf8'); } catch { /* missing */ }
    const cur = this.index.notes.get(p);
    if (disk == null) {
      if (cur) { this.index.remove(p); await this.logHistory(p, { rev: cur.rev, user: 'external', op: 'delete' }); this.audit.append({ user: 'external', action: 'delete', path: p, rev: cur.rev }); this.emit('change', { type: 'delete', path: p, user: 'external' }); }
      return;
    }
    const rev = sha256(disk);
    if (cur && cur.rev === rev) return;
    await this.putObject(rev, disk);
    this.index.set(p, { content: disk, rev, mtime: Date.now() });
    this._addFolders(p);
    await this.logHistory(p, { rev, user: 'external', op: 'external' });
    this.audit.append({ user: 'external', action: 'external', path: p, rev });
    this.emit('change', { type: 'write', path: p, rev, user: 'external', op: 'external' });
  }

  /** Pick up changes made outside VaultFree while the server runs (best effort; operations also re-sync on demand). */
  watch() {
    try {
      const timers = new Map();
      this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_evt, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (rel.split('/').some((s) => s.startsWith('.')) || !/\.md$/i.test(rel)) return;
        clearTimeout(timers.get(rel));
        timers.set(rel, setTimeout(() => { timers.delete(rel); this.locks.run(rel, () => this._sync(rel)).catch(() => {}); }, 200));
      });
      this.watcher.on('error', () => {});
    } catch { /* recursive watching unsupported: on-demand sync still protects writes */ }
  }
  close() { this.watcher?.close(); }

  _addFolders(p, isFolder = false) {
    const parts = p.split('/');
    if (!isFolder) parts.pop();
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }
  listFolders() { return [...this.folders].sort((a, b) => a.localeCompare(b)); }
  _under(prefix, set) { return [...set].filter((x) => x === prefix || x.startsWith(prefix + '/')); }

  async mkdir(raw, { user = 'system' } = {}) {
    const p = normalizePath(raw, { note: false });
    await fsp.mkdir(this.abs(p), { recursive: true });
    this._addFolders(p, true);
    this.audit.append({ user, action: 'mkdir', path: p, rev: '' });
    this.emit('change', { type: 'folder', path: p, user });
    return { path: p };
  }

  /** Delete a folder tree only if it contains no notes or files. */
  async rmdir(raw, { user = 'system' } = {}) {
    const p = normalizePath(raw, { note: false });
    if (!this.folders.has(p)) throw new VaultFreeError(404, 'not_found', 'Folder not found');
    const pre = p + '/';
    if ([...this.index.notes.keys()].some((x) => x.startsWith(pre)) || [...this.files].some((x) => x.startsWith(pre))) {
      throw new VaultFreeError(409, 'not_empty', 'The folder still contains notes or files. Move or delete them first.');
    }
    for (const f of this._under(p, this.folders).sort((a, b) => b.length - a.length)) {
      try { await fsp.rmdir(this.abs(f)); } catch (e) { if (e.code === 'ENOTEMPTY') throw new VaultFreeError(409, 'not_empty', 'The folder contains other files.'); if (e.code !== 'ENOENT') throw e; }
      this.folders.delete(f);
    }
    this.audit.append({ user, action: 'rmdir', path: p, rev: '' });
    this.emit('change', { type: 'folder', path: p, user });
    return { path: p, deleted: true };
  }

  /** Rename/move a folder with everything inside; links to moved notes are rewritten. */
  async moveFolder(rawFrom, rawTo, { user = 'system' } = {}) {
    const from = normalizePath(rawFrom, { note: false }), to = normalizePath(rawTo, { note: false });
    if (from === to) return { from, to, moved: 0 };
    if (to.startsWith(from + '/')) throw new VaultFreeError(400, 'invalid_path', 'A folder cannot be moved into itself');
    if (!this.folders.has(from)) throw new VaultFreeError(404, 'not_found', 'Folder not found');
    const oldFolders = this._under(from, this.folders);
    const notes = [...this.index.notes.keys()].filter((x) => x.startsWith(from + '/'));
    const files = [...this.files].filter((x) => x.startsWith(from + '/'));
    const target = (x) => to + x.slice(from.length);
    for (const x of notes) if (this.index.notes.has(target(x))) throw new VaultFreeError(409, 'exists', `Target already exists: ${target(x)}`);
    for (const f of oldFolders) { await fsp.mkdir(this.abs(target(f)), { recursive: true }); this._addFolders(target(f), true); }
    for (const x of notes) await this.rename(x, target(x), { updateLinks: true, user });
    for (const x of files) {
      await fsp.mkdir(path.dirname(this.abs(target(x))), { recursive: true });
      await fsp.rename(this.abs(x), this.abs(target(x)));
      this.files.delete(x); this.files.add(target(x));
    }
    for (const f of oldFolders.sort((a, b) => b.length - a.length)) {
      try { await fsp.rmdir(this.abs(f)); this.folders.delete(f); } catch { /* keep folder if it still holds foreign files */ }
    }
    this.audit.append({ user, action: 'move-folder', path: to, from, rev: '' });
    this.emit('change', { type: 'folder', path: to, from, user });
    return { from, to, moved: notes.length + files.length };
  }

  async _store(p, content, user, op) {
    this._addFolders(p);
    const rev = sha256(content);
    await this._atomic(this.abs(p), content);
    await this.putObject(rev, content);
    await this.logHistory(p, { rev, user, op });
    this.index.set(p, { content, rev, mtime: Date.now() });
    this.audit.append({ user, action: op, path: p, rev });
    this.emit('change', { type: 'write', path: p, rev, user, op });
  }

  async append(rawPath, text, { user = 'system', createIfMissing = true } = {}) {
    const p = normalizePath(rawPath);
    return this.locks.run(p, async () => {
      await this._sync(p);
      const cur = this.index.notes.get(p);
      if (!cur && !createIfMissing) throw new VaultFreeError(404, 'not_found', `Note not found: ${p}`);
      const prev = cur ? cur.content : '';
      const sep = prev && !prev.endsWith('\n') ? '\n' : '';
      const final = prev + sep + text + (text.endsWith('\n') ? '' : '\n');
      if (Buffer.byteLength(final) > MAX_NOTE_BYTES) throw new VaultFreeError(413, 'too_large', 'Note exceeds 2 MB');
      await this._store(p, final, user, 'append');
      return { path: p, rev: sha256(final), created: !cur };
    });
  }

  async delete(rawPath, { baseRev = null, user = 'system' } = {}) {
    const p = normalizePath(rawPath);
    return this.locks.run(p, async () => {
      await this._sync(p);
      const cur = this.index.notes.get(p);
      if (!cur) throw new VaultFreeError(404, 'not_found', `Note not found: ${p}`);
      if (baseRev && baseRev !== cur.rev) throw new VaultFreeError(409, 'conflict', 'Note changed since you read it.', { current: { rev: cur.rev, content: cur.content } });
      const trash = path.join(this.kdir, 'trash', `${Date.now()}__${encodeURIComponent(p)}`);
      await fsp.mkdir(path.dirname(trash), { recursive: true });
      await fsp.rename(this.abs(p), trash);
      await this.logHistory(p, { rev: cur.rev, user, op: 'delete' });
      this.index.remove(p);
      this.audit.append({ user, action: 'delete', path: p, rev: cur.rev });
      this.emit('change', { type: 'delete', path: p, user });
      return { path: p, deleted: true };
    });
  }

  async restore(rawPath, rev, { user = 'system' } = {}) {
    const p = normalizePath(rawPath);
    const content = await this.getObject(rev);
    if (content == null) throw new VaultFreeError(404, 'not_found', 'Unknown revision');
    const cur = this.index.notes.get(p);
    return this.write(p, content, { baseRev: cur?.rev ?? null, user, op: 'restore' });
  }

  async rename(rawFrom, rawTo, { updateLinks = true, user = 'system' } = {}) {
    const from = normalizePath(rawFrom), to = normalizePath(rawTo);
    if (from === to) return { from, to, updated: [] };
    const [a, b] = [from, to].sort();
    return this.locks.run(a, () => this.locks.run(b, async () => {
      await this._sync(from);
      if (!this.index.notes.has(from)) throw new VaultFreeError(404, 'not_found', `Note not found: ${from}`);
      if (this.index.notes.has(to)) throw new VaultFreeError(409, 'exists', `Target already exists: ${to}`);
      const oldResolve = this.index.resolver();
      const referrers = updateLinks ? this.index.backlinks(from).map((x) => x.path) : [];
      const cur = this.index.notes.get(from);
      await fsp.mkdir(path.dirname(this.abs(to)), { recursive: true });
      await fsp.rename(this.abs(from), this.abs(to));
      this._addFolders(to);
      this.index.remove(from);
      this.index.set(to, { content: cur.content, rev: cur.rev, mtime: Date.now() });
      await this.logHistory(from, { rev: cur.rev, user, op: 'rename-from', to });
      await this.logHistory(to, { rev: cur.rev, user, op: 'rename-to', from });
      this.audit.append({ user, action: 'rename', path: to, from, rev: cur.rev });
      const updated = [];
      if (updateLinks) {
        const baseNew = to.split('/').pop().replace(/\.md$/i, '');
        const dup = this.index.paths().filter((x) => x.split('/').pop().replace(/\.md$/i, '').toLowerCase() === baseNew.toLowerCase()).length > 1;
        const newText = (old) => (old.includes('/') || dup ? to.replace(/\.md$/i, '') : baseNew);
        for (const r of new Set(referrers)) {
          const rp = r === from ? to : r;
          const done = await this.locks.run(rp === a || rp === b ? `${rp}#links` : rp, async () => {
            const m = this.index.notes.get(rp);
            if (!m) return false;
            const next = replaceWikiLinks(m.content, (l) => {
              if (!l.target || isAttachmentTarget(l.target)) return undefined;
              return oldResolve(l.target, r) === from ? newText(l.target) : undefined;
            });
            if (next === m.content) return false;
            await this._store(rp, next, user, 'relink');
            return true;
          });
          if (done) updated.push(rp);
        }
      }
      this.emit('change', { type: 'rename', path: to, from, user });
      return { from, to, updated };
    }));
  }

  // ---- attachments ----
  async saveFile(rawPath, buf, { user = 'system' } = {}) {
    let p = normalizePath(rawPath, { note: false });
    if (!ATTACHMENT_EXT.has(extOf(p))) throw new VaultFreeError(415, 'unsupported_type', 'File type not allowed');
    if (buf.length > MAX_FILE_BYTES) throw new VaultFreeError(413, 'too_large', 'File exceeds 25 MB');
    const hash = sha256(buf);
    const dot = p.lastIndexOf('.');
    for (let i = 1; ; i++) {
      const ex = this.files.has(p) ? await fsp.readFile(this.abs(p)) : null;
      if (!ex) break;
      if (sha256(ex) === hash) return { path: p, deduplicated: true };
      p = `${p.slice(0, dot).replace(/ \d+$/, '')} ${i}${p.slice(dot)}`;
    }
    await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
    const tmp = this.abs(p) + '.tmp';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, this.abs(p));
    this.files.add(p);
    this._addFolders(p);
    this.audit.append({ user, action: 'upload', path: p, rev: hash });
    this.emit('change', { type: 'file', path: p, user });
    return { path: p };
  }
  async readFile(rawPath) {
    const p = normalizePath(rawPath, { note: false });
    if (!this.files.has(p)) throw new VaultFreeError(404, 'not_found', 'File not found');
    return fsp.readFile(this.abs(p));
  }

  // ---- trash ----
  async listTrash() {
    let names = [];
    try { names = await fsp.readdir(path.join(this.kdir, 'trash')); } catch { return []; }
    const out = [];
    for (const id of names) {
      const m = /^(\d+)__(.+)$/.exec(id);
      if (!m) continue;
      try { out.push({ id, path: decodeURIComponent(m[2]), deletedAt: Number(m[1]) }); } catch { /* skip */ }
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async restoreTrash(id, { user = 'system' } = {}) {
    const m = /^(\d+)__(.+)$/.exec(String(id));
    if (!m || /[\\/]/.test(id)) throw new VaultFreeError(400, 'invalid_id', 'Invalid trash id');
    const file = path.join(this.kdir, 'trash', id);
    let content;
    try { content = await fsp.readFile(file, 'utf8'); } catch { throw new VaultFreeError(404, 'not_found', 'Not in the trash'); }
    let p = normalizePath(decodeURIComponent(m[2]));
    if (this.index.notes.has(p)) p = p.replace(/\.md$/i, '') + ' (restored).md';
    const r = await this.write(p, content, { user, op: 'restore' });
    await fsp.rm(file, { force: true });
    return { path: r.path };
  }

  /** Recent activity (newest first), taken from the tail of the audit log. */
  async activity(limit = 80) {
    await this.audit.flush();
    const file = path.join(this.kdir, 'audit.log');
    let text = '';
    try {
      const st = await fsp.stat(file);
      const size = Math.min(st.size, 512 * 1024);
      const fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, st.size - size);
      await fh.close();
      text = buf.toString('utf8');
      if (st.size > size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } catch { return []; }
    const out = [];
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        out.push({ ts: e.ts, user: e.user, action: e.action, path: e.path, ...(e.from ? { from: e.from } : {}) });
      } catch { /* skip damaged line */ }
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- integrity ----
  async verify() {
    const problems = [];
    for (const [p, m] of this.index.notes) {
      const disk = await fsp.readFile(this.abs(p), 'utf8').catch(() => null);
      if (disk == null) problems.push(`missing on disk: ${p}`);
      else if (sha256(disk) !== m.rev) problems.push(`changed outside VaultFree since indexing: ${p}`);
    }
    let objects = 0;
    const odir = path.join(this.kdir, 'objects');
    for (const d of await fsp.readdir(odir).catch(() => [])) {
      for (const f of await fsp.readdir(path.join(odir, d))) {
        objects++;
        const data = await fsp.readFile(path.join(odir, d, f), 'utf8');
        if (sha256(data) !== f) problems.push(`corrupt object: ${f}`);
      }
    }
    await this.audit.flush();
    const a = AuditLog.verify(path.join(this.kdir, 'audit.log'));
    if (!a.ok) problems.push(`audit log: ${a.error}`);
    return { ok: problems.length === 0, notes: this.index.notes.size, objects, auditEntries: a.entries, problems };
  }
}
