import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createMcpHandler } from '../server/mcp.js';

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-api-'));
  const app = await createApp(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1' }));
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, url, { body, cookie, token } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, res };
  };
  return { app, base, call };
}

test('full flow: setup, roles, tokens, concurrent edits, graph, MCP', async (t) => {
  const { app, base, call } = await boot();
  t.after(() => app.close());

  assert.equal((await call('GET', '/api/config')).data.needsSetup, true);
  assert.equal((await call('GET', '/api/vaults')).status, 401);

  const reg = await call('POST', '/api/auth/register', { body: { username: 'admin', password: 'password123' } });
  assert.equal(reg.status, 200);
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  assert.match(reg.res.headers.get('set-cookie'), /HttpOnly/);

  // sign-up closed after the first user
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'eve', password: 'password123' } })).status, 403);
  // CSRF: cookie without matching Origin is rejected
  const csrf = await fetch(base + '/api/vaults', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'http://evil.test' }, body: '{"name":"x"}' });
  assert.equal(csrf.status, 403);

  const { vaults } = (await call('GET', '/api/vaults', { cookie })).data;
  assert.equal(vaults.length, 1);
  const v = vaults[0].id;
  assert.ok((await call('GET', `/api/vaults/${v}/notes`, { cookie })).data.notes.length >= 5);

  // second user, viewer role
  assert.equal((await call('POST', '/api/admin/users', { cookie, body: { username: 'bob', password: 'password123' } })).status, 201);
  const bobLogin = await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'password123' } });
  const bob = bobLogin.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', `/api/vaults/${v}/notes`, { cookie: bob })).status, 404); // not a member
  await call('PUT', `/api/vaults/${v}/members/bob`, { cookie, body: { role: 'viewer' } });
  assert.equal((await call('GET', `/api/vaults/${v}/notes`, { cookie: bob })).status, 200);
  assert.equal((await call('PUT', `/api/vaults/${v}/notes/x`, { cookie: bob, body: { content: 'hi' } })).status, 403);
  await call('PUT', `/api/vaults/${v}/members/bob`, { cookie, body: { role: 'editor' } });

  // concurrent edits by two users
  const created = await call('PUT', `/api/vaults/${v}/notes/Shared`, { cookie, body: { content: 'l1\nl2\nl3' } });
  assert.equal(created.status, 200);
  const rev0 = created.data.rev;
  await call('PUT', `/api/vaults/${v}/notes/Shared`, { cookie, body: { content: 'L1\nl2\nl3', baseRev: rev0 } });
  const stale = await call('PUT', `/api/vaults/${v}/notes/Shared`, { cookie: bob, body: { content: 'l1\nl2\nL3', baseRev: rev0 } });
  assert.equal(stale.data.merged, true);
  assert.equal(stale.data.content, 'L1\nl2\nL3');
  const conflict = await call('PUT', `/api/vaults/${v}/notes/Shared`, { cookie: bob, body: { content: 'x\nl2\nL3', baseRev: rev0 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'conflict');

  // API token with read scope only
  const tok = (await call('POST', '/api/tokens', { cookie, body: { name: 'ai', scopes: ['read'] } })).data.token;
  assert.match(tok, /^vf_/);
  assert.equal((await call('GET', `/api/vaults/${v}/search?q=graph`, { token: tok })).data.results.length > 0, true);
  assert.equal((await call('POST', `/api/vaults/${v}/ops/append`, { token: tok, body: { path: 'Shared', text: 'x' } })).status, 403);
  const wtok = (await call('POST', '/api/tokens', { cookie, body: { name: 'agent', scopes: ['read', 'write'] } })).data.token;

  // MCP over the HTTP API
  const mcp = createMcpHandler({ url: base, token: wtok, defaultVault: v });
  const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(list.result.tools.some((x) => x.name === 'vaultfree_write_note'));
  const ap = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vaultfree_append_note', arguments: { path: 'Inbox', text: 'idea from AI [[Welcome]]' } } });
  assert.notEqual(ap.result.isError, true);
  const bad = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vaultfree_write_note', arguments: { path: 'Inbox', content: 'overwrite' } } });
  assert.equal(bad.result.isError, true); // missing base_rev is refused

  // graph and AI endpoints
  const g = (await call('GET', `/api/vaults/${v}/graph`, { token: tok })).data;
  assert.ok(g.nodes.length >= 7 && g.edges.length >= 6);
  assert.ok((await call('GET', `/api/vaults/${v}/context?q=merge`, { token: tok })).data.notes.length > 0);
  assert.ok((await call('GET', `/api/vaults/${v}/chunks`, { token: tok })).data.chunks.length > 0);
  assert.equal((await call('GET', `/api/vaults/${v}/notes/..%2F..%2Fauth.json`, { token: tok })).status, 400);
  assert.equal((await call('GET', `/api/vaults/${v}/verify`, { cookie })).data.ok, true);

  // static + llms.txt
  assert.equal((await fetch(base + '/llms.txt')).status, 200);
});
