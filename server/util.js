import { createHash } from 'node:crypto';

export class VaultFreeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export class KeyedMutex {
  constructor() { this.tails = new Map(); }
  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Validates and normalizes a vault-relative path. Throws VaultFreeError(400). */
export function normalizePath(input, { note = true } = {}) {
  const bad = (why) => new VaultFreeError(400, 'invalid_path', `Invalid path: ${why}`);
  if (typeof input !== 'string') throw bad('must be a string');
  let p = input.replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC');
  if (!p || p.length > 240) throw bad('empty or too long');
  if (/[\x00-\x1f<>:"|?*]/.test(p)) throw bad('illegal characters');
  for (const s of p.split('/')) {
    if (!s || s === '.' || s === '..') throw bad('empty or relative segment');
    if (s.startsWith('.')) throw bad('hidden names are not allowed');
    if (/[. ]$/.test(s) || RESERVED.test(s)) throw bad('reserved name');
  }
  if (note) p = p.replace(/\.md$/i, '') + '.md';
  return p;
}

export function slug(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vault';
}
