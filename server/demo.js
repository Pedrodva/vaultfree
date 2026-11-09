import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { VaultFreeError } from './util.js';
import { DEMO_NOTES } from './welcome.js';

const HOUR = 3600 * 1000;

/**
 * Public demo mode (VAULTFREE_DEMO=true): every visitor gets a throwaway account that owns
 * its own sandbox vault, seeded with sample notes, a teammate's edit and an AI-agent proposal
 * waiting for review. Sandboxes and their accounts are erased after `ttlHours`.
 */
export class Demo {
  constructor({ auth, vaults, dataDir, ttlHours = 24, max = 200 }) {
    Object.assign(this, { auth, vaults, ttlHours, max });
    this.file = path.join(dataDir, 'demo.json');
    this.state = { sandboxes: [] };
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.starts = new Map(); // ip -> [timestamps]
    this.queue = Promise.resolve();
  }

  save() {
    const data = JSON.stringify(this.state, null, 2);
    this.queue = this.queue.then(() => fs.promises.writeFile(this.file, data));
    return this.queue;
  }

  isDemoUser(user) { return !!user?.demo; }

  rateLimit(ip) {
    const now = Date.now();
    const list = (this.starts.get(ip) || []).filter((t) => now - t < HOUR);
    if (list.length >= 10) throw new VaultFreeError(429, 'too_many_attempts', 'Too many demo sandboxes from this address. Try again later.');
    list.push(now);
    this.starts.set(ip, list);
  }

  /** Creates the sandbox and returns the throwaway credentials (used only to open a session). */
  async start(ip = '') {
    this.rateLimit(ip);
    await this.sweep();
    while (this.state.sandboxes.length >= this.max) await this.drop(this.state.sandboxes[0]);
    const username = 'guest-' + randomBytes(3).toString('hex');
    const password = randomBytes(18).toString('base64url');
    const user = await this.auth.createUser({ username, password, displayName: 'Guest', role: 'user' });
    this.auth.userById(user.id).demo = true;
    await this.auth.save();
    const v = await this.vaults.create({ name: 'Demo sandbox', description: 'Erased automatically', ownerId: user.id, welcome: true });
    for (const [p, c] of Object.entries(DEMO_NOTES)) await v.write(p, c, { user: 'ana' });
    // a teammate edits a note, then an AI agent proposes a change that waits for review
    const road = await v.read('Projects/Roadmap');
    await v.write('Projects/Roadmap', road.content.trimEnd() + '\n- [ ] Write the launch post\n', { baseRev: road.rev, user: 'ana' });
    await v.propose({
      path: 'Projects/Roadmap', append: '- [ ] Record a 2-minute demo video (suggested from the meeting notes)',
      message: 'Add a follow-up from the latest meeting notes', author: 'ana(api:research agent)',
    });
    this.state.sandboxes.push({ userId: user.id, vaultId: v.id, created: Date.now() });
    await this.save();
    return { username, password, vault: v.id, expiresAt: Date.now() + this.ttlHours * HOUR };
  }

  async drop(sb) {
    this.state.sandboxes = this.state.sandboxes.filter((x) => x !== sb);
    if (this.vaults.get(sb.vaultId)) {
      const dest = await this.vaults.remove(sb.vaultId).catch(() => null);
      if (dest) await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {});
    }
    await this.auth.deleteUser(sb.userId).catch(() => {});
    await this.save();
  }

  /** Erases sandboxes older than the TTL. */
  async sweep(now = Date.now()) {
    for (const sb of [...this.state.sandboxes]) if (now - sb.created > this.ttlHours * HOUR) await this.drop(sb);
  }

  expiresAt(user) {
    const sb = this.state.sandboxes.find((x) => x.userId === user.id);
    return sb ? sb.created + this.ttlHours * HOUR : null;
  }
}
