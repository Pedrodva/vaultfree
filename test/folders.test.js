import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';

const mk = async () => (await Vault.create(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-fold-')), { id: 't', name: 't', members: {}, createdAt: 0 })).load();

test('folders: nested, empty, move with link rewrite, delete only when empty', async () => {
  const v = await mk();
  await v.mkdir('A/B/C');
  assert.deepEqual(v.listFolders(), ['A', 'A/B', 'A/B/C']);
  await v.write('A/B/Note', 'see [[Other]]');
  await v.write('Other', 'links back to [[Note]]');
  await v.saveFile('A/B/pic.png', Buffer.from([1, 2, 3]));

  await assert.rejects(v.rmdir('A/B'), { code: 'not_empty' });
  await v.rmdir('A/B/C'); // empty -> ok
  assert.equal(v.folders.has('A/B/C'), false);

  // rename the folder: notes, attachments and empty subfolders follow; links keep working
  await v.mkdir('A/B/Empty');
  const r = await v.moveFolder('A', 'Z/Renamed');
  assert.equal(r.moved, 2);
  assert.ok(v.index.notes.has('Z/Renamed/B/Note.md'));
  assert.ok(v.files.has('Z/Renamed/B/pic.png'));
  assert.ok(v.folders.has('Z/Renamed/B/Empty'));
  assert.equal(v.folders.has('A'), false);
  assert.deepEqual(v.index.backlinks('Z/Renamed/B/Note.md').map((b) => b.path), ['Other.md']);
  assert.equal((await v.read('Other')).content, 'links back to [[Note]]'); // bare name still unique

  await assert.rejects(v.moveFolder('Z', 'Z/inside'), { code: 'invalid_path' });
  await v.write('Z/Renamed/B/Note2', 'x');
  await v.mkdir('Q');
  await v.write('Q/Renamed/B/Note', 'collision'); // same relative path elsewhere is fine
  assert.equal((await v.verify()).problems.filter((p) => !/outside/.test(p)).length, 0);
});

test('folders survive a restart (empty ones too)', async () => {
  const v = await mk();
  await v.mkdir('Empty/Deep');
  await v.write('Full/N', 'x');
  const v2 = await new Vault(v.root, v.meta).load();
  assert.deepEqual(v2.listFolders(), ['Empty', 'Empty/Deep', 'Full']);
});
