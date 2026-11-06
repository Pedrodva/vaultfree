import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('edits made outside VaultFree are never overwritten by a later save', async () => {
  const v = await Vault.create(tmp('vf-ext-'), { id: 't', name: 't', members: {}, createdAt: 0 }).then((x) => x.load());
  t_cleanup(v);
  const first = await v.write('N', 'line1\nline2\nline3');
  // someone edits the file directly on disk (Obsidian, git pull, sync tool) while the server runs
  fs.writeFileSync(v.abs('N.md'), 'line1\nline2\nline3\nadded-outside');
  // a user who read the old revision saves a change to another line
  const r = await v.write('N', 'LINE1\nline2\nline3', { baseRev: first.rev, user: 'alice' });
  assert.equal(r.merged, true);
  assert.equal(r.content, 'LINE1\nline2\nline3\nadded-outside');
  assert.equal(fs.readFileSync(v.abs('N.md'), 'utf8'), r.content);
  // external create and delete are noticed on demand too
  fs.writeFileSync(v.abs('Fresh.md'), 'made elsewhere');
  assert.equal((await v.read('Fresh')).content, 'made elsewhere');
  fs.unlinkSync(v.abs('Fresh.md'));
  await assert.rejects(v.read('Fresh'), { code: 'not_found' });
  assert.ok((await v.history('N')).some((h) => h.user === 'external'));
});
function t_cleanup(v) { process.on('exit', () => v.close()); }

test('read-only tokens can use the MCP endpoint for reads but not writes', async (t) => {
  const app = await createApp(loadConfig({}, { dataDir: tmp('vf-ro-'), port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const j = async (method, url, { body, cookie, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  const reg = await j('POST', '/api/auth/register', { body: { username: 'owner', password: 'password123' } });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  const v = (await j('GET', '/api/vaults', { cookie })).data.vaults[0].id;
  const ro = (await j('POST', '/api/tokens', { cookie, body: { name: 'ro', scopes: ['read'] } })).data.token;
  const call = (name, args) => j('POST', '/mcp', { token: ro, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { vault: v, ...args } } } });
  const read = await call('vaultfree_search', { query: 'welcome' });
  assert.notEqual(read.data.result.isError, true);
  const write = await call('vaultfree_append_note', { path: 'Hacked', text: 'x' });
  assert.equal(write.data.result.isError, true);
  assert.match(write.data.result.content[0].text, /write scope/);
});

test('markdown renderer neutralises XSS payloads', async () => {
  // markdown.js imports '/shared/parse.js' (a browser path): point it at the real file for Node
  const src = fs.readFileSync('web/js/markdown.js', 'utf8').replace("'/shared/parse.js'", JSON.stringify(pathToFileURL(path.resolve('shared/parse.js')).href));
  const dir = tmp('vf-md-');
  const file = path.join(dir, 'markdown.mjs');
  fs.writeFileSync(file, src);
  const { renderMarkdown } = await import(pathToFileURL(file).href);
  const ctx = { resolve: (t) => (t === 'ok' ? 'ok.md' : null), fileUrl: () => '/files/x.png' };
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](java\tscript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '![x](javascript:alert(1))',
    '[[x" onmouseover="alert(1)]]',
    '![[x" onerror="alert(1).png]]',
    '> [!note" onclick="alert(1)] title',
    '#tag"onmouseover="alert(1)',
    '| a |\n|---|\n| <b onmouseover=alert(1)>x</b> |',
    '```\n</code></pre><script>alert(1)</script>\n```',
    '---\ntitle: <script>alert(1)</script>\ntags: ["><img src=x onerror=alert(1)>]\n---\nbody',
  ];
  for (const p of payloads) {
    const html = renderMarkdown(p, ctx);
    assert.doesNotMatch(html, /<script/i, p);
    // inspect only real tags (text is escaped, so a literal "<" never survives); ignore quoted attribute values
    for (const tag of html.match(/<[^>]*>/g) || []) {
      assert.doesNotMatch(tag.replace(/="[^"]*"/g, '=""'), /\son\w+\s*=/i, 'event handler attribute in ' + tag + ' for ' + p);
    }
    assert.doesNotMatch(html, /href="\s*javascript:/i, p);
    assert.doesNotMatch(html, /href="data:/i, p);
    assert.doesNotMatch(html, /src="javascript:/i, p);
  }
  // sanity: normal content still renders
  assert.match(renderMarkdown('**bold** [[ok]] #tag', ctx), /<strong>bold<\/strong>.*internal-link.*class="tag"/);
});
