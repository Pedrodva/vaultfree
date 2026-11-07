import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';

test('activity feed: newest first, includes merges, appends by agents, renames', async () => {
  const v = await Vault.create(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-act-')), { id: 't', name: 't', members: {}, createdAt: 0 }).then((x) => x.load());
  const a = await v.write('Note', 'l1\nl2\nl3', { user: 'ana' });
  await v.write('Note', 'L1\nl2\nl3', { baseRev: a.rev, user: 'ana' });
  await v.write('Note', 'l1\nl2\nL3', { baseRev: a.rev, user: 'luis' }); // stale -> merged
  await v.append('Log', 'agent line', { user: 'bot(api)' });
  await v.rename('Log', 'Archive/Log', { user: 'ana' });

  const feed = await v.activity(10);
  assert.equal(feed[0].action, 'rename');
  assert.equal(feed[0].from, 'Log.md');
  assert.ok(feed.some((e) => e.action === 'merge' && e.user === 'luis' && e.path === 'Note.md'));
  assert.ok(feed.some((e) => e.action === 'append' && e.user === 'bot(api)'));
  assert.ok(feed.every((e, i) => i === 0 || feed[i - 1].ts >= e.ts));
  assert.equal(feed[0].hash, undefined); // internal fields are not exposed
  assert.equal((await v.activity(2)).length, 2);
  v.close();
});
