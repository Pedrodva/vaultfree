// "Share online": exposes this server through a Cloudflare quick tunnel (https://*.trycloudflare.com).
// Needs the `cloudflared` binary (bundled in the Docker image). The tunnel lives only while the
// server runs and the URL changes on each start — an admin must opt in every time.
import { spawn, spawnSync } from 'node:child_process';
import { VaultFreeError } from './util.js';

export const parseTunnelUrl = (text) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)?.[0] || null;

export class Tunnel {
  constructor({ bin = process.env.VAULTFREE_CLOUDFLARED || 'cloudflared' } = {}) {
    this.bin = bin;
    this.proc = null;
    this.url = null;
    this.error = null;
    this.startedAt = null;
    this._available = null;
    this.permanent = false;
    this.stopping = false;
  }

  get available() {
    if (this._available == null) {
      try { this._available = spawnSync(this.bin, ['--version'], { timeout: 5000 }).status === 0; } catch { this._available = false; }
    }
    return this._available;
  }

  status() { return { available: this.available, active: !!this.url, starting: !!this.proc && !this.url, url: this.url, startedAt: this.startedAt, error: this.error, permanent: this.permanent }; }

  start(port) {
    if (!this.available) throw new VaultFreeError(501, 'tunnel_unavailable', 'cloudflared is not installed. The Docker image includes it; see docs/DEPLOYMENT.md.');
    if (this.proc) return this.waitUrl();
    this.error = null; this.url = null;
    const p = spawn(this.bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    let log = '';
    p.stderr.on('data', (d) => {
      log = (log + d).slice(-4000);
      const u = parseTunnelUrl(log);
      if (u && !this.url) { this.url = u; this.startedAt = Date.now(); }
    });
    p.on('error', (e) => { this.error = e.message; this.proc = null; this.url = null; });
    p.on('exit', (code) => {
      if (this.proc === p) { if (!this.url) this.error = `cloudflared exited (${code}). ${log.split('\n').slice(-3).join(' ').trim()}`; this.proc = null; this.url = null; }
    });
    return this.waitUrl();
  }

  /** Named Cloudflare tunnel (permanent hostname configured in the Cloudflare dashboard). Restarts itself if it drops. */
  startNamed(token, publicUrl) {
    if (!this.available) throw new VaultFreeError(501, 'tunnel_unavailable', 'cloudflared is not installed.');
    this.permanent = true; this.stopping = false; this.url = publicUrl || null; this.error = null;
    const run = () => {
      const p = spawn(this.bin, ['tunnel', '--no-autoupdate', 'run'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TUNNEL_TOKEN: token } });
      this.proc = p; this.startedAt = Date.now();
      let log = '';
      p.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
      p.on('exit', (code) => {
        if (this.proc === p) this.proc = null;
        if (this.stopping) return;
        this.error = 'cloudflared exited (' + code + '), retrying in 5s. ' + log.split('\n').slice(-2).join(' ').trim();
        setTimeout(() => { if (!this.stopping && !this.proc) run(); }, 5000);
      });
    };
    run();
    return this.status();
  }

  async waitUrl(ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end && this.proc && !this.url) await new Promise((r) => setTimeout(r, 200));
    if (!this.url) { const err = this.error || 'Timed out waiting for the tunnel URL'; this.stop(); throw new VaultFreeError(502, 'tunnel_failed', err); }
    return this.status();
  }

  stop() {
    this.stopping = true;
    const p = this.proc;
    this.proc = null; this.url = null; this.startedAt = null;
    if (p) p.kill();
    return this.status();
  }
}
