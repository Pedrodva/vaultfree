import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vaultfree.js');

test('real `vaultfree mcp` process speaks MCP over stdio against a live server', async (t) => {
  const app = await createApp(loadConfig({}, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-stdio-')), port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const j = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { data: await res.json().catch(() => ({})), res };
  };
  const reg = await j('POST', '/api/auth/register', { body: { username: 'owner', password: 'password123' } });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  const vault = (await j('GET', '/api/vaults', { cookie })).data.vaults[0].id;
  const token = (await j('POST', '/api/tokens', { cookie, body: { name: 'stdio', scopes: ['read', 'propose'] } })).data.token;

  const child = spawn(process.execPath, [CLI, 'mcp', '--url', base, '--token', token, '--vault', vault], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line); // every stdout line must be a JSON-RPC message
    pending.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), 10_000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'vaultfree');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); // notification: no reply expected
  const tools = (await rpc('tools/list')).result.tools;
  assert.ok(tools.length >= 11);
  assert.ok(tools.every((x) => x.name && x.inputSchema?.type === 'object'));

  const read = await rpc('tools/call', { name: 'vaultfree_read_note', arguments: { path: 'Welcome' } });
  assert.match(read.result.content[0].text, /Welcome to VaultFree/);
  const search = await rpc('tools/call', { name: 'vaultfree_search', arguments: { query: 'graph' } });
  assert.match(search.result.content[0].text, /Graph View/);

  // the propose-only token cannot write through MCP, but can propose
  const denied = await rpc('tools/call', { name: 'vaultfree_append_note', arguments: { path: 'Welcome', text: 'x' } });
  assert.equal(denied.result.isError, true);
  const proposed = await rpc('tools/call', { name: 'vaultfree_propose_change', arguments: { path: 'Welcome', append: 'from a real MCP process', message: 'hello' } });
  assert.notEqual(proposed.result.isError, true);
  const listed = await rpc('tools/call', { name: 'vaultfree_list_proposals', arguments: {} });
  assert.match(listed.result.content[0].text, /from a real MCP process|Welcome/);

  assert.equal((await rpc('nope/unknown')).error.code, -32601);
});
