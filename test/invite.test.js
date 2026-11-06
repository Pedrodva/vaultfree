import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { parseTunnelUrl } from '../server/tunnel.js';

test('tunnel url parsing', () => {
  assert.equal(parseTunnelUrl('INF |  https://quiet-fox-1234.trycloudflare.com  |'), 'https://quiet-fox-1234.trycloudflare.com');
  assert.equal(parseTunnelUrl('no url here https://example.com'), null);
});

test('publicUrl https turns on secure cookies and proxy trust', () => {
  const c = loadConfig({ VAULTFREE_PUBLIC_URL: 'https://notes.example.com/' });
  assert.equal(c.publicUrl, 'https://notes.example.com');
  assert.equal(c.secureCookies, true);
  assert.equal(c.trustProxy, true);
  assert.equal(loadConfig({}).secureCookies, false);
});

test('invite links: join without admin, roles, single use, revoke', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-inv-'));
  const app = await createApp(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1' }));
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(() => app.close());
  const call = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  const reg = await call('POST', '/api/auth/register', { body: { username: 'owner', password: 'password123' } });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  const v = (await call('GET', '/api/vaults', { cookie })).data.vaults[0].id;

  // owner role cannot be granted by invite
  assert.equal((await call('POST', `/api/vaults/${v}/invites`, { cookie, body: { role: 'owner' } })).status, 400);
  const inv = (await call('POST', `/api/vaults/${v}/invites`, { cookie, body: { role: 'editor', maxUses: 1, hours: 24 } })).data;
  assert.match(inv.token, /^vfi_/);
  assert.equal(JSON.stringify(inv).includes('hash'), false);

  // public preview
  const info = await call('GET', `/api/invites/${inv.token}`);
  assert.equal(info.data.role, 'editor');
  assert.equal((await call('GET', '/api/invites/vfi_bogus')).status, 404);

  // anonymous accept creates the account (sign-up is closed!) and joins the vault
  const acc = await call('POST', `/api/invites/${inv.token}/accept`, { body: { username: 'carol', password: 'password123', displayName: 'Carol' } });
  assert.equal(acc.status, 200);
  const carol = acc.res.headers.get('set-cookie').split(';')[0];
  const w = await call('PUT', `/api/vaults/${v}/notes/FromCarol`, { cookie: carol, body: { content: 'hi' } });
  assert.equal(w.status, 200);
  // not an admin, cannot invite or create users
  assert.equal((await call('POST', `/api/vaults/${v}/invites`, { cookie: carol, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/admin/users', { cookie: carol, body: { username: 'x', password: 'password123' } })).status, 403);

  // single use: second accept fails
  assert.equal((await call('POST', `/api/invites/${inv.token}/accept`, { body: { username: 'dave', password: 'password123' } })).status, 404);

  // revoke works; viewer invite for an existing logged-in user
  const inv2 = (await call('POST', `/api/vaults/${v}/invites`, { cookie, body: { role: 'viewer' } })).data;
  const list = (await call('GET', `/api/vaults/${v}/invites`, { cookie })).data.invites;
  assert.equal(list.length, 1);
  await call('DELETE', `/api/vaults/${v}/invites/${inv2.invite.id}`, { cookie });
  assert.equal((await call('GET', `/api/invites/${inv2.token}`)).status, 404);

  // share endpoint is admin-only and reports availability
  assert.equal((await call('GET', '/api/admin/share', { cookie: carol })).status, 403);
  assert.equal(typeof (await call('GET', '/api/admin/share', { cookie })).data.available, 'boolean');
});

import { Auth } from '../server/auth.js';

test('invites can be set to never expire; sessions renew while in use', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-auth-'));
  const auth = new Auth(dir);
  const u = await auth.createUser({ username: 'ann', password: 'password123' });
  const { token, invite } = await auth.createInvite(u.id, { vault: 'v', role: 'editor', maxUses: 1, hours: 0 });
  assert.equal(invite.expires, null);
  // a year later it is still valid
  const realNow = Date.now;
  Date.now = () => realNow() + 365 * 24 * 3600 * 1000;
  try { assert.equal(auth.findInvite(token).vault, 'v'); assert.equal(auth.listInvites('v').length, 1); } finally { Date.now = realNow; }
  // timed invites still expire
  const t2 = await auth.createInvite(u.id, { vault: 'v', role: 'viewer', hours: 1 });
  Date.now = () => realNow() + 2 * 3600 * 1000;
  try { assert.throws(() => auth.findInvite(t2.token), { code: 'invite_invalid' }); } finally { Date.now = realNow; }

  // sliding session: used after 60 days -> expiry is pushed out again
  const s = await auth.login('ann', 'password123');
  const rec = auth.state.sessions[0];
  const before = rec.expires;
  Date.now = () => realNow() + 60 * 24 * 3600 * 1000;
  try { assert.ok(auth.authenticate(null, s.token)); assert.ok(rec.expires > before + 50 * 24 * 3600 * 1000); } finally { Date.now = realNow; }
  await auth.queue;
});
