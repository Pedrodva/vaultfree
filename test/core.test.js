import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNote, maskCode, replaceWikiLinks } from '../shared/parse.js';
import { merge3 } from '../shared/merge.js';
import { createResolver } from '../shared/resolve.js';
import { Vault } from '../server/vault.js';
import { normalizePath } from '../server/util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
const mkVault = async () => {
  const v = await Vault.create(tmp(), { id: 't', name: 't', members: {}, createdAt: 0 });
  return v.load();
};

test('parse: links, tags, frontmatter, ignores code', () => {
  const n = parseNote('a.md', '---\ntags: [x, y]\ntitle: Hello\n---\n# H\nSee [[B|alias]] and [[C#Sec]] #t1\n`[[nope]]`\n```\n[[nope2]] #nope\n```\n![[img.png]]');
  assert.equal(n.title, 'Hello');
  assert.deepEqual(n.links.map((l) => l.target), ['B', 'C', 'img.png']);
  assert.deepEqual(n.tags.sort(), ['t1', 'x', 'y']);
  assert.equal(maskCode('`a`').trim(), '');
});

test('resolver: prefers closest, handles paths', () => {
  const r = createResolver(['a/Note.md', 'b/Note.md', 'b/Other.md', 'Top.md']);
  assert.equal(r('Note', 'b/Other.md'), 'b/Note.md');
  assert.equal(r('a/Note'), 'a/Note.md');
  assert.equal(r('top'), 'Top.md');
  assert.equal(r('missing'), null);
});

test('merge3: clean merge and conflict', () => {
  const base = 'a\nb\nc\nd';
  assert.deepEqual(merge3(base, 'A\nb\nc\nd', 'a\nb\nc\nD'), { text: 'A\nb\nc\nD', conflict: false });
  const r = merge3(base, 'a\nX\nc\nd', 'a\nY\nc\nd');
  assert.equal(r.conflict, true);
  assert.match(r.text, /<<<<<<< yours/);
});

test('paths are validated', () => {
  assert.equal(normalizePath('Folder/Note'), 'Folder/Note.md');
  assert.equal(normalizePath('/etc/passwd'), 'etc/passwd.md'); // leading slash stripped, stays inside the vault
  for (const bad of ['../x', 'a/../../b', '.vaultfree/x', 'a/.hidden', 'CON', 'a\0b', '']) {
    assert.throws(() => normalizePath(bad), { code: 'invalid_path' }, bad);
  }
});

test('vault: create, stale write merges, conflict is reported, nothing lost', async () => {
  const v = await mkVault();
  const c = await v.write('n', 'one\ntwo\nthree', { user: 'alice' });
  assert.equal(c.created, true);
  await assert.rejects(v.write('n', 'x'), { code: 'base_rev_required' });
  const w1 = await v.write('n', 'ONE\ntwo\nthree', { baseRev: c.rev, user: 'alice' });
  const w2 = await v.write('n', 'one\ntwo\nTHREE', { baseRev: c.rev, user: 'bob' }); // stale
  assert.equal(w2.merged, true);
  assert.equal(w2.content, 'ONE\ntwo\nTHREE');
  await assert.rejects(v.write('n', 'one\nBOB\nTHREE', { baseRev: c.rev, user: 'bob' }), (e) => e.code === 'conflict' && e.extra.current.content === w2.content);
  assert.equal((await v.history('n')).length >= 2, true);
  const r = await v.restore('n', c.rev, { user: 'alice' });
  assert.equal(r.content, 'one\ntwo\nthree');
  assert.equal((await v.verify()).ok, true);
  assert.notEqual(w1.rev, w2.rev);
});

test('vault: rename rewrites incoming links; backlinks and unresolved', async () => {
  const v = await mkVault();
  await v.write('A', 'link to [[B]] and [[B#h|alias]] and [[Ghost]]');
  await v.write('B', 'hi');
  assert.deepEqual(v.index.backlinks('B.md').map((b) => b.path), ['A.md']);
  const res = await v.rename('B', 'Sub/Renamed');
  assert.deepEqual(res.updated, ['A.md']);
  assert.equal((await v.read('A')).content, 'link to [[Renamed]] and [[Renamed#h|alias]] and [[Ghost]]');
  assert.deepEqual(v.index.backlinks('Sub/Renamed.md').map((b) => b.path), ['A.md']);
  const g = v.index.graph({ unresolved: true });
  assert.equal(g.nodes.some((n) => n.type === 'unresolved' && n.label === 'ghost'), true);
  assert.equal(g.edges.length, 2);
  assert.equal(replaceWikiLinks('`[[x]]` [[x]]', () => 'y'), '`[[x]]` [[y]]');
});

test('index: search ranking, filters, local graph, chunks, context', async () => {
  const v = await mkVault();
  await v.write('Cats', '# Cats\nCats purr. #animal\nSee [[Dogs]]');
  await v.write('Dogs', '# Dogs\nDogs bark loudly. #animal\nSee [[Birds]]');
  await v.write('Birds', 'Birds sing. #animal/flying');
  await v.write('Far', 'unrelated [[Birds]]');
  const s = v.index.search('purr');
  assert.equal(s[0].path, 'Cats.md');
  assert.equal(v.index.search('tag:animal').length, 4 - 1);
  assert.equal(v.index.search('"bark loudly"')[0].path, 'Dogs.md');
  assert.equal(v.index.search('bar')[0].path, 'Dogs.md'); // prefix
  const g = v.index.graph({ center: 'Cats.md', depth: 1 });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['Cats.md', 'Dogs.md']);
  assert.equal(v.index.graph({ center: 'Cats.md', depth: 2 }).nodes.length, 3);
  assert.equal(v.index.tags().find((t) => t.tag === 'animal').count, 3);
  assert.ok(v.index.chunks({ maxChars: 50 }).length >= 4);
  const ctx = v.index.context('dogs bark', { budget: 5000 });
  assert.equal(ctx.notes[0].path, 'Dogs.md');
});

test('verify detects tampering of stored objects', async () => {
  const v = await mkVault();
  const w = await v.write('n', 'hello');
  fs.writeFileSync(v.objPath(w.rev), 'tampered');
  const r = await v.verify();
  assert.equal(r.ok, false);
});
