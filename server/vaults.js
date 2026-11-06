import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault } from './vault.js';
import { VaultFreeError, slug } from './util.js';
import { WELCOME_NOTES } from './welcome.js';

const RANK = { viewer: 1, editor: 2, owner: 3 };

export class VaultManager {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'vaults');
    this.vaults = new Map();
  }

  async load() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const d of await fs.promises.readdir(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const root = path.join(this.dir, d.name);
      const mf = path.join(root, '.vaultfree', 'vault.json');
      if (!fs.existsSync(mf)) continue;
      const v = new Vault(root, JSON.parse(await fs.promises.readFile(mf, 'utf8')));
      await v.load();
      this.vaults.set(v.id, v);
    }
    return this;
  }

  async create({ name, description = '', ownerId, welcome = false }) {
    name = String(name || '').trim();
    if (!name || name.length > 60) throw new VaultFreeError(400, 'invalid_name', 'Vault name required (max 60 chars)');
    let id = slug(name);
    while (this.vaults.has(id)) id = `${slug(name)}-${randomUUID().slice(0, 4)}`;
    const root = path.join(this.dir, id);
    const v = await Vault.create(root, { id, name, description, members: { [ownerId]: 'owner' }, createdAt: Date.now() });
    await v.load();
    this.vaults.set(id, v);
    if (welcome) for (const [p, c] of Object.entries(WELCOME_NOTES)) await v.write(p, c, { user: 'system' });
    return v;
  }

  get(id) { return this.vaults.get(id); }

  /** Copy notes (optionally only a folder) and attachments into a brand-new vault owned by `user`. */
  async fork(src, user, { name, folder = '' }) {
    const prefix = folder ? folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/' : '';
    const dest = await this.create({ name, description: `Copy of ${src.meta.name}`, ownerId: user.id });
    let notes = 0, files = 0;
    for (const [p, m] of src.index.notes) {
      if (prefix && !p.startsWith(prefix)) continue;
      await dest.write(p, m.content, { user: user.username });
      notes++;
    }
    for (const p of src.files) {
      if (prefix && !p.startsWith(prefix) && !/^attachments\//.test(p)) continue;
      await dest.saveFile(p, await src.readFile(p), { user: user.username });
      files++;
    }
    dest.audit.append({ user: user.username, action: 'forked-from', path: src.id, rev: '' });
    return { vault: dest, notes, files };
  }

  roleOf(vault, user) {
    if (user.role === 'admin') return 'owner';
    return vault.meta.members[user.id] || null;
  }

  /** Returns the vault if user has at least `min` role, else throws. */
  require(id, user, min = 'viewer') {
    const v = this.vaults.get(id);
    const role = v && this.roleOf(v, user);
    if (!v || !role) throw new VaultFreeError(404, 'not_found', 'Vault not found');
    if (RANK[role] < RANK[min]) throw new VaultFreeError(403, 'forbidden', `Requires ${min} access`);
    return { vault: v, role };
  }

  listFor(user) {
    return [...this.vaults.values()].map((v) => ({ v, role: this.roleOf(v, user) })).filter((x) => x.role)
      .map(({ v, role }) => ({ id: v.id, name: v.meta.name, description: v.meta.description, role, notes: v.index.notes.size, createdAt: v.meta.createdAt, allowCopy: v.meta.allowCopy !== false }));
  }

  async setMember(vault, userId, role) {
    if (role && !RANK[role]) throw new VaultFreeError(400, 'invalid_role', 'Role must be viewer, editor or owner');
    if (role) vault.meta.members[userId] = role; else delete vault.meta.members[userId];
    if (!Object.values(vault.meta.members).includes('owner') && role !== 'owner') {
      throw new VaultFreeError(400, 'last_owner', 'A vault needs at least one owner');
    }
    await vault.saveMeta();
  }
}
