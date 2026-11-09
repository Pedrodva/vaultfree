import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

test('demo mode: one-click sandbox, guard rails, expiry sweep', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-demo-'));
  const app = await createApp(loadConfig({ VAULTFREE_DEMO: 'true' }, { dataDir, port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const j = async (method, url, { body, cookie, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), origin: base, ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };

  const cfg = (await j('GET', '/api/config')).data;
  assert.equal(cfg.needsSetup, false); // visitors never become admin
  assert.equal(cfg.demo.ttlHours, 24);
  assert.equal((await j('POST', '/api/auth/register', { body: { username: 'mallory', password: 'password123' } })).status, 403);

  // one click → own account + seeded sandbox
  const start = await j('POST', '/api/demo/start', { body: {} });
  assert.equal(start.status, 200);
  const cookie = start.res.headers.get('set-cookie').split(';')[0];
  const v = start.data.vault;
  const me = (await j('GET', '/api/auth/me', { cookie })).data;
  assert.equal(me.canCreateVaults, false);
  assert.ok(me.demoExpiresAt > Date.now());
  const notes = (await j('GET', `/api/vaults/${v}/notes`, { cookie })).data.notes.map((n) => n.path);
  assert.ok(notes.includes('Try this first.md') && notes.includes('Projects/Launch plan.md'));
  const props = (await j('GET', `/api/vaults/${v}/proposals?status=open`, { cookie })).data.proposals;
  assert.equal(props.length, 1);
  assert.match(props[0].author, /research agent/);

  // a second visitor cannot see the first sandbox
  const other = await j('POST', '/api/demo/start', { body: {} });
  const cookie2 = other.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await j('GET', `/api/vaults/${v}/notes`, { cookie: cookie2 })).status, 404);

  // the visitor can edit, accept the proposal and use tokens / MCP...
  const n = (await j('GET', `/api/vaults/${v}/notes/Welcome.md`, { cookie })).data;
  assert.equal((await j('PUT', `/api/vaults/${v}/notes/Welcome.md`, { cookie, body: { content: n.content + '\nhi', baseRev: n.rev } })).status, 200);
  assert.equal((await j('POST', `/api/vaults/${v}/proposals/${props[0].id}/accept`, { cookie, body: {} })).status, 200);
  assert.equal((await j('POST', '/api/tokens', { cookie, body: { name: 'agent', scopes: ['read', 'propose'] } })).status, 201);
  // ...but not the things that could be abused on a public server
  assert.equal((await j('POST', '/api/vaults', { cookie, body: { name: 'more' } })).status, 403);
  assert.equal((await j('POST', `/api/vaults/${v}/invites`, { cookie, body: { role: 'editor' } })).status, 403);
  assert.equal((await j('POST', `/api/vaults/${v}/ops/fork`, { cookie, body: {} })).status, 403);
  assert.equal((await j('POST', '/api/admin/share', { cookie, body: {} })).status, 403);
  const big = 'x'.repeat(300 * 1024);
  assert.equal((await j('PUT', `/api/vaults/${v}/notes/Big.md`, { cookie, body: { content: big } })).status, 413);

  // expiry: the sandbox and the account are erased
  const demoUsers = () => app.auth.state.users.filter((u) => u.demo).length;
  assert.equal(demoUsers(), 2);
  const sweepAt = Date.now() + 25 * 3600 * 1000;
  const { Demo } = await import('../server/demo.js');
  const d = new Demo({ auth: app.auth, vaults: app.vaults, dataDir, ttlHours: 24 });
  await d.sweep(sweepAt);
  assert.equal(demoUsers(), 0);
  assert.equal(app.vaults.get(v), undefined);
  assert.equal((await j('GET', '/api/auth/me', { cookie })).status, 401);
  assert.equal(fs.readdirSync(path.join(dataDir, '.trash')).length, 0); // erased, not kept in the trash
});
