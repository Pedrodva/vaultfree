import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

test('fork: member copies a vault (or folder) into one they own; owner can forbid it', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-fork-'));
  const app = await createApp(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const call = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  const reg = await call('POST', '/api/auth/register', { body: { username: 'owner', password: 'password123' } });
  const owner = reg.res.headers.get('set-cookie').split(';')[0];
  const v = (await call('GET', '/api/vaults', { cookie: owner })).data.vaults[0].id;
  const inv = (await call('POST', `/api/vaults/${v}/invites`, { cookie: owner, body: { role: 'viewer' } })).data;
  const acc = await call('POST', `/api/invites/${inv.token}/accept`, { body: { username: 'guest', password: 'password123' } });
  const guest = acc.res.headers.get('set-cookie').split(';')[0];

  // a read-only guest can take a private copy of a folder
  const f = await call('POST', `/api/vaults/${v}/ops/fork`, { cookie: guest, body: { name: 'Mine', folder: 'Projects' } });
  assert.equal(f.status, 201);
  assert.equal(f.data.notes, 1);
  const mine = await call('GET', `/api/vaults/${f.data.id}/notes`, { cookie: guest });
  assert.deepEqual(mine.data.notes.map((n) => n.path), ['Projects/Roadmap.md']);
  // it is theirs: owner role, editable, and the original owner is NOT a member
  assert.equal((await call('GET', '/api/vaults', { cookie: guest })).data.vaults.find((x) => x.id === f.data.id).role, 'owner');
  assert.equal((await call('PUT', `/api/vaults/${f.data.id}/notes/Mine`, { cookie: guest, body: { content: 'private' } })).status, 200);
  assert.equal((await call('GET', `/api/vaults/${f.data.id}/notes`, { cookie: owner })).status, 200); // admin sees all, but is not a member:
  const members = (await call('GET', `/api/vaults/${f.data.id}/members`, { cookie: guest })).data.members;
  assert.deepEqual(members.map((m) => m.username), ['guest']);

  // full copy works, and the original is untouched
  const all = await call('POST', `/api/vaults/${v}/ops/fork`, { cookie: guest, body: { name: 'Everything' } });
  assert.ok(all.data.notes >= 6);

  // owner forbids copying: export and fork are refused for members, still fine for the owner
  assert.equal((await call('PATCH', `/api/vaults/${v}`, { cookie: owner, body: { allowCopy: false } })).status, 200);
  const blocked = await call('POST', `/api/vaults/${v}/ops/fork`, { cookie: guest, body: { name: 'Nope' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'copy_disabled');
  assert.equal((await call('GET', `/api/vaults/${v}/export`, { cookie: guest })).status, 403);
  assert.equal((await call('GET', `/api/vaults/${v}/export`, { cookie: owner })).status, 200);
  // guests cannot change the setting
  assert.equal((await call('PATCH', `/api/vaults/${v}`, { cookie: guest, body: { allowCopy: true } })).status, 403);
});
