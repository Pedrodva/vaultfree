import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { VaultFreeError, sha256 } from './util.js';

const DAY = 24 * 3600 * 1000;
const SESSION_MS = 90 * DAY; // sliding: renewed while the user keeps using the app
const COOKIE_MAX_AGE = 400 * 24 * 3600; // seconds (browsers cap cookies at ~400 days)
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;

const scryptAsync = (pw, salt) => new Promise((res, rej) => scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scryptAsync(pw, salt)).toString('base64')}`;
}
export async function checkPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const k = await scryptAsync(pw, Buffer.from(s, 'base64'));
  const want = Buffer.from(h, 'base64');
  return k.length === want.length && timingSafeEqual(k, want);
}

export class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'auth.json');
    this.state = { users: [], tokens: [], sessions: [], invites: [] };
    if (fs.existsSync(this.file)) this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    const now = Date.now();
    this.state.sessions = this.state.sessions.filter((s) => s.expires > now);
    this.queue = Promise.resolve();
    this.attempts = new Map();
  }

  save() {
    const data = JSON.stringify(this.state, null, 2);
    this.queue = this.queue.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, data, { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    });
    return this.queue;
  }

  get hasUsers() { return this.state.users.length > 0; }
  publicUser(u) { return u && { id: u.id, username: u.username, displayName: u.displayName, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt }; }
  userById(id) { return this.state.users.find((u) => u.id === id); }
  userByName(n) { return this.state.users.find((u) => u.username.toLowerCase() === String(n).toLowerCase()); }
  listUsers() { return this.state.users.map((u) => this.publicUser(u)); }

  async createUser({ username, password, displayName, role = 'user' }) {
    if (!USERNAME.test(username || '')) throw new VaultFreeError(400, 'invalid_username', 'Username: 3-32 chars (letters, digits, . _ -)');
    if (typeof password !== 'string' || password.length < 8) throw new VaultFreeError(400, 'weak_password', 'Password must be at least 8 characters');
    if (this.userByName(username)) throw new VaultFreeError(409, 'user_exists', 'Username already taken');
    const u = { id: randomUUID(), username, displayName: String(displayName || username).slice(0, 60), role, passHash: await hashPassword(password), createdAt: Date.now() };
    this.state.users.push(u);
    await this.save();
    return this.publicUser(u);
  }

  async setPassword(username, password) {
    const u = this.userByName(username);
    if (!u) throw new VaultFreeError(404, 'not_found', 'No such user');
    if (password.length < 8) throw new VaultFreeError(400, 'weak_password', 'Password must be at least 8 characters');
    u.passHash = await hashPassword(password);
    this.state.sessions = this.state.sessions.filter((s) => s.userId !== u.id);
    await this.save();
  }

  /** Self-service password change: needs the current password; other sessions are signed out. */
  async changePassword(userId, current, next, keepSessionRaw = null) {
    const u = this.userById(userId);
    if (!u) throw new VaultFreeError(404, 'not_found', 'No such user');
    const fail = this.throttle('pw|' + userId);
    if (!(await checkPassword(String(current || ''), u.passHash))) { fail(); throw new VaultFreeError(403, 'bad_credentials', 'Current password is incorrect'); }
    if (typeof next !== 'string' || next.length < 8) throw new VaultFreeError(400, 'weak_password', 'Password must be at least 8 characters');
    u.passHash = await hashPassword(next);
    const keep = keepSessionRaw ? sha256(keepSessionRaw) : null;
    this.state.sessions = this.state.sessions.filter((s) => s.userId !== userId || s.hash === keep);
    await this.save();
  }

  async setDisabled(id, disabled) {
    const u = this.userById(id);
    if (!u) throw new VaultFreeError(404, 'not_found', 'No such user');
    u.disabled = !!disabled;
    if (disabled) this.state.sessions = this.state.sessions.filter((s) => s.userId !== id);
    await this.save();
  }

  throttle(key) {
    const now = Date.now();
    const a = (this.attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (a.length >= 10) throw new VaultFreeError(429, 'too_many_attempts', 'Too many failed logins. Try again later.');
    this.attempts.set(key, a);
    return () => a.push(now);
  }

  async login(username, password, ip = '') {
    const fail = this.throttle(`${ip}|${String(username).toLowerCase()}`);
    const u = this.userByName(username || '');
    const ok = u && !u.disabled && (await checkPassword(String(password || ''), u.passHash));
    if (!ok) { fail(); throw new VaultFreeError(401, 'bad_credentials', 'Invalid username or password'); }
    const raw = randomBytes(32).toString('base64url');
    this.state.sessions.push({ hash: sha256(raw), userId: u.id, expires: Date.now() + SESSION_MS });
    await this.save();
    return { token: raw, user: this.publicUser(u), maxAge: COOKIE_MAX_AGE };
  }

  async logout(raw) {
    const h = sha256(raw);
    this.state.sessions = this.state.sessions.filter((s) => s.hash !== h);
    await this.save();
  }

  /** @returns {{user, via, scopes, vaults}|null} */
  authenticate(bearer, cookieToken) {
    if (bearer && bearer.startsWith('vf_')) {
      const h = sha256(bearer);
      const t = this.state.tokens.find((x) => x.hash === h);
      if (!t) return null;
      const user = this.userById(t.userId);
      if (!user || user.disabled) return null;
      if (Date.now() - (t.lastUsed || 0) > 60_000) { t.lastUsed = Date.now(); this.save(); }
      return { user, via: 'token', scopes: t.scopes, vaults: t.vaults || null, tokenId: t.id, tokenName: t.name };
    }
    if (cookieToken) {
      const h = sha256(cookieToken);
      const s = this.state.sessions.find((x) => x.hash === h && x.expires > Date.now());
      const user = s && this.userById(s.userId);
      if (s && s.expires - Date.now() < SESSION_MS / 2) { s.expires = Date.now() + SESSION_MS; this.save(); }
      if (user && !user.disabled) return { user, via: 'session', scopes: ['read', 'write'], vaults: null };
    }
    return null;
  }

  // ---- invite links: let a teammate join a vault without an admin creating the account ----
  async createInvite(userId, { vault, role = 'editor', maxUses = 1, hours = 72 }) {
    if (role !== 'viewer' && role !== 'editor') throw new VaultFreeError(400, 'invalid_role', 'Invites can grant viewer or editor');
    const raw = 'vfi_' + randomBytes(24).toString('base64url');
    const inv = {
      id: randomUUID(), hash: sha256(raw), vault, role, createdBy: userId, createdAt: Date.now(),
      expires: Number(hours) === 0 ? null : Date.now() + Math.min(Math.max(Number(hours) || 72, 1), 8760) * 3600 * 1000,
      maxUses: Math.min(Math.max(Number(maxUses) || 1, 1), 100), uses: 0,
    };
    this.state.invites.push(inv);
    await this.save();
    return { token: raw, invite: this.publicInvite(inv) };
  }
  publicInvite({ hash, ...i }) { return i; }
  listInvites(vault) {
    const now = Date.now();
    return this.state.invites.filter((i) => i.vault === vault && (!i.expires || i.expires > now) && i.uses < i.maxUses).map((i) => this.publicInvite(i));
  }
  async revokeInvite(vault, id) {
    const n = this.state.invites.length;
    this.state.invites = this.state.invites.filter((i) => !(i.id === id && i.vault === vault));
    if (n === this.state.invites.length) throw new VaultFreeError(404, 'not_found', 'Invite not found');
    await this.save();
  }
  findInvite(raw) {
    const h = sha256(String(raw));
    const i = this.state.invites.find((x) => x.hash === h);
    if (!i || (i.expires && i.expires <= Date.now()) || i.uses >= i.maxUses) throw new VaultFreeError(404, 'invite_invalid', 'This invite link is invalid, expired or already used');
    return i;
  }
  async useInvite(inv) { inv.uses++; await this.save(); }

  async createToken(userId, { name, scopes = ['read', 'write'], vaults = null }) {
    const raw = 'vf_' + randomBytes(32).toString('base64url');
    const t = {
      id: randomUUID(), userId, name: String(name || 'token').slice(0, 60), hash: sha256(raw),
      scopes: scopes.filter((s) => s === 'read' || s === 'write' || s === 'propose'), vaults, createdAt: Date.now(), lastUsed: 0,
    };
    if (!t.scopes.includes('read')) t.scopes.push('read');
    this.state.tokens.push(t);
    await this.save();
    return { token: raw, id: t.id, name: t.name, scopes: t.scopes };
  }
  listTokens(userId) {
    return this.state.tokens.filter((t) => t.userId === userId).map(({ hash, ...t }) => t);
  }
  async revokeToken(userId, id) {
    const n = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((t) => !(t.id === id && t.userId === userId));
    if (this.state.tokens.length === n) throw new VaultFreeError(404, 'not_found', 'Token not found');
    await this.save();
  }
}
