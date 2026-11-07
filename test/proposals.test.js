import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createMcpHandler } from '../server/mcp.js';
import { diffLines } from '../shared/merge.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('diffLines marks additions, deletions and unchanged lines', () => {
  const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(d.map((x) => x.t + ':' + x.line), ['same:a', 'del:b', 'add:B', 'same:c', 'add:d']);
});

test('proposals: update merges on accept, create, append, dismiss, double decision', async () => {
  const v = await Vault.create(tmp('vf-prop-'), { id: 't', name: 't', members: {}, createdAt: 0 }).then((x) => x.load());
  const n = await v.write('Plan', 'one\ntwo\nthree', { user: 'ana' });

  // the agent proposes a change to line 3 based on what it read
  const p1 = await v.propose({ path: 'Plan', content: 'one\ntwo\nTHREE', baseRev: n.rev, message: 'fix typo', author: 'bot(api)' });
  assert.equal(p1.kind, 'update'); assert.equal(p1.status, 'open'); assert.equal(p1.content, undefined);
  // meanwhile a person edits line 1
  await v.write('Plan', 'ONE\ntwo\nthree', { baseRev: n.rev, user: 'ana' });
  assert.equal((await v.read('Plan')).content, 'ONE\ntwo\nthree'); // proposal did NOT change the note by itself
  const detail = await v.getProposal(p1.id);
  assert.equal(detail.base, 'one\ntwo\nthree');
  assert.equal(detail.current.content, 'ONE\ntwo\nthree');
  // accepting merges both changes
  const done = await v.decideProposal(p1.id, 'accept', { user: 'ana' });
  assert.equal(done.status, 'accepted'); assert.equal(done.merged, true);
  assert.equal((await v.read('Plan')).content, 'ONE\ntwo\nTHREE');
  await assert.rejects(v.decideProposal(p1.id, 'accept', { user: 'ana' }), { code: 'already_decided' });

  // create + append proposals
  const pc = await v.propose({ path: 'Ideas/New', content: '# New', message: 'start a note', author: 'bot(api)' });
  assert.equal(pc.kind, 'create');
  const pa = await v.propose({ path: 'Plan', append: '- agent todo', author: 'bot(api)' });
  assert.equal(pa.kind, 'append');
  assert.equal((await v.listProposals('open')).length, 2);
  await v.decideProposal(pc.id, 'accept', { user: 'ana' });
  await v.decideProposal(pa.id, 'accept', { user: 'ana' });
  assert.equal((await v.read('Ideas/New')).content, '# New');
  assert.match((await v.read('Plan')).content, /- agent todo/);

  // dismissed proposals change nothing; a stale create is refused with a clear error
  const pd = await v.propose({ path: 'Plan', content: 'overwrite everything', baseRev: (await v.read('Plan')).rev, author: 'bot(api)' });
  await v.decideProposal(pd.id, 'reject', { user: 'ana', reason: 'no thanks' });
  assert.match((await v.read('Plan')).content, /ONE/);
  const pc2 = await v.propose({ path: 'Brand new', content: 'x', author: 'bot(api)' });
  await v.write('Brand new', 'somebody was faster');
  await assert.rejects(v.decideProposal(pc2.id, 'accept', { user: 'ana' }), { code: 'exists' });
  assert.equal((await v.listProposals('open')).length, 1); // still open, nothing lost

  // validation
  await assert.rejects(v.propose({ path: 'X', author: 'b' }), { code: 'invalid_content' });
  await assert.rejects(v.propose({ path: 'X', content: 'a', append: 'b', author: 'b' }), { code: 'invalid_content' });
  await assert.rejects(v.propose({ path: 'Plan', content: 'a', baseRev: 'f'.repeat(64), author: 'b' }), { code: 'unknown_base' });
  v.close();
});

test('propose-only tokens cannot write but can propose; people approve', async (t) => {
  const app = await createApp(loadConfig({}, { dataDir: tmp('vf-prop-api-'), port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const j = async (method, url, { body, cookie, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  const reg = await j('POST', '/api/auth/register', { body: { username: 'owner', password: 'password123' } });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  const v = (await j('GET', '/api/vaults', { cookie })).data.vaults[0].id;
  const agent = (await j('POST', '/api/tokens', { cookie, body: { name: 'agent', scopes: ['read', 'propose'] } })).data;
  assert.deepEqual(agent.scopes.sort(), ['propose', 'read']);

  // direct writes are refused...
  assert.equal((await j('POST', `/api/vaults/${v}/ops/append`, { token: agent.token, body: { path: 'Welcome', text: 'x' } })).status, 403);
  assert.equal((await j('PUT', `/api/vaults/${v}/notes/Welcome`, { token: agent.token, body: { content: 'x' } })).status, 403);
  // ...but a proposal is fine, and accepting/dismissing is not allowed for it
  const welcome = (await j('GET', `/api/vaults/${v}/notes/Welcome`, { token: agent.token })).data;
  const pr = await j('POST', `/api/vaults/${v}/proposals`, { token: agent.token, body: { path: 'Welcome', content: welcome.content + '\nAgent was here.\n', baseRev: welcome.rev, message: 'add a line' } });
  assert.equal(pr.status, 201);
  assert.equal(pr.data.author, 'owner(api)');
  assert.equal((await j('POST', `/api/vaults/${v}/proposals/${pr.data.id}/accept`, { token: agent.token })).status, 403);
  assert.doesNotMatch((await j('GET', `/api/vaults/${v}/notes/Welcome`, { cookie })).data.content, /Agent was here/);

  // the person reviews and accepts
  const detail = (await j('GET', `/api/vaults/${v}/proposals/${pr.data.id}`, { cookie })).data;
  assert.equal(detail.base, welcome.content);
  assert.equal((await j('POST', `/api/vaults/${v}/proposals/${pr.data.id}/accept`, { cookie })).status, 200);
  assert.match((await j('GET', `/api/vaults/${v}/notes/Welcome`, { cookie })).data.content, /Agent was here/);
  const feed = (await j('GET', `/api/vaults/${v}/activity`, { cookie })).data.activity;
  assert.ok(feed.some((e) => e.action === 'propose' && e.user === 'owner(api)'));
  assert.ok(feed.some((e) => e.action === 'proposal' && e.user === 'owner'));

  // MCP: the propose tool works with this token, the write tool is refused
  const mcp = createMcpHandler({ url: base, token: agent.token, defaultVault: v });
  const call = (name, args) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tools = (await mcp({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).result.tools.map((x) => x.name);
  assert.ok(tools.includes('vaultfree_propose_change') && tools.includes('vaultfree_list_proposals'));
  const viaMcp = await call('vaultfree_propose_change', { path: 'Inbox', append: 'idea from MCP', message: 'capture' });
  assert.notEqual(viaMcp.result.isError, true);
  assert.equal((await call('vaultfree_append_note', { path: 'Inbox', text: 'direct' })).result.isError, true);
  assert.match((await call('vaultfree_list_proposals', {})).result.content[0].text, /Inbox/);

  // a viewer cannot propose
  const inv = (await j('POST', `/api/vaults/${v}/invites`, { cookie, body: { role: 'viewer' } })).data;
  const acc = await j('POST', `/api/invites/${inv.token}/accept`, { body: { username: 'guest', password: 'password123' } });
  const guest = acc.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await j('POST', `/api/vaults/${v}/proposals`, { cookie: guest, body: { path: 'X', content: 'y' } })).status, 403);
});
