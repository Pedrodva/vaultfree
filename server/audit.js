// Append-only, hash-chained audit log. Tampering with any line breaks the chain.
import fs from 'node:fs';
import { sha256 } from './util.js';

export class AuditLog {
  constructor(file) {
    this.file = file;
    this.last = '0'.repeat(64);
    this.queue = Promise.resolve();
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) {
        try { this.last = JSON.parse(lines[lines.length - 1]).hash; } catch { /* verify() will report it */ }
      }
    }
  }

  append(entry) {
    const rec = { ts: new Date().toISOString(), ...entry, prev: this.last };
    rec.hash = sha256(JSON.stringify(rec));
    this.last = rec.hash;
    this.queue = this.queue.then(() => fs.promises.appendFile(this.file, JSON.stringify(rec) + '\n')).catch(() => {});
    return this.queue;
  }

  flush() { return this.queue; }

  static verify(file) {
    if (!fs.existsSync(file)) return { ok: true, entries: 0 };
    let prev = '0'.repeat(64), n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      n++;
      let rec;
      try { rec = JSON.parse(line); } catch { return { ok: false, entries: n, error: `line ${n}: invalid JSON` }; }
      const { hash, ...rest } = rec;
      if (rest.prev !== prev) return { ok: false, entries: n, error: `line ${n}: broken chain` };
      if (sha256(JSON.stringify(rest)) !== hash) return { ok: false, entries: n, error: `line ${n}: hash mismatch` };
      prev = hash;
    }
    return { ok: true, entries: n };
  }
}
