import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('trash: deleted notes can be listed and restored (name clash gets a new name)', async () => {
  const v = await Vault.create(tmp('vf-trash-'), { id: 't', name: 't', members: {}, createdAt: 0 }).then((x) => x.load());
  await v.write('Folder/Idea', 'precious content', { user: 'ana' });
  await v.delete('Folder/Idea', { user: 'ana' });
  const trash = await v.listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].path, 'Folder/Idea.md');
  await assert.rejects(v.restoreTrash('../../etc/passwd'), { code: 'invalid_id' });
  const r = await v.restoreTrash(trash[0].id, { user: 'ana' });
  assert.equal(r.path, 'Folder/Idea.md');
  assert.equal((await v.read('Folder/Idea')).content, 'precious content');
  assert.equal((await v.listTrash()).length, 0);
  // delete again, but the name is taken by a new note -> restored under another name
  await v.delete('Folder/Idea');
  await v.write('Folder/Idea', 'new one');
  const r2 = await v.restoreTrash((await v.listTrash())[0].id);
  assert.equal(r2.path, 'Folder/Idea (restored).md');
  assert.equal((await v.read('Folder/Idea')).content, 'new one');
  v.close();
});

test('account: password change, admin reset, vault deletion', async (t) => {
  const app = await createApp(loadConfig({}, { dataDir: tmp('vf-acc-'), port: 0, host: '127.0.0.1' }));
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  t.after(() => app.close());
  const j = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  const cookieOf = (r) => r.res.headers.get('set-cookie').split(';')[0];
  const reg = await j('POST', '/api/auth/register', { body: { username: 'admin', password: 'old-password-1' } });
  const c1 = cookieOf(reg);
  const second = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'old-password-1' } }));

  assert.equal((await j('POST', '/api/auth/password', { cookie: c1, body: { current: 'wrong', next: 'new-password-2' } })).status, 403);
  assert.equal((await j('POST', '/api/auth/password', { cookie: c1, body: { current: 'old-password-1', next: 'short' } })).status, 400);
  assert.equal((await j('POST', '/api/auth/password', { cookie: c1, body: { current: 'old-password-1', next: 'new-password-2' } })).status, 200);
  assert.equal((await j('GET', '/api/auth/me', { cookie: c1 })).status, 200); // this session stays
  assert.equal((await j('GET', '/api/auth/me', { cookie: second })).status, 401); // other sessions are signed out
  assert.equal((await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'old-password-1' } })).status, 401);
  assert.equal((await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'new-password-2' } })).status, 200);

  // admin resets another user's password
  const bob = (await j('POST', '/api/admin/users', { cookie: c1, body: { username: 'bob', password: 'bobs-password-1' } })).data.user;
  assert.equal((await j('POST', `/api/admin/users/${bob.id}/password`, { cookie: c1, body: { password: 'reset-password-3' } })).status, 200);
  const bobCookie = cookieOf(await j('POST', '/api/auth/login', { body: { username: 'bob', password: 'reset-password-3' } }));
  assert.equal((await j('POST', `/api/admin/users/${bob.id}/password`, { cookie: bobCookie, body: { password: 'hacked-password' } })).status, 403);

  // vault deletion needs the owner and the vault id as confirmation; data goes to .trash
  const v = (await j('GET', '/api/vaults', { cookie: c1 })).data.vaults[0].id;
  assert.equal((await j('DELETE', `/api/vaults/${v}`, { cookie: c1 })).status, 400);
  assert.equal((await j('DELETE', `/api/vaults/${v}?confirm=${v}`, { cookie: bobCookie })).status, 404); // bob is not a member
  assert.equal((await j('DELETE', `/api/vaults/${v}?confirm=${v}`, { cookie: c1 })).status, 200);
  assert.equal((await j('GET', '/api/vaults', { cookie: c1 })).data.vaults.length, 0);
  const trashDir = path.join(app.config.dataDir, '.trash');
  assert.equal(fs.readdirSync(trashDir).some((d) => d.startsWith(v + '-')), true);
});
