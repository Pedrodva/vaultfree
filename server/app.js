import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, readBody, readJson, sendJson, serveStatic, mimeOf, SECURITY_HEADERS } from './http.js';
import { Auth } from './auth.js';
import { VaultManager } from './vaults.js';
import { VaultFreeError } from './util.js';
import { VERSION } from './config.js';
import { MAX_FILE_BYTES } from './vault.js';
import { LLMS_TXT } from './llms.js';
import { Tunnel } from './tunnel.js';
import { createMcpHandler } from './mcp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const SHARED = path.join(ROOT, 'shared');
const COOKIE = 'vf_session';

function parseCookies(h = '') {
  const out = {};
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return out;
}

export async function createApp(config) {
  const auth = new Auth(config.dataDir);
  const vaults = await new VaultManager(config.dataDir).load();
  const router = new Router();
  const tunnel = new Tunnel();
  const presence = new Map(); // vaultId -> Map(userId -> {username, displayName, path, ts})
  const R = (m, p, h, opts = {}) => router.add(m, p, Object.assign(h, opts));

  const fromLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const proxied = (req) => config.trustProxy || (tunnel.url && fromLoopback(req));
  const clientIp = (req) => (proxied(req) && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim())) || req.socket.remoteAddress || '';
  const isHttps = (req) => config.secureCookies || (proxied(req) && (req.headers['x-forwarded-proto'] === 'https' || /https/.test(req.headers['cf-visitor'] || '')));
  const cookieHeader = (req, value, maxAge) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  const needUser = (ctx) => {
    if (!ctx.auth) throw new VaultFreeError(401, 'unauthorized', 'Authentication required');
    return ctx.auth.user;
  };
  const vaultFor = (ctx, min) => {
    const user = needUser(ctx);
    if (ctx.auth.vaults && !ctx.auth.vaults.includes(ctx.params.v)) throw new VaultFreeError(403, 'forbidden', 'Token not valid for this vault');
    return vaults.require(ctx.params.v, user, min);
  };
  const needAdmin = (ctx) => { if (needUser(ctx).role !== 'admin') throw new VaultFreeError(403, 'forbidden', 'Admin only'); };
  const who = (ctx) => ctx.auth.user.username + (ctx.auth.via === 'token' ? '(api)' : '');

  // ---------- public ----------
  R('GET', '/api/health', (ctx) => ctx.json(200, { ok: true, version: VERSION }));
  R('GET', '/api/config', (ctx) => ctx.json(200, { version: VERSION, needsSetup: !auth.hasUsers, allowSignup: config.allowSignup, publicUrl: config.publicUrl || null }));

  const registerUser = async (ctx, role) => {
    const b = ctx.body;
    const user = await auth.createUser({ username: b.username, password: b.password, displayName: b.displayName, role });
    return user;
  };
  const startSession = async (ctx, username, password) => {
    const s = await auth.login(username, password, clientIp(ctx.req));
    ctx.json(200, { user: s.user }, { 'set-cookie': cookieHeader(ctx.req, s.token, s.maxAge) });
  };

  R('POST', '/api/auth/register', async (ctx) => {
    const first = !auth.hasUsers;
    if (!first && !config.allowSignup) throw new VaultFreeError(403, 'signup_disabled', 'Sign-up is disabled. Ask an admin to create your account.');
    const user = await registerUser(ctx, first ? 'admin' : 'user');
    if (first) await vaults.create({ name: 'Welcome', description: 'Starter vault', ownerId: user.id, welcome: true });
    await startSession(ctx, ctx.body.username, ctx.body.password);
  });
  R('POST', '/api/auth/login', (ctx) => startSession(ctx, ctx.body.username, ctx.body.password));
  R('POST', '/api/auth/logout', async (ctx) => {
    const c = parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (c) await auth.logout(c);
    ctx.json(200, { ok: true }, { 'set-cookie': cookieHeader(ctx.req, '', 0) });
  });
  R('GET', '/api/auth/me', (ctx) => ctx.json(200, { user: auth.publicUser(needUser(ctx)), via: ctx.auth.via, canCreateVaults: config.usersCanCreateVaults || ctx.auth.user.role === 'admin' }));

  // ---------- tokens ----------
  R('GET', '/api/tokens', (ctx) => ctx.json(200, { tokens: auth.listTokens(needUser(ctx).id) }));
  R('POST', '/api/tokens', async (ctx) => {
    const u = needUser(ctx);
    if (ctx.auth.via === 'token') throw new VaultFreeError(403, 'forbidden', 'Tokens cannot create tokens');
    const b = ctx.body;
    const vlist = Array.isArray(b.vaults) && b.vaults.length ? b.vaults.filter((x) => vaults.get(x) && vaults.roleOf(vaults.get(x), u)) : null;
    ctx.json(201, await auth.createToken(u.id, { name: b.name, scopes: b.scopes || ['read', 'write'], vaults: vlist }));
  });
  R('DELETE', '/api/tokens/:id', async (ctx) => { await auth.revokeToken(needUser(ctx).id, ctx.params.id); ctx.json(200, { ok: true }); });

  // ---------- admin ----------
  R('GET', '/api/admin/users', (ctx) => { needAdmin(ctx); ctx.json(200, { users: auth.listUsers() }); });
  R('POST', '/api/admin/users', async (ctx) => {
    needAdmin(ctx);
    const b = ctx.body;
    ctx.json(201, { user: await auth.createUser({ username: b.username, password: b.password, displayName: b.displayName, role: b.role === 'admin' ? 'admin' : 'user' }) });
  });
  R('PATCH', '/api/admin/users/:id', async (ctx) => {
    needAdmin(ctx);
    if (ctx.params.id === ctx.auth.user.id) throw new VaultFreeError(400, 'invalid', 'You cannot disable yourself');
    await auth.setDisabled(ctx.params.id, ctx.body.disabled);
    ctx.json(200, { ok: true });
  });

  // ---------- invites ----------
  R('POST', '/api/vaults/:v/invites', async (ctx) => {
    const { vault } = vaultFor(ctx, 'owner');
    const b = ctx.body;
    ctx.json(201, await auth.createInvite(ctx.auth.user.id, { vault: vault.id, role: b.role || 'editor', maxUses: b.maxUses, hours: b.hours }));
  });
  R('GET', '/api/vaults/:v/invites', (ctx) => ctx.json(200, { invites: auth.listInvites(vaultFor(ctx, 'owner').vault.id) }));
  R('DELETE', '/api/vaults/:v/invites/:id', async (ctx) => { await auth.revokeInvite(vaultFor(ctx, 'owner').vault.id, ctx.params.id); ctx.json(200, { ok: true }); });
  R('GET', '/api/invites/:token', (ctx) => {
    const inv = auth.findInvite(ctx.params.token);
    ctx.json(200, { vault: vaults.get(inv.vault)?.meta.name, role: inv.role, expires: inv.expires });
  });
  R('POST', '/api/invites/:token/accept', async (ctx) => {
    const inv = auth.findInvite(ctx.params.token);
    const vault = vaults.get(inv.vault);
    if (!vault) throw new VaultFreeError(404, 'not_found', 'Vault no longer exists');
    let user = ctx.auth?.user;
    if (!user) {
      const b = ctx.body;
      const created = await auth.createUser({ username: b.username, password: b.password, displayName: b.displayName, role: 'user' });
      user = auth.userById(created.id);
    }
    const rank = { viewer: 1, editor: 2, owner: 3 };
    const current = vault.meta.members[user.id];
    if (!current || rank[current] < rank[inv.role]) await vaults.setMember(vault, user.id, inv.role);
    await auth.useInvite(inv);
    if (ctx.auth) return ctx.json(200, { vault: vault.id });
    const s = await auth.login(ctx.body.username, ctx.body.password, clientIp(ctx.req));
    ctx.json(200, { user: s.user, vault: vault.id }, { 'set-cookie': cookieHeader(ctx.req, s.token, s.maxAge) });
  });

  // ---------- share online (admin) ----------
  R('GET', '/api/admin/share', (ctx) => { needAdmin(ctx); ctx.json(200, tunnel.status()); });
  const notManaged = () => { if (tunnel.permanent) throw new VaultFreeError(409, 'managed', 'The tunnel is managed by the server settings (VAULTFREE_TUNNEL_TOKEN).'); };
  R('POST', '/api/admin/share', async (ctx) => { needAdmin(ctx); notManaged(); ctx.json(200, await tunnel.start(server.address().port)); });
  R('DELETE', '/api/admin/share', (ctx) => { needAdmin(ctx); notManaged(); ctx.json(200, tunnel.stop()); });

  // ---------- remote MCP (Streamable HTTP, JSON responses). Auth: Bearer vf_ token ----------
  R('GET', '/mcp', (ctx) => { ctx.res.writeHead(405, { allow: 'POST', ...SECURITY_HEADERS }); ctx.res.end(); });
  R('POST', '/mcp', async (ctx) => {
    if (!ctx.auth || ctx.auth.via !== 'token') {
      return ctx.json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Send Authorization: Bearer vf_<token>' } }, { 'www-authenticate': 'Bearer' });
    }
    const raw = /^Bearer\s+(\S+)/i.exec(ctx.req.headers.authorization)[1];
    const handle = createMcpHandler({ url: `http://127.0.0.1:${server.address().port}`, token: raw });
    const msgs = Array.isArray(ctx.body) ? ctx.body : [ctx.body];
    const out = (await Promise.all(msgs.map((m) => handle(m)))).filter(Boolean);
    if (!out.length) { ctx.res.writeHead(202, SECURITY_HEADERS); return ctx.res.end(); }
    ctx.json(200, Array.isArray(ctx.body) ? out : out[0]);
  });

  // ---------- vaults ----------
  R('GET', '/api/vaults', (ctx) => ctx.json(200, { vaults: vaults.listFor(needUser(ctx)).filter((v) => !ctx.auth.vaults || ctx.auth.vaults.includes(v.id)) }));
  R('POST', '/api/vaults', async (ctx) => {
    const u = needUser(ctx);
    if (!config.usersCanCreateVaults && u.role !== 'admin') throw new VaultFreeError(403, 'forbidden', 'Only admins can create vaults');
    const v = await vaults.create({ name: ctx.body.name, description: ctx.body.description || '', ownerId: u.id, welcome: !!ctx.body.welcome });
    ctx.json(201, { id: v.id, name: v.meta.name });
  });
  R('PATCH', '/api/vaults/:v', async (ctx) => {
    const { vault } = vaultFor(ctx, 'owner');
    if (ctx.body.name) vault.meta.name = String(ctx.body.name).slice(0, 60);
    if (typeof ctx.body.description === 'string') vault.meta.description = ctx.body.description.slice(0, 500);
    if (typeof ctx.body.allowCopy === 'boolean') vault.meta.allowCopy = ctx.body.allowCopy;
    await vault.saveMeta();
    ctx.json(200, { ok: true });
  });
  R('GET', '/api/vaults/:v/members', (ctx) => {
    const { vault } = vaultFor(ctx, 'viewer');
    ctx.json(200, { members: Object.entries(vault.meta.members).map(([id, role]) => ({ ...auth.publicUser(auth.userById(id)), role })).filter((m) => m.id) });
  });
  R('PUT', '/api/vaults/:v/members/:username', async (ctx) => {
    const { vault } = vaultFor(ctx, 'owner');
    const target = auth.userByName(ctx.params.username);
    if (!target) throw new VaultFreeError(404, 'not_found', 'No such user');
    await vaults.setMember(vault, target.id, ctx.body.role);
    ctx.json(200, { ok: true });
  });
  R('DELETE', '/api/vaults/:v/members/:username', async (ctx) => {
    const { vault } = vaultFor(ctx, 'owner');
    const target = auth.userByName(ctx.params.username);
    if (!target) throw new VaultFreeError(404, 'not_found', 'No such user');
    await vaults.setMember(vault, target.id, null);
    ctx.json(200, { ok: true });
  });

  // ---------- notes ----------
  R('GET', '/api/vaults/:v/notes', (ctx) => ctx.json(200, { notes: vaultFor(ctx, 'viewer').vault.index.list(), files: [...vaultFor(ctx, 'viewer').vault.files].sort(), folders: vaultFor(ctx, 'viewer').vault.listFolders() }));
  R('GET', '/api/vaults/:v/notes/*', async (ctx) => ctx.json(200, await vaultFor(ctx, 'viewer').vault.read(ctx.params.path)));
  R('PUT', '/api/vaults/:v/notes/*', async (ctx) => {
    const { vault } = vaultFor(ctx, 'editor');
    ctx.json(200, await vault.write(ctx.params.path, ctx.body.content, { baseRev: ctx.body.baseRev ?? null, user: who(ctx) }));
  });
  R('DELETE', '/api/vaults/:v/notes/*', async (ctx) => {
    const { vault } = vaultFor(ctx, 'editor');
    ctx.json(200, await vault.delete(ctx.params.path, { baseRev: ctx.query.get('baseRev'), user: who(ctx) }));
  });
  R('POST', '/api/vaults/:v/ops/append', async (ctx) => {
    const { vault } = vaultFor(ctx, 'editor');
    if (typeof ctx.body.text !== 'string') throw new VaultFreeError(400, 'invalid_content', 'text must be a string');
    ctx.json(200, await vault.append(ctx.body.path, ctx.body.text, { user: who(ctx), createIfMissing: ctx.body.createIfMissing !== false }));
  });
  R('POST', '/api/vaults/:v/ops/rename', async (ctx) => {
    const { vault } = vaultFor(ctx, 'editor');
    ctx.json(200, await vault.rename(ctx.body.from, ctx.body.to, { updateLinks: ctx.body.updateLinks !== false, user: who(ctx) }));
  });
  R('POST', '/api/vaults/:v/ops/mkdir', async (ctx) => ctx.json(200, await vaultFor(ctx, 'editor').vault.mkdir(ctx.body.path, { user: who(ctx) })));
  R('POST', '/api/vaults/:v/ops/move-folder', async (ctx) => ctx.json(200, await vaultFor(ctx, 'editor').vault.moveFolder(ctx.body.from, ctx.body.to, { user: who(ctx) })));
  R('DELETE', '/api/vaults/:v/folders/*', async (ctx) => ctx.json(200, await vaultFor(ctx, 'editor').vault.rmdir(ctx.params.path, { user: who(ctx) })));
  R('POST', '/api/vaults/:v/ops/restore', async (ctx) => {
    const { vault } = vaultFor(ctx, 'editor');
    ctx.json(200, await vault.restore(ctx.body.path, ctx.body.rev, { user: who(ctx) }));
  });
  R('GET', '/api/vaults/:v/history', async (ctx) => ctx.json(200, { history: await vaultFor(ctx, 'viewer').vault.history(ctx.query.get('path') || '') }));
  R('GET', '/api/vaults/:v/revisions/:rev', async (ctx) => {
    const c = await vaultFor(ctx, 'viewer').vault.getObject(ctx.params.rev);
    if (c == null) throw new VaultFreeError(404, 'not_found', 'Unknown revision');
    ctx.json(200, { rev: ctx.params.rev, content: c });
  });

  // ---------- knowledge ----------
  R('GET', '/api/vaults/:v/search', (ctx) => ctx.json(200, { results: vaultFor(ctx, 'viewer').vault.index.search(ctx.query.get('q') || '', { limit: Math.min(Number(ctx.query.get('limit')) || 20, 200) }) }));
  R('GET', '/api/vaults/:v/tags', (ctx) => ctx.json(200, { tags: vaultFor(ctx, 'viewer').vault.index.tags() }));
  R('GET', '/api/vaults/:v/graph', (ctx) => {
    const q = ctx.query, flag = (k, d) => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' : d);
    ctx.json(200, vaultFor(ctx, 'viewer').vault.index.graph({
      q: q.get('q') || '', tag: q.get('tag') || '', folder: q.get('folder') || '', orphans: flag('orphans', true),
      unresolved: flag('unresolved', false), tags: flag('tags', false), center: q.get('center') || '', depth: Number(q.get('depth')) || 1,
    }));
  });
  R('GET', '/api/vaults/:v/context', (ctx) => ctx.json(200, vaultFor(ctx, 'viewer').vault.index.context(ctx.query.get('q') || '', {
    budget: Math.min(Number(ctx.query.get('budget')) || 12000, 200000), limit: Math.min(Number(ctx.query.get('limit')) || 5, 25) })));
  R('GET', '/api/vaults/:v/chunks', (ctx) => ctx.json(200, { chunks: vaultFor(ctx, 'viewer').vault.index.chunks({ maxChars: Math.max(200, Number(ctx.query.get('maxChars')) || 1500), path: ctx.query.get('path') || '' }) }));
  const copyGuard = (vault, role) => { if (vault.meta.allowCopy === false && role !== 'owner') throw new VaultFreeError(403, 'copy_disabled', 'The owner of this vault has disabled copying and exporting'); };
  R('POST', '/api/vaults/:v/ops/fork', async (ctx) => {
    const { vault, role } = vaultFor(ctx, 'viewer');
    copyGuard(vault, role);
    const u = ctx.auth.user;
    if (!config.usersCanCreateVaults && u.role !== 'admin') throw new VaultFreeError(403, 'forbidden', 'Only admins can create vaults');
    const r = await vaults.fork(vault, u, { name: ctx.body.name || `Copy of ${vault.meta.name}`, folder: typeof ctx.body.folder === 'string' ? ctx.body.folder : '' });
    ctx.json(201, { id: r.vault.id, name: r.vault.meta.name, notes: r.notes, files: r.files });
  });
  R('GET', '/api/vaults/:v/export', (ctx) => {
    const { vault, role } = vaultFor(ctx, 'viewer');
    copyGuard(vault, role);
    const rows = [...vault.index.notes.values()].map((m) => ({ path: m.path, title: m.title, rev: m.rev, mtime: m.mtime, tags: m.tags, frontmatter: m.frontmatter, links: m.links.map((l) => l.target), content: m.content }));
    if (ctx.query.get('format') === 'jsonl') {
      ctx.res.writeHead(200, { 'content-type': 'application/x-ndjson', ...SECURITY_HEADERS });
      return ctx.res.end(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    ctx.json(200, { vault: vault.id, exportedAt: Date.now(), notes: rows });
  });
  R('GET', '/api/vaults/:v/verify', async (ctx) => ctx.json(200, await vaultFor(ctx, 'owner').vault.verify()));

  // ---------- files ----------
  R('POST', '/api/vaults/:v/files/*', async (ctx) => {
    const { vault } = vaultFor(ctx, 'editor');
    ctx.json(201, await vault.saveFile(ctx.params.path, ctx.rawBody, { user: who(ctx) }));
  }, { raw: true });
  R('GET', '/api/vaults/:v/files/*', async (ctx) => {
    const { vault } = vaultFor(ctx, 'viewer');
    const buf = await vault.readFile(ctx.params.path);
    const type = mimeOf(ctx.params.path);
    const h = { 'content-type': type, 'content-length': buf.length, 'cache-control': 'private, max-age=300', ...SECURITY_HEADERS };
    if (type === 'image/svg+xml') h['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    if (!/^(image|audio|video)\//.test(type) && type !== 'application/pdf') h['content-disposition'] = 'attachment';
    ctx.res.writeHead(200, h);
    ctx.res.end(buf);
  });

  // ---------- realtime ----------
  const broadcastPresence = (vaultId) => {
    const vault = vaults.get(vaultId);
    const now = Date.now();
    const m = presence.get(vaultId) || new Map();
    for (const [k, v] of m) if (now - v.ts > 60_000) m.delete(k);
    vault?.emit('presence', [...m.values()].map(({ ts, ...r }) => r));
  };
  R('POST', '/api/vaults/:v/presence', (ctx) => {
    const { vault } = vaultFor(ctx, 'viewer');
    const u = ctx.auth.user;
    if (!presence.has(vault.id)) presence.set(vault.id, new Map());
    const m = presence.get(vault.id);
    if (ctx.body.path) m.set(u.id, { username: u.username, displayName: u.displayName, path: String(ctx.body.path), ts: Date.now() });
    else m.delete(u.id);
    broadcastPresence(vault.id);
    ctx.json(200, { ok: true });
  });
  R('GET', '/api/vaults/:v/events', (ctx) => {
    const { vault } = vaultFor(ctx, 'viewer');
    const { res, req } = ctx;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 3000\n\n');
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onChange = (e) => send('change', e);
    const onPresence = (list) => send('presence', list);
    vault.on('change', onChange);
    vault.on('presence', onPresence);
    send('presence', [...(presence.get(vault.id)?.values() || [])].map(({ ts, ...r }) => r));
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(hb);
      vault.off('change', onChange);
      vault.off('presence', onPresence);
      presence.get(vault.id)?.delete(ctx.auth.user.id);
      broadcastPresence(vault.id);
    });
  });

  R('GET', '/llms.txt', (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    ctx.res.end(LLMS_TXT);
  });

  // ---------- dispatcher ----------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
      if (!m) {
        if (url.pathname.startsWith('/api/')) {
          const allowed = router.allowed(url.pathname);
          if (allowed.length) throw new VaultFreeError(405, 'method_not_allowed', `Allowed: ${allowed.join(', ')}`);
          throw new VaultFreeError(404, 'not_found', 'No such endpoint');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new VaultFreeError(405, 'method_not_allowed', 'Method not allowed');
        if (url.pathname.startsWith('/shared/') && (await serveStatic(req, res, SHARED, url.pathname.slice(8)))) return;
        if (await serveStatic(req, res, WEB, url.pathname === '/' ? 'index.html' : url.pathname)) return;
        throw new VaultFreeError(404, 'not_found', 'Not found');
      }
      const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '')?.[1];
      const cookie = parseCookies(req.headers.cookie)[COOKIE];
      const a = auth.authenticate(bearer, cookie);
      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (a && mutating) {
        if (a.via === 'session') {
          const origin = req.headers.origin;
          let ok = false;
          try { ok = !!origin && new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
          if (!ok) throw new VaultFreeError(403, 'csrf', 'Cross-origin request blocked');
        } else if (!a.scopes.includes('write') && url.pathname !== '/mcp') throw new VaultFreeError(403, 'forbidden', 'Token lacks write scope'); // /mcp enforces scopes per tool call via the REST API
      }
      const ctx = {
        req, res, auth: a, params: m.params, query: url.searchParams, body: {},
        json: (status, body, headers) => sendJson(res, status, body, headers),
      };
      if (mutating) {
        if (m.handler.raw) ctx.rawBody = await readBody(req, MAX_FILE_BYTES);
        else ctx.body = await readJson(req);
      }
      await m.handler(ctx);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof VaultFreeError) sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
      else { console.error(e); sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error' } }); }
    }
  });

  const closeVaults = () => [...vaults.vaults.values()].forEach((v) => v.close());
  const flushAll = () => Promise.all([...vaults.vaults.values()].map((v) => v.audit.flush()));
  return {
    server, auth, vaults, config,
    listen: () => new Promise((r) => server.listen(config.port, config.host, () => {
      if (config.tunnelToken) { try { tunnel.startNamed(config.tunnelToken, config.publicUrl); console.log('Named Cloudflare tunnel started' + (config.publicUrl ? ' → ' + config.publicUrl : '')); } catch (e) { console.error('Tunnel not started:', e.message); } }
      r(server.address());
    })),
    close: async () => {
      tunnel.stop();
      closeVaults(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await flushAll(); await auth.queue; },
  };
}
