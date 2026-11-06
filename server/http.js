import fs from 'node:fs';
import path from 'node:path';
import { VaultFreeError } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
export const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segs, handler });
  }
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.segs.length; i++) {
        const s = r.segs[i];
        if (s === '*') {
          if (parts.length <= i) { ok = false; break; }
          try { params.path = parts.slice(i).map(decodeURIComponent).join('/'); } catch { ok = false; }
          if (ok) return { handler: r.handler, params };
          break;
        }
        if (i >= parts.length) { ok = false; break; }
        let part;
        try { part = decodeURIComponent(parts[i]); } catch { ok = false; break; }
        if (s[0] === ':') params[s.slice(1)] = part;
        else if (s !== part) { ok = false; break; }
      }
      if (ok && r.segs[r.segs.length - 1] !== '*' && parts.length === r.segs.length) return { handler: r.handler, params };
    }
    return null;
  }
  allowed(pathname) {
    return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => this.match(m, pathname));
  }
}

export async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new VaultFreeError(413, 'too_large', 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 4 * 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new VaultFreeError(400, 'invalid_json', 'Body is not valid JSON'); }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(data);
}

export async function serveStatic(req, res, root, rel) {
  const full = path.resolve(root, '.' + path.sep + rel.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  let st;
  try { st = await fs.promises.stat(full); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'content-type': mimeOf(full), 'content-length': st.size, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(full).pipe(res);
  return true;
}
