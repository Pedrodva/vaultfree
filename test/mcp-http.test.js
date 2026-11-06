import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

test('remote MCP over HTTP and folder endpoints', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-mcph-'));
  const app = await createApp(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const call = async (method, url, { body, cookie, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* empty body */ }
    return { status: res.status, data, res };
  };
  const reg = await call('POST', '/api/auth/register', { body: { username: 'owner', password: 'password123' } });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  const v = (await call('GET', '/api/vaults', { cookie })).data.vaults[0].id;
  const token = (await call('POST', '/api/tokens', { cookie, body: { name: 'mcp' } })).data.token;

  // ---- /mcp ----
  const rpc = (msg, tok = token) => call('POST', '/mcp', { token: tok, body: msg });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status, 401); // no token
  assert.equal((await call('POST', '/mcp', { cookie, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401); // cookies are not accepted
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.data.result.serverInfo.name, 'vaultfree');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.data.result.tools.length >= 9);
  const wr = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vaultfree_append_note', arguments: { vault: v, path: 'FromAI', text: 'hello from a remote agent' } } });
  assert.notEqual(wr.data.result.isError, true);
  const batch = await rpc([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vaultfree_read_note', arguments: { vault: v, path: 'FromAI' } } }]);
  assert.equal(batch.data.length, 2);
  assert.match(batch.data[1].result.content[0].text, /remote agent/);
  assert.equal((await call('GET', '/mcp', { token })).status, 405);

  // ---- folders via API ----
  const mk = await call('POST', `/api/vaults/${v}/ops/mkdir`, { cookie, body: { path: 'Docs/Guides' } });
  assert.equal(mk.status, 200);
  assert.deepEqual((await call('GET', `/api/vaults/${v}/notes`, { cookie })).data.folders.filter((f) => f.startsWith('Docs')), ['Docs', 'Docs/Guides']);
  await call('PUT', `/api/vaults/${v}/notes/Docs/Guides/Start`, { cookie, body: { content: 'hi' } });
  assert.equal((await call('DELETE', `/api/vaults/${v}/folders/Docs`, { cookie })).data.error.code, 'not_empty');
  const mv = await call('POST', `/api/vaults/${v}/ops/move-folder`, { cookie, body: { from: 'Docs', to: 'Manual' } });
  assert.equal(mv.data.moved, 1);
  const notes = (await call('GET', `/api/vaults/${v}/notes`, { cookie })).data;
  assert.ok(notes.notes.some((n) => n.path === 'Manual/Guides/Start.md'));
  assert.equal(notes.folders.includes('Docs'), false);
  // read-only token cannot create folders
  const ro = (await call('POST', '/api/tokens', { cookie, body: { name: 'ro', scopes: ['read'] } })).data.token;
  assert.equal((await call('POST', `/api/vaults/${v}/ops/mkdir`, { token: ro, body: { path: 'X' } })).status, 403);
});
