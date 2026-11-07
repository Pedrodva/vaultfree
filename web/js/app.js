import { $, h, api, toast, modal, ask, confirmBox, picker, fmtTime, debounce, baseName } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { t, tf, lang, setLang } from './i18n.js';

const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
import { GraphView } from './graph.js';
import { createResolver } from '/shared/resolve.js';
import { merge3 } from '/shared/merge.js';

const ls = (k, d) => { try { return JSON.parse(localStorage.getItem('vf.' + k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => localStorage.setItem('vf.' + k, JSON.stringify(v));
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

const S = {
  user: null, canCreate: true, vaults: [], vault: null, notes: [], files: [], resolve: () => null, tags: [],
  cur: null, view: 'note', mode: ls('mode', 'split'), sbTab: 'files', rbTab: ls('rb', 'activity'),
  presence: [], collapsed: new Set(ls('collapsed', [])), es: null, gv: null, local: null, searchQ: '',
  gs: Object.assign({ q: '', tag: '', orphans: true, unresolved: false, tags: false, arrows: false, style: 'constellation', textFade: 0.8, nodeSize: 1,
    linkThickness: 1, centerForce: 0.07, repelForce: 2, linkForce: 1, linkDistance: 95, groups: [], colorBy: 'folder', depth: 1 }, ls('graph', {})),
};
const V = () => S.vault.id;
const API = (p = '') => `/api/vaults/${V()}${p}`;
const R = {}; // persistent DOM refs

// ───────────────────────── boot / auth ─────────────────────────
function applyTheme() { document.documentElement.dataset.theme = ls('theme', 'dark'); }
applyTheme();

const inviteToken = () => /[#&]invite=([\w-]+)/.exec(location.hash)?.[1] || null;

async function boot() {
  const cfg = await api('GET', '/api/config');
  S.cfg = cfg;
  try {
    const me = await api('GET', '/api/auth/me');
    S.user = me.user; S.canCreate = me.canCreateVaults;
    await enterWorkspace();
    await handleInvite();
  } catch (e) {
    if (e.status === 401) renderAuth(cfg, inviteToken()); else { document.body.textContent = 'Failed to start: ' + e.message; }
  }
}

// Logged-in user opened an invite link: confirm and join
async function handleInvite() {
  const tok = inviteToken();
  if (!tok) return;
  history.replaceState(null, '', location.pathname);
  try {
    const info = await api('GET', '/api/invites/' + tok);
    if (!(await confirmBox(t('Join vault'), 'Join “' + info.vault + '” as ' + info.role + '?', t('Join')))) return;
    const r = await api('POST', '/api/invites/' + tok + '/accept', {});
    lsSet('vault', r.vault);
    await enterWorkspace();
    toast('You joined the vault', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function renderAuth(cfg, invite = null) {
  let register = cfg.needsSetup || !!invite;
  let inviteInfo = null, inviteErr = '';
  if (invite) { try { inviteInfo = await api('GET', '/api/invites/' + invite); } catch (e) { inviteErr = e.message; invite = null; register = cfg.needsSetup; } }
  const root = $('#app');
  const draw = () => {
    const err = h('div', { class: 'err' });
    const u = h('input', { class: 'input', placeholder: t('Username'), autocomplete: 'username', required: true });
    const d = h('input', { class: 'input', placeholder: t('Display name (optional)') });
    const p = h('input', { class: 'input', type: 'password', placeholder: t('Password (min. 8)'), autocomplete: register ? 'new-password' : 'current-password', required: true });
    const f = h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try {
          const body = { username: u.value, password: p.value, displayName: d.value };
          let r;
          if (invite && register) r = await api('POST', '/api/invites/' + invite + '/accept', body);
          else {
            r = await api('POST', register ? '/api/auth/register' : '/api/auth/login', body);
            if (invite) r.vault = (await api('POST', '/api/invites/' + invite + '/accept', {})).vault;
          }
          if (r.vault) lsSet('vault', r.vault);
          if (invite) history.replaceState(null, '', location.pathname);
          S.user = r.user; S.canCreate = true; await enterWorkspace();
        } catch (x) { err.textContent = x.message; }
      },
    },
    h('h1', {}, 'Vault', h('span', {}, 'Free')),
    inviteInfo ? h('div', { class: 'muted' }, 'You were invited to “' + inviteInfo.vault + '” as ' + inviteInfo.role + '. ' + (register ? 'Create your account to join.' : 'Sign in to join.'))
      : h('div', { class: 'muted' }, cfg.needsSetup ? 'Welcome! Create the first account — it becomes the administrator.' : register ? 'Create your account' : 'Sign in to your knowledge base'),
    inviteErr && h('div', { class: 'err' }, inviteErr),
    u, register && d, p, err,
    h('button', { class: 'btn primary' }, register ? t('Create account') : t('Sign in')),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); setLang(lang === 'es' ? 'en' : 'es'); location.reload(); } }, lang === 'es' ? 'English' : 'Español'),
    (cfg.allowSignup || invite) && !cfg.needsSetup && h('a', { href: '#', onclick: (e) => { e.preventDefault(); register = !register; draw(); } }, register ? t('I already have an account') : t('Create an account')));
    root.replaceChildren(h('div', { class: 'auth' }, f));
    u.focus();
  };
  draw();
}

async function logout() {
  await api('POST', '/api/auth/logout', {});
  S.es?.close(); location.reload();
}

// ───────────────────────── workspace shell ─────────────────────────
async function enterWorkspace() {
  S.vaults = (await api('GET', '/api/vaults')).vaults;
  buildShell();
  if (!S.vaults.length) {
    R.main.replaceChildren(h('div', { class: 'empty' }, h('div', {}, h('h2', {}, t('No vaults yet')),
      S.canCreate ? h('button', { class: 'btn primary', onclick: createVault }, t('Create your first vault')) : h('p', {}, 'Ask an owner to add you to a vault.'))));
    return;
  }
  await loadVault(ls('vault', null) && S.vaults.find((v) => v.id === ls('vault')) ? ls('vault') : S.vaults[0].id);
}

function buildShell() {
  const btn = (icon, title, fn, extra = '') => h('button', { class: 'icon-btn ' + extra, title, 'aria-label': title, onclick: fn }, icon);
  R.sidebar = h('aside', { class: 'sidebar' });
  R.main = h('main', { class: 'main' });
  R.right = h('aside', { class: 'rightbar' });
  R.ribbon = h('nav', { class: 'ribbon' },
    btn('◧', t('Toggle file panel'), () => togglePanel('left')),
    btn('◨', t('Toggle side panel'), () => togglePanel('right')),
    btn('📁', t('Files'), () => { S.sbTab = 'files'; renderSidebar(); }),
    btn('🔍', t('Search (Ctrl+Shift+F)'), () => { S.sbTab = 'search'; renderSidebar(); $('#search-input')?.focus(); }),
    btn('🕸', t('Graph view (Ctrl+G)'), toggleGraph),
    btn('✎', t('New note (Ctrl+N)'), () => newNote()),
    btn('📅', t('Daily note'), dailyNote),
    h('div', { class: 'grow' }),
    btn('🔑', t('API tokens & AI (MCP)'), tokensDialog),
    btn('👥', t('Vault members'), membersDialog),
    btn('🔗', t('Invite & share online'), shareDialog),
    S.user.role === 'admin' && btn('🛡', t('Admin: users'), adminDialog),
    btn('🌓', t('Toggle theme'), toggleTheme),
    btn(lang === 'es' ? 'EN' : 'ES', t('Language') + ': ' + (lang === 'es' ? 'English' : 'Español'), async () => { await saveNow(); setLang(lang === 'es' ? 'en' : 'es'); location.reload(); }),
    btn('⏻', tf.signOut(S.user.username), logout));
  const ws = h('div', { class: 'ws', id: 'ws' }, R.ribbon, R.sidebar, R.main, R.right,
    h('div', { class: 'rs rs-left', title: t('Drag to resize') }), h('div', { class: 'rs rs-right', title: t('Drag to resize') }));
  $('#app').replaceChildren(ws);
  applyPanels(ws);
  wireResizers(ws);
}

// Side panels: resizable (drag the edge, double-click to reset) and collapsible; sizes are remembered.
function applyPanels(ws = $('#ws')) {
  ws.style.setProperty('--sb', ls('sbw', 270) + 'px');
  ws.style.setProperty('--rb', ls('rbw', 300) + 'px');
  ws.classList.toggle('no-sb', !!ls('sbHidden', false));
  ws.classList.toggle('no-rb', !!ls('rbHidden', false));
}
function togglePanel(which) {
  const k = which === 'left' ? 'sbHidden' : 'rbHidden';
  lsSet(k, !ls(k, false));
  applyPanels();
}
function wireResizers(ws) {
  for (const side of ['left', 'right']) {
    const el = $('.rs-' + side, ws);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      const move = (ev) => {
        const r = ws.getBoundingClientRect();
        if (side === 'left') { lsSet('sbw', Math.round(Math.min(520, Math.max(150, ev.clientX - r.left - 44)))); lsSet('sbHidden', false); }
        else { lsSet('rbw', Math.round(Math.min(560, Math.max(180, r.right - ev.clientX)))); lsSet('rbHidden', false); }
        applyPanels(ws);
      };
      const up = () => { el.classList.remove('active'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { lsSet(side === 'left' ? 'sbw' : 'rbw', side === 'left' ? 270 : 300); applyPanels(ws); });
  }
}

function toggleTheme() {
  lsSet('theme', ls('theme', 'dark') === 'dark' ? 'light' : 'dark');
  applyTheme();
  S.gv?.recolor(); S.local?.recolor();
}

async function loadVault(id) {
  S.vault = S.vaults.find((v) => v.id === id);
  lsSet('vault', id);
  S.cur = null;
  await refreshList(true);
  connectEvents();
  renderSidebar();
  const last = ls('note:' + id, null);
  const start = S.notes.find((n) => n.path === last) ? last : S.notes.find((n) => n.path === 'Welcome.md') ? 'Welcome.md' : S.notes[0]?.path;
  if (start) await openNote(start); else { renderMain(); renderRight(); }
}

async function createVault() {
  const name = await ask(t('New vault'), { label: t('Name'), ok: t('Create') });
  if (!name) return;
  try {
    const v = await api('POST', '/api/vaults', { name });
    S.vaults = (await api('GET', '/api/vaults')).vaults;
    if (!R.sidebar.isConnected || !$('#ws')) buildShell();
    await loadVault(v.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ───────────────────────── data ─────────────────────────
async function refreshList(initial = false) {
  const [l, t] = await Promise.all([api('GET', API('/notes')), api('GET', API('/tags'))]);
  S.notes = l.notes; S.files = l.files; S.folders = l.folders || []; S.tags = t.tags;
  S.resolve = createResolver(S.notes.map((n) => n.path));
  if (!initial) {
    if (S.sbTab !== 'search') renderSidebar();
    if (S.view === 'graph') loadGraph(S.gv);
    if (S.cur) {
      try { S.cur.detail = await api('GET', API('/notes/' + enc(S.cur.path))); } catch { /* note may be gone */ }
      if (S.rbTab === 'graph') loadLocal(); else renderRight();
    }
  }
}
const refreshSoon = debounce(() => refreshList().catch(() => {}), 250);

function connectEvents() {
  S.es?.close();
  const es = new EventSource(API('/events'));
  S.es = es;
  es.addEventListener('presence', (e) => { S.presence = JSON.parse(e.data); renderAvatars(); drawPresence(); });
  es.addEventListener('change', (e) => onRemoteChange(JSON.parse(e.data)));
}

const activitySoon = debounce(() => { if (S.rbTab === 'activity') renderRight(); }, 500);

async function onRemoteChange(ev) {
  refreshSoon();
  activitySoon();
  const mine = ev.user === S.user.username || ev.user === S.user.username + '(api)';
  const c = S.cur;
  if (!c) return;
  if (ev.type === 'delete' && ev.path === c.path && !mine) { toast(`${ev.user} deleted “${baseName(c.path)}”`); S.cur = null; renderMain(); renderRight(); return; }
  if (ev.type === 'rename' && ev.from === c.path && !mine) { c.path = ev.path; renderMain(); return; }
  if (ev.type === 'write' && ev.path === c.path && !mine && ev.rev !== c.rev) {
    if (!c.dirty) {
      try { const n = await api('GET', API('/notes/' + enc(c.path))); applyServerNote(n); toast(`Updated by ${ev.user}`); } catch { /* ignore */ }
    } else banner(`${ev.user} edited this note. Your changes will be merged with theirs when saved.`);
  }
}

function applyServerNote(n) {
  const c = S.cur;
  c.rev = n.rev; c.content = c.saved = n.content; c.dirty = false; c.detail = n;
  if (R.editor) { const pos = R.editor.selectionStart; R.editor.value = n.content; R.editor.selectionStart = R.editor.selectionEnd = Math.min(pos, n.content.length); }
  renderPreview(); setStatus(t('Saved'), 'ok'); renderRight(); banner(null);
}

// ───────────────────────── sidebar ─────────────────────────
function renderSidebar() {
  const vsel = h('select', { class: 'input', onchange: (e) => (e.target.value === '__new' ? createVault() : loadVault(e.target.value)) },
    S.vaults.map((v) => h('option', { value: v.id, selected: v.id === S.vault?.id }, v.name)), S.canCreate && h('option', { value: '__new' }, t('＋ New vault…')));
  const tab = (id, label) => h('button', { class: S.sbTab === id ? 'active' : '', onclick: () => { S.sbTab = id; renderSidebar(); } }, label);
  R.sbBody = h('div', { class: 'sb-body' });
  R.sidebar.replaceChildren(
    h('div', { class: 'sb-head' }, h('div', { class: 'vault-switch' }, vsel, h('button', { class: 'btn', title: t('New note'), onclick: () => newNote() }, '＋'), canEdit() && h('button', { class: 'btn', title: t('New folder'), onclick: () => newFolder() }, '📁'))),
    h('div', { class: 'sb-tabs' }, tab('files', t('Files')), tab('search', t('Search')), tab('tags', t('Tags'))), R.sbBody);
  if (S.sbTab === 'files') renderTree();
  else if (S.sbTab === 'search') renderSearch();
  else renderTags();
}

function buildTree() {
  const root = { folders: new Map(), notes: [] };
  const dig = (parts) => {
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const f of S.folders || []) dig(f.split('/'));
  for (const n of S.notes) dig(n.path.split('/').slice(0, -1)).notes.push(n);
  return root;
}

const canEdit = () => S.vault.role !== 'viewer';
const dropOn = (folder) => ({
  dragover: (e) => { if (canEdit() && [...e.dataTransfer.types].some((x) => x.startsWith('text/vf-'))) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
  dragleave: (e) => e.currentTarget.classList.remove('drop'),
  drop: (e) => {
    e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drop');
    const note = e.dataTransfer.getData('text/vf-note'), fol = e.dataTransfer.getData('text/vf-folder');
    if (note) moveNoteTo(note, folder); else if (fol) moveFolderTo(fol, folder);
  },
});
const withDrop = (el, folder) => { for (const [ev, fn] of Object.entries(dropOn(folder))) el.addEventListener(ev, fn); return el; };

function renderTree() {
  const rows = [];
  const walk = (node, prefix, depth) => {
    for (const [name, sub] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      const full = prefix + name;
      const open = !S.collapsed.has(full);
      const acts = canEdit() && h('span', { class: 'acts' },
        h('button', { class: 'icon-btn', title: t('New note here'), onclick: (e) => { e.stopPropagation(); newNote(full + '/'); } }, '＋'),
        h('button', { class: 'icon-btn', title: t('New subfolder'), onclick: (e) => { e.stopPropagation(); newFolder(full + '/'); } }, '📁'),
        h('button', { class: 'icon-btn', title: t('Rename folder'), onclick: (e) => { e.stopPropagation(); renameFolder(full); } }, '✎'),
        h('button', { class: 'icon-btn', title: t('Delete folder'), onclick: (e) => { e.stopPropagation(); deleteFolder(full); } }, '🗑'));
      const row = h('div', { class: 'tree-row folder', draggable: canEdit() ? 'true' : null, style: { paddingLeft: 6 + depth * 14 + 'px' },
        ondragstart: (e) => { e.dataTransfer.setData('text/vf-folder', full); e.dataTransfer.effectAllowed = 'move'; },
        onclick: () => { open ? S.collapsed.add(full) : S.collapsed.delete(full); lsSet('collapsed', [...S.collapsed]); renderTree(); } },
        h('span', { class: 'caret' }, open ? '▼' : '▶'), h('span', { class: 'name' }, '📂 ' + name), acts);
      rows.push(withDrop(row, full));
      if (open) walk(sub, full + '/', depth + 1);
    }
    for (const n of node.notes.sort((a, b) => a.title.localeCompare(b.title))) {
      rows.push(h('div', { class: 'tree-row' + (S.cur?.path === n.path ? ' active' : ''), 'data-path': n.path, draggable: canEdit() ? 'true' : null, style: { paddingLeft: 20 + depth * 14 + 'px' },
        ondragstart: (e) => { e.dataTransfer.setData('text/vf-note', n.path); e.dataTransfer.effectAllowed = 'move'; },
        onclick: () => openNote(n.path) },
        h('span', { class: 'name' }, baseName(n.path)),
        canEdit() && h('span', { class: 'acts' }, h('button', { class: 'icon-btn', title: t('Delete'), onclick: (e) => { e.stopPropagation(); deleteNote(n.path); } }, '🗑'))));
    }
  };
  walk(buildTree(), '', 0);
  R.sbBody.replaceChildren(...(rows.length ? rows : [h('div', { class: 'muted', style: { padding: '12px' } }, 'No notes yet. Press Ctrl+N.')]));
  withDrop(R.sbBody, ''); // dropping on empty space moves to the vault root
}

// ── folder operations ──
const afterTreeChange = async () => { await refreshList(true); renderSidebar(); renderRight(); };

async function newFolder(prefix = '') {
  const name = await ask(t('New folder'), { value: prefix, label: t('Folder name') + ' (folder/subfolder)', ok: t('Create') });
  if (!name) return;
  try {
    const r = await api('POST', API('/ops/mkdir'), { path: name });
    r.path.split('/').reduce((acc, seg) => { const p = acc ? acc + '/' + seg : seg; S.collapsed.delete(p); return p; }, '');
    await afterTreeChange();
  } catch (e) { toast(e.message, 'error'); }
}

async function moveNoteTo(path, folder) {
  const to = (folder ? folder + '/' : '') + path.split('/').pop();
  if (to === path) return;
  if (S.cur?.path === path && S.cur.dirty) await saveNow();
  try {
    const r = await api('POST', API('/ops/rename'), { from: path, to });
    if (r.updated.length) toast('Updated links in ' + r.updated.length + ' note(s)', 'ok');
    await refreshList(true);
    if (S.cur?.path === path) { lsSet('note:' + V(), r.to); await openNote(r.to); } else { renderSidebar(); renderRight(); }
  } catch (e) { toast(e.message, 'error'); }
}

async function moveFolderTo(from, folder) {
  const to = (folder ? folder + '/' : '') + from.split('/').pop();
  if (to === from || to.startsWith(from + '/')) return;
  await runFolderMove(from, to);
}

async function runFolderMove(from, to) {
  if (S.cur?.dirty) await saveNow();
  try {
    await api('POST', API('/ops/move-folder'), { from, to });
    const curPath = S.cur?.path;
    await refreshList(true);
    if (curPath && curPath.startsWith(from + '/')) { const np = to + curPath.slice(from.length); lsSet('note:' + V(), np); await openNote(np); } else { renderSidebar(); renderRight(); }
  } catch (e) { toast(e.message, 'error'); }
}

async function renameFolder(full) {
  const parent = full.includes('/') ? full.slice(0, full.lastIndexOf('/') + 1) : '';
  const name = await ask(t('Rename folder'), { value: full.split('/').pop(), label: t('Folder name') + ' (' + t('or full path') + ')', ok: 'OK' });
  if (!name) return;
  await runFolderMove(full, name.includes('/') ? name : parent + name);
}

async function deleteFolder(full) {
  if (!(await confirmBox(t('Delete folder'), '“' + full + '” — only empty folders can be deleted.', t('Delete')))) return;
  try { await api('DELETE', API('/folders/' + enc(full))); await afterTreeChange(); } catch (e) { toast(e.message, 'error'); }
}

function moveCurrentDialog() {
  if (!S.cur) return;
  const cur = S.cur.path;
  picker(t('Move note to folder…'), (q) => {
    const lq = q.toLowerCase();
    return [{ label: t('(vault root)'), folder: '' }, ...(S.folders || []).map((f) => ({ label: f, folder: f }))].filter((x) => !lq || x.label.toLowerCase().includes(lq));
  }, (it) => moveNoteTo(cur, it.folder));
}

function renderSearch() {
  const out = h('div');
  const run = async () => {
    const q = input.value.trim(); S.searchQ = q;
    if (!q) return out.replaceChildren();
    try {
      const { results } = await api('GET', API('/search?q=' + encodeURIComponent(q) + '&limit=40'));
      out.replaceChildren(...(results.length ? results.map((r) => h('div', { class: 'result', onclick: () => openNote(r.path) },
        h('b', {}, r.title), h('div', { class: 'muted' }, r.path), h('div', { class: 'snip' }, r.snippet))) : [h('div', { class: 'muted', style: { padding: '8px' } }, t('No results'))]));
    } catch (e) { out.textContent = e.message; }
  };
  const input = h('input', { id: 'search-input', class: 'input', placeholder: t('Search… "phrase" tag:x path:folder'), value: S.searchQ, oninput: debounce(run, 180) });
  R.sbBody.replaceChildren(h('div', { style: { padding: '4px' } }, input), out);
  if (S.searchQ) run();
}

function renderTags() {
  R.sbBody.replaceChildren(h('div', { style: { padding: '6px' } }, ...(S.tags.length ? S.tags.map((t) => h('span', { class: 'tag-pill', onclick: () => searchFor('tag:' + t.tag) }, `#${t.tag} ${t.count}`)) : [h('div', { class: 'muted' }, 'No tags yet. Write #tags in your notes.')])));
}

function searchFor(q) { S.sbTab = 'search'; S.searchQ = q; renderSidebar(); }

// ───────────────────────── notes ─────────────────────────
function mdCtx(current) {
  return {
    current,
    resolve: (t) => S.resolve(t, current),
    fileUrl: (t) => {
      const lt = t.toLowerCase();
      const f = S.files.find((x) => x.toLowerCase() === lt) || S.files.find((x) => x.toLowerCase().endsWith('/' + lt));
      return f ? API('/files/' + enc(f)) : null;
    },
  };
}

async function openNote(path, { heading } = {}) {
  if (S.cur?.dirty) await saveNow();
  try {
    const n = await api('GET', API('/notes/' + enc(path)));
    S.cur = { path: n.path, rev: n.rev, content: n.content, saved: n.content, dirty: false, detail: n };
    S.view = 'note';
    lsSet('note:' + V(), n.path);
    destroyGraph(); renderMain(); renderRight(); renderSidebarActive();
    announce(n.path);
    if (heading) setTimeout(() => R.preview?.querySelector('#' + CSS.escape(heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')))?.scrollIntoView(), 50);
  } catch (e) { toast(e.message, 'error'); }
}

function renderSidebarActive() {
  if (S.sbTab !== 'files') return;
  R.sbBody?.querySelectorAll('.tree-row[data-path]').forEach((r) => r.classList.toggle('active', r.dataset.path === S.cur?.path));
}

const announce = (path) => api('POST', API('/presence'), { path }).catch(() => {});
setInterval(() => { if (S.vault && S.cur && document.visibilityState === 'visible') announce(S.cur.path); }, 20000);

async function newNote(prefix = '') {
  if (S.vault.role === 'viewer') return toast('You have read-only access to this vault', 'error');
  const name = await ask(t('New note'), { value: prefix, label: t('Name or folder/name'), ok: t('Create') });
  if (!name) return;
  await createNote(name, `# ${baseName(name)}\n\n`);
}

async function createNote(name, content) {
  try {
    const r = await api('PUT', API('/notes/' + enc(name)), { content });
    await refreshList(true); renderSidebar();
    await openNote(r.path);
    setTimeout(() => R.editor?.focus(), 50);
  } catch (e) {
    if (e.code === 'base_rev_required') { toast('A note with that name already exists'); await openNote(name.endsWith('.md') ? name : name + '.md'); } else toast(e.message, 'error');
  }
}

async function dailyNote() {
  const d = new Date(), p = `Daily/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
  if (S.notes.some((n) => n.path === p)) return openNote(p);
  await createNote(p, `# ${baseName(p)}\n\n`);
}

async function deleteNote(path) {
  if (!(await confirmBox(t('Delete note'), `Move “${baseName(path)}” to the trash? History is kept.`, t('Delete')))) return;
  try {
    await api('DELETE', API('/notes/' + enc(path)));
    if (S.cur?.path === path) S.cur = null;
    await refreshList(true); renderSidebar(); renderMain(); renderRight();
  } catch (e) { toast(e.message, 'error'); }
}

async function renameCurrent(newName) {
  const c = S.cur;
  if (!c || !newName || newName === baseName(c.path)) return;
  if (c.dirty) await saveNow();
  const folder = c.path.includes('/') && !newName.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/') + 1) : '';
  try {
    const r = await api('POST', API('/ops/rename'), { from: c.path, to: folder + newName });
    if (r.updated.length) toast(`Updated links in ${r.updated.length} note(s)`, 'ok');
    c.path = r.to; lsSet('note:' + V(), r.to);
    await refreshList(true); renderSidebar(); await openNote(r.to);
  } catch (e) { toast(e.message, 'error'); $('.topbar .title').value = baseName(c.path); }
}

// ───────────────────────── main: note view ─────────────────────────
function renderMain() {
  if (S.view === 'graph') return renderGraphView();
  const c = S.cur;
  if (!c) {
    R.main.replaceChildren(h('div', { class: 'topbar' }, viewSwitch()), h('div', { class: 'empty' }, h('div', {}, h('h2', {}, t('No note open')), h('p', { class: 'muted' }, 'Ctrl+O to open a note · Ctrl+N to create one · Ctrl+G for the graph'))));
    R.editor = R.preview = null; return;
  }
  const ro = S.vault.role === 'viewer';
  const modeBtn = (m, label) => h('button', { class: 'icon-btn' + (S.mode === m ? ' active' : ''), title: label, onclick: () => { S.mode = m; lsSet('mode', m); renderMain(); } }, label);
  R.status = h('span', { class: 'status' }, c.dirty ? t('Unsaved') : t('Saved'));
  R.avatars = h('div', { class: 'avatars' });
  R.banner = h('div');
  R.editor = h('textarea', { id: 'editor', spellcheck: 'false', readonly: ro, 'aria-label': t('Note editor') });
  R.editor.value = c.content;
  R.preview = h('div', { class: 'preview', onclick: onPreviewClick });
  const panes = h('div', { class: 'panes' },
    S.mode !== 'preview' && h('div', { class: 'editor-pane' }, R.editor),
    S.mode !== 'edit' && h('div', { class: 'preview-pane' }, R.preview));
  const title = h('input', { class: 'title', value: baseName(c.path), readonly: ro, title: c.path, 'aria-label': t('Note title'),
    onchange: (e) => renameCurrent(e.target.value.trim()), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
  R.main.replaceChildren(
    h('div', { class: 'topbar' }, viewSwitch(), title, R.avatars, R.status, modeBtn('edit', t('✎ Edit')), modeBtn('split', t('◫ Split')), modeBtn('preview', t('👁 Read'))),
    R.banner, panes);
  R.editor.addEventListener('input', onEdit);
  R.editor.addEventListener('keydown', onEditorKey);
  R.editor.addEventListener('paste', onPaste);
  R.editor.addEventListener('blur', () => setTimeout(closeAC, 150));
  renderPreview(); renderAvatars();
  if (c.conflictInfo) showConflict(c.conflictInfo);
}

const renderPreviewSoon = debounce(() => renderPreview(), 120);
function renderPreview() {
  if (!R.preview || !S.cur) return;
  const top = R.preview.parentElement?.scrollTop || 0;
  R.preview.innerHTML = renderMarkdown(S.cur.content, mdCtx(S.cur.path));
  if (R.preview.parentElement) R.preview.parentElement.scrollTop = top;
  hydrateEmbeds(R.preview, [S.cur.path]);
}

function sectionOf(src, heading) {
  const lines = src.split('\n');
  const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && slug(l.replace(/^#+\s+/, '')) === slug(heading));
  if (i < 0) return src;
  const lvl = /^#+/.exec(lines[i])[0].length;
  let j = i + 1;
  while (j < lines.length && !(/^(#{1,6})\s/.test(lines[j]) && /^#+/.exec(lines[j])[0].length <= lvl)) j++;
  return lines.slice(i, j).join('\n');
}

async function hydrateEmbeds(root, stack) {
  for (const el of root.querySelectorAll('.embed-note:not([data-done])')) {
    el.dataset.done = '1';
    const p = el.dataset.path;
    if (stack.includes(p) || stack.length > 3) { el.append(h('em', {}, '(recursive embed)')); continue; }
    try {
      const n = await api('GET', API('/notes/' + enc(p)));
      const body = h('div', { class: 'embed-body' });
      body.innerHTML = renderMarkdown(el.dataset.heading ? sectionOf(n.content, el.dataset.heading) : n.content, mdCtx(p));
      el.append(body);
      await hydrateEmbeds(body, [...stack, p]);
    } catch { el.append(h('em', {}, '(cannot load)')); }
  }
}

async function onPreviewClick(e) {
  const el = e.target;
  const a = el.closest('a.internal-link');
  if (a) {
    e.preventDefault();
    if (a.dataset.path) return openNote(a.dataset.path, { heading: a.dataset.heading });
    if (S.vault.role !== 'viewer' && (await confirmBox(t('Create note'), `“${a.dataset.target}” doesn't exist yet. Create it?`, t('Create')))) createNote(a.dataset.target, `# ${baseName(a.dataset.target)}\n\n`);
    return;
  }
  const tag = el.closest('a.tag');
  if (tag) { e.preventDefault(); return searchFor('tag:' + tag.dataset.tag); }
  if (el.matches('input.task') && S.vault.role !== 'viewer') {
    const lines = S.cur.content.split('\n');
    const i = Number(el.dataset.line);
    lines[i] = lines[i].replace(/\[( |x|X)\]/, el.checked ? '[x]' : '[ ]');
    S.cur.content = lines.join('\n');
    R.editor.value = S.cur.content;
    markDirty();
  }
}

// ── editing / saving ──
function onEdit() {
  S.cur.content = R.editor.value;
  markDirty();
  renderPreviewSoon();
  updateAC();
}

let saveTimer = null;
function markDirty() {
  const c = S.cur;
  c.dirty = c.content !== c.saved;
  setStatus(c.dirty ? t('Unsaved…') : t('Saved'), c.dirty ? '' : 'ok');
  clearTimeout(saveTimer);
  if (c.holdUntilClean && /^<<<<<<< yours$/m.test(c.content)) { setStatus('Resolve conflict markers to save', 'err'); return; }
  if (c.dirty && !c.conflictInfo) saveTimer = setTimeout(saveNow, 900);
}

function setStatus(text, kind = '') { if (R.status) { R.status.textContent = text; R.status.className = 'status ' + kind; } }

function banner(text, danger = false, actions = []) {
  if (!R.banner) return;
  R.banner.replaceChildren();
  R.banner.className = text ? 'banner' + (danger ? ' danger' : '') : '';
  if (text) R.banner.append(h('span', {}, text), ...actions);
}

let saving = false;
async function saveNow() {
  clearTimeout(saveTimer);
  const c = S.cur;
  if (!c || !c.dirty || c.conflictInfo || S.vault.role === 'viewer') return;
  if (saving) return;
  saving = true;
  const sent = c.content, path = c.path;
  setStatus(t('Saving…'));
  try {
    const r = await api('PUT', API('/notes/' + enc(path)), { content: sent, baseRev: c.rev });
    if (S.cur !== c) return;
    c.rev = r.rev;
    if (r.merged) {
      const local = c.content === sent ? r.content : merge3(sent, c.content, r.content).text;
      c.content = local;
      const pos = R.editor.selectionStart;
      R.editor.value = local; R.editor.selectionStart = R.editor.selectionEnd = Math.min(pos, local.length);
      renderPreview();
      toast('Merged with changes made by someone else', 'ok');
    }
    c.saved = r.content;
    c.dirty = c.content !== c.saved;
    setStatus(c.dirty ? t('Unsaved…') : t('Saved'), c.dirty ? '' : 'ok');
    const entry = S.notes.find((n) => n.path === path);
    if (!entry) refreshSoon();
    else entry.rev = r.rev;
  } catch (e) {
    if (e.status === 409 && e.code === 'conflict') showConflict(e.data);
    else if (e.status === 409 && e.code === 'note_deleted') { setStatus('Note was deleted by someone else', 'err'); c.conflictInfo = { deleted: true }; banner('This note was deleted by someone else.', true, [h('button', { class: 'btn small', onclick: recreate }, t('Recreate it'))]); }
    else setStatus('Save failed: ' + e.message, 'err');
  } finally {
    saving = false;
    if (S.cur === c && c.dirty && !c.conflictInfo) saveTimer = setTimeout(saveNow, 400);
  }
}

async function recreate() {
  const c = S.cur;
  try { const r = await api('PUT', API('/notes/' + enc(c.path)), { content: c.content }); c.rev = r.rev; c.saved = c.content; c.dirty = false; c.conflictInfo = null; banner(null); setStatus(t('Saved'), 'ok'); refreshSoon(); } catch (e) { toast(e.message, 'error'); }
}

function showConflict(info) {
  const c = S.cur;
  c.conflictInfo = info;
  setStatus(t('Conflict'), 'err');
  const resolve = (content, rev) => {
    c.conflictInfo = null; c.rev = rev; c.content = content;
    R.editor.value = content; banner(null); renderPreview(); markDirty();
  };
  banner('Someone else changed this note in a way that cannot be merged automatically. Nothing was overwritten.', true, [
    h('button', { class: 'btn small', onclick: () => resolve(info.yours ?? c.content, info.current.rev) }, t('Keep mine')),
    h('button', { class: 'btn small', onclick: () => { resolve(info.current.content, info.current.rev); c.saved = info.current.content; c.dirty = false; setStatus(t('Saved'), 'ok'); } }, t('Use theirs')),
    h('button', { class: 'btn small', onclick: () => { resolve(info.mergedWithMarkers ?? info.yours, info.current.rev); toast('Resolve the <<<<<<< markers, then it will autosave'); c.holdUntilClean = true; } }, t('Merge manually')),
  ]);
}


window.addEventListener('beforeunload', (e) => { if (S.cur?.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ── editor helpers ──
function wrapSel(l, r = l) {
  const ta = R.editor, a = ta.selectionStart, b = ta.selectionEnd;
  ta.setRangeText(l + ta.value.slice(a, b) + r, a, b, 'select');
  ta.selectionStart = a + l.length; ta.selectionEnd = b + l.length;
  onEdit();
}

function onEditorKey(e) {
  if (AC.el) {
    if (e.key === 'ArrowDown') { AC.sel = Math.min(AC.sel + 1, AC.items.length - 1); drawAC(); return e.preventDefault(); }
    if (e.key === 'ArrowUp') { AC.sel = Math.max(AC.sel - 1, 0); drawAC(); return e.preventDefault(); }
    if (e.key === 'Enter' || e.key === 'Tab') { acceptAC(); return e.preventDefault(); }
    if (e.key === 'Escape') { closeAC(); return e.preventDefault(); }
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (e.key === 'b') { e.preventDefault(); wrapSel('**'); }
    else if (e.key === 'i') { e.preventDefault(); wrapSel('*'); }
    else if (e.key === 'k') { e.preventDefault(); wrapSel('[[', ']]'); }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    R.editor.setRangeText('  ', R.editor.selectionStart, R.editor.selectionEnd, 'end'); onEdit();
  } else if (e.key === 'Enter') {
    const ta = R.editor, pos = ta.selectionStart;
    const line = ta.value.slice(ta.value.lastIndexOf('\n', pos - 1) + 1, pos);
    const m = /^(\s*)([-*+]|\d+\.)\s+(\[[ x]\]\s+)?(.*)$/.exec(line);
    if (m && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      if (!m[4]) { ta.setRangeText('', pos - line.length, pos, 'end'); }
      else { const next = /\d/.test(m[2]) ? parseInt(m[2]) + 1 + '.' : m[2]; ta.setRangeText('\n' + m[1] + next + ' ' + (m[3] ? '[ ] ' : ''), pos, pos, 'end'); }
      onEdit();
    }
  }
}

async function onPaste(e) {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (!f || S.vault.role === 'viewer') return;
  e.preventDefault();
  const ext = f.type.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const name = `attachments/pasted-${Date.now()}.${ext}`;
  try {
    const res = await fetch(API('/files/' + enc(name)), { method: 'POST', body: f, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message);
    S.files.push(data.path);
    R.editor.setRangeText(`![[${baseNameAny(data.path)}]]`, R.editor.selectionStart, R.editor.selectionEnd, 'end'); onEdit();
  } catch (x) { toast('Upload failed: ' + x.message, 'error'); }
}
const baseNameAny = (p) => p.split('/').pop();

// wikilink autocomplete
const AC = { el: null, items: [], sel: 0, start: 0 };
function updateAC() {
  const ta = R.editor, pos = ta.selectionStart;
  const before = ta.value.slice(Math.max(0, pos - 80), pos);
  const m = /\[\[([^\[\]\n|#]*)$/.exec(before);
  if (!m) return closeAC();
  const q = m[1].toLowerCase();
  const items = S.notes.filter((n) => !q || n.path.toLowerCase().includes(q) || n.title.toLowerCase().includes(q)).slice(0, 8);
  if (!items.length) return closeAC();
  AC.items = items; AC.sel = Math.min(AC.sel, items.length - 1); AC.start = pos - m[1].length;
  drawAC();
}
function drawAC() {
  if (!AC.el) { AC.el = h('div', { class: 'ac' }); document.body.append(AC.el); }
  const r = R.editor.getBoundingClientRect();
  AC.el.style.left = r.left + 40 + 'px'; AC.el.style.top = r.top + 24 + 'px';
  AC.el.replaceChildren(...AC.items.map((n, i) => h('div', { class: i === AC.sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); AC.sel = i; acceptAC(); } }, baseName(n.path), n.folder && h('span', { class: 'muted' }, '  ' + n.folder))));
}
function closeAC() { AC.el?.remove(); AC.el = null; }
function acceptAC() {
  const n = AC.items[AC.sel];
  if (!n) return closeAC();
  const dup = S.notes.filter((x) => baseName(x.path).toLowerCase() === baseName(n.path).toLowerCase()).length > 1;
  const text = dup ? n.path.replace(/\.md$/i, '') : baseName(n.path);
  const ta = R.editor;
  const end = ta.value.slice(ta.selectionStart).startsWith(']]') ? ta.selectionStart + 2 : ta.selectionStart;
  ta.setRangeText(text + ']]', AC.start, end, 'end');
  closeAC(); onEdit();
}

function viewSwitch() {
  const b = (id, label, icon) => h('button', { class: S.view === id ? 'active' : '', 'aria-pressed': String(S.view === id), onclick: () => { if (S.view !== id) toggleGraph(); } }, icon + ' ' + label);
  return h('div', { class: 'seg' }, b('graph', t('Map'), '🕸'), b('note', t('Document'), '📄'));
}

// ── activity panel: who changed what, merges, agents, and who is online ──
const VERBS = { write: 'edited', merge: 'merged changes in', append: 'added text to', delete: 'deleted', rename: 'renamed', restore: 'restored', upload: 'uploaded', mkdir: 'created folder', rmdir: 'deleted folder', 'move-folder': 'moved folder', external: 'edited outside VaultFree:' };

function ago(iso) {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000), a = Math.abs(s);
  if (a < 45) return t('just now');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

function feedItems(list) {
  const items = [];
  for (const e of list) {
    if (e.action === 'relink' || e.action === 'forked-from') continue;
    const prev = items[items.length - 1];
    if (prev && prev.user === e.user && prev.action === e.action && prev.path === e.path && Date.parse(prev.ts) - Date.parse(e.ts) < 10 * 60 * 1000) { prev.count++; continue; }
    items.push({ ...e, count: 1 });
  }
  return items;
}

function noteLink(p) {
  if (!S.notes.some((n) => n.path === p)) return h('span', { class: 'muted' }, baseName(p));
  return h('a', { href: '#', class: 'internal-link', onclick: (e) => { e.preventDefault(); openNote(p); } }, baseName(p));
}

function renderFeed(list) {
  const items = feedItems(list);
  if (!items.length) return [h('div', { class: 'muted', style: { padding: '8px' } }, 'No activity yet.')];
  return items.map((it) => {
    const viaApi = /\(api\)$/.test(it.user);
    const name = it.user.replace(/\(api\)$/, '');
    const isNote = /\.md$/i.test(it.path || '');
    const target = it.action === 'rename'
      ? [noteLink(it.from || ''), ' → ', noteLink(it.path)]
      : [isNote ? noteLink(it.path) : h('span', { class: 'muted' }, it.path || '')];
    return h('div', { class: 'act' },
      h('span', { class: 'avatar sm', style: { background: colorFor(name) } }, (name[0] || '?').toUpperCase()),
      h('div', { class: 'act-text' },
        h('b', {}, name), viaApi && h('span', { class: 'badge-api', title: 'Used an API token (an AI agent or a script)' }, 'API'),
        ' ' + t(VERBS[it.action] || it.action) + ' ', ...target, it.count > 1 && ' ×' + it.count,
        h('div', { class: 'muted' }, ago(it.ts))));
  });
}

function drawPresence() {
  if (!R.presenceBox || !R.presenceBox.isConnected) return;
  const others = S.presence.filter((p) => p.username !== S.user.username);
  R.presenceBox.replaceChildren(h('div', { class: 'section-title' }, t('Online now')),
    ...(others.length ? others.map((p) => h('div', { class: 'presence-row', onclick: () => { if (S.notes.some((n) => n.path === p.path)) openNote(p.path); } },
      h('span', { class: 'avatar sm', style: { background: colorFor(p.username) } }, (p.displayName || p.username)[0].toUpperCase()),
      h('span', {}, h('b', {}, p.displayName || p.username), h('div', { class: 'muted' }, baseName(p.path)))))
      : [h('div', { class: 'muted', style: { padding: '2px 8px' } }, t('Only you'))]));
}

async function renderActivity(body) {
  R.presenceBox = h('div', { class: 'presence-box' });
  const feed = h('div', { class: 'feed' }, h('div', { class: 'muted', style: { padding: '8px' } }, '…'));
  body.append(R.presenceBox, h('div', { class: 'section-title' }, t('Recent activity')), feed);
  drawPresence();
  try {
    const { activity } = await api('GET', API('/activity?limit=80'));
    feed.replaceChildren(...renderFeed(activity));
  } catch (e) { feed.textContent = e.message; }
}

function renderAvatars() {
  if (!R.avatars) return;
  const others = S.presence.filter((p) => p.username !== S.user.username);
  R.avatars.replaceChildren(...others.map((p) => h('div', { class: 'avatar', title: `${p.displayName || p.username} — ${p.path}`, style: { background: colorFor(p.username), opacity: p.path === S.cur?.path ? 1 : 0.5 } }, (p.displayName || p.username)[0].toUpperCase())));
}
const colorFor = (s) => `hsl(${[...s].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 360} 60% 50%)`;

// ───────────────────────── right panel ─────────────────────────
function renderRight() {
  destroyLocal();
  const c = S.cur;
  const tab = (id, label) => h('button', { class: S.rbTab === id ? 'active' : '', onclick: () => { S.rbTab = id; lsSet('rb', id); renderRight(); } }, label);
  const body = h('div', { class: 'rb-body' });
  R.right.replaceChildren(h('div', { class: 'rb-tabs' }, tab('activity', t('Activity')), tab('links', t('Links')), tab('outline', t('Outline')), tab('graph', t('Graph')), tab('history', t('History'))), body);
  if (S.rbTab === 'activity') return renderActivity(body);
  if (!c) return;
  const d = c.detail;
  if (S.rbTab === 'links') {
    const item = (p, title, ctx) => h('div', { class: 'link-item', onclick: () => openNote(p) }, h('div', {}, title), ctx && h('div', { class: 'ctx' }, ctx));
    body.append(h('div', { class: 'section-title' }, tf.backlinks(d.backlinks.length)),
      ...(d.backlinks.length ? d.backlinks.map((b) => item(b.path, b.title, b.context)) : [h('div', { class: 'muted', style: { padding: '4px 8px' } }, 'No backlinks')]),
      h('div', { class: 'section-title' }, tf.outgoing(d.links.length + d.unresolved.length)),
      ...d.links.map((l) => item(l.path, l.title)),
      ...d.unresolved.map((u) => h('div', { class: 'link-item muted', onclick: () => createNote(u, `# ${baseName(u)}\n\n`) }, `${u} (create)`)),
      h('div', { class: 'section-title' }, t('Tags')),
      h('div', { style: { padding: '0 6px' } }, ...(d.tags.length ? d.tags.map((t) => h('span', { class: 'tag-pill', onclick: () => searchFor('tag:' + t) }, '#' + t)) : [h('span', { class: 'muted' }, t('None'))])));
  } else if (S.rbTab === 'outline') {
    body.append(...(d.headings.length ? d.headings.map((hd) => h('div', { class: 'outline-item', style: { paddingLeft: 8 + (hd.level - 1) * 12 + 'px' },
      onclick: () => R.preview?.querySelector('#' + CSS.escape(hd.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')))?.scrollIntoView({ behavior: 'smooth' }) }, hd.text)) : [h('div', { class: 'muted', style: { padding: '8px' } }, 'No headings')]));
  } else if (S.rbTab === 'graph') {
    const wrap = h('div', { class: 'local-graph' }, h('canvas'));
    const depth = h('input', { type: 'range', min: 1, max: 4, value: S.gs.depth, oninput: (e) => { S.gs.depth = Number(e.target.value); lsSet('graph', S.gs); loadLocal(); } });
    body.append(wrap, h('label', { class: 'muted', style: { display: 'flex', gap: '8px', padding: '0 10px', alignItems: 'center' } }, t('Depth'), depth),
      h('div', { style: { padding: '6px' } }, h('button', { class: 'btn small', onclick: toggleGraph }, t('Open full graph'))));
    S.local = new GraphView($('canvas', wrap), { current: c.path, onOpen: (n) => openNote(n.id), options: { ...S.gs, nodeSize: 1.1, textFade: 1 } });
    loadLocal();
  } else if (S.rbTab === 'history') {
    renderHistory(body);
  }
}

async function loadLocal() {
  if (!S.local || !S.cur) return;
  S.local.setCurrent(S.cur.path);
  await loadGraph(S.local, { center: S.cur.path, depth: S.gs.depth, orphans: 1 });
}
function destroyLocal() { S.local?.destroy(); S.local = null; }

async function renderHistory(body) {
  const c = S.cur;
  try {
    const { history } = await api('GET', API('/history?path=' + encodeURIComponent(c.path)));
    body.append(...(history.length ? history.map((x) => h('div', { class: 'link-item' },
      h('div', {}, `${x.op} · ${x.user}`), h('div', { class: 'ctx' }, fmtTime(x.ts) + ' · ' + x.rev.slice(0, 8)),
      h('div', { class: 'row', style: { marginTop: '4px' } },
        h('button', { class: 'btn small', onclick: () => viewRevision(x) }, t('View')),
        x.rev !== c.rev && S.vault.role !== 'viewer' && h('button', { class: 'btn small', onclick: () => restoreRev(x) }, t('Restore'))))) : [h('div', { class: 'muted', style: { padding: '8px' } }, 'No history yet')]));
  } catch (e) { body.textContent = e.message; }
}
async function viewRevision(x) {
  const r = await api('GET', API('/revisions/' + x.rev));
  modal(`Revision ${x.rev.slice(0, 8)} — ${fmtTime(x.ts)}`, h('pre', { class: 'snippet' }, r.content), { wide: true });
}
async function restoreRev(x) {
  if (S.cur.dirty) await saveNow();
  try { await api('POST', API('/ops/restore'), { path: S.cur.path, rev: x.rev }); await openNote(S.cur.path); toast('Revision restored', 'ok'); } catch (e) { toast(e.message, 'error'); }
}

// ───────────────────────── graph view ─────────────────────────
function toggleGraph() {
  if (S.view === 'graph') { S.view = 'note'; destroyGraph(); renderMain(); } else { S.view = 'graph'; renderMain(); }
}
function destroyGraph() { S.gv?.destroy(); S.gv = null; }

async function loadGraph(gv, extra = {}) {
  if (!gv) return;
  const g = S.gs, p = new URLSearchParams({ orphans: g.orphans ? 1 : 0, unresolved: g.unresolved ? 1 : 0, tags: g.tags ? 1 : 0 });
  if (!extra.center) { if (g.q) p.set('q', g.q); if (g.tag) p.set('tag', g.tag); }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  try {
    const data = await api('GET', API('/graph?' + p));
    gv.setData(data);
    if (gv === S.gv && R.stats) R.stats.textContent = `${data.nodes.length} nodes · ${data.edges.length} links`;
  } catch (e) { toast(e.message, 'error'); }
}

function renderGraphView() {
  destroyGraph();
  const canvas = h('canvas');
  R.stats = h('div', { class: 'graph-stats' });
  const wrap = h('div', { class: 'graph-wrap' }, canvas, R.stats);
  R.main.replaceChildren(h('div', { class: 'topbar' }, viewSwitch(),
    h('span', { class: 'status', style: { flex: 1, textAlign: 'right' } }, 'Scroll to zoom · drag to pan · double-click to fit · click a node to open')), wrap);
  const gv = new GraphView(canvas, { current: S.cur?.path, onOpen: (n) => (n.type === 'tag' ? searchFor('tag:' + n.label.slice(1)) : openNote(n.id)), options: S.gs });
  S.gv = gv;
  wrap.append(graphPanel(gv));
  loadGraph(gv);
}

function graphPanel(gv) {
  const g = S.gs;
  const save = () => lsSet('graph', g);
  const range = (label, key, min, max, step) => h('label', {}, label, h('input', { type: 'range', min, max, step, value: g[key], oninput: (e) => { g[key] = Number(e.target.value); gv.setOptions({ [key]: g[key] }, ['centerForce', 'repelForce', 'linkForce', 'linkDistance'].includes(key)); S.local?.setOptions({ [key]: g[key] }, false); save(); } }));
  const check = (label, key, reload) => h('label', {}, label, h('input', { type: 'checkbox', checked: g[key], onchange: (e) => { g[key] = e.target.checked; save(); if (reload) loadGraph(gv); else gv.setOptions({ [key]: g[key] }, false); } }));
  const groupsBox = h('div');
  const drawGroups = () => groupsBox.replaceChildren(...g.groups.map((gr, i) => h('div', { class: 'group-row' },
    h('input', { class: 'input', value: gr.query, placeholder: 'tag:x  path:folder', oninput: (e) => { gr.query = e.target.value; gv.setOptions({ groups: g.groups }, false); gv.recolor(); save(); } }),
    h('input', { type: 'color', value: gr.color, oninput: (e) => { gr.color = e.target.value; gv.recolor(); save(); } }),
    h('button', { class: 'icon-btn', onclick: () => { g.groups.splice(i, 1); drawGroups(); gv.recolor(); save(); } }, '✕'))),
  h('button', { class: 'btn small', onclick: () => { g.groups.push({ query: '', color: '#f472b6' }); drawGroups(); } }, t('＋ New group')));
  drawGroups();
  const q = h('input', { class: 'input', placeholder: t('Search files…'), value: g.q, oninput: debounce((e) => { g.q = e.target.value; save(); loadGraph(gv); }, 250) });
  const tagSel = h('select', { class: 'input', style: { width: '100%' }, onchange: (e) => { g.tag = e.target.value; save(); loadGraph(gv); } },
    h('option', { value: '' }, t('All tags')), S.tags.map((t) => h('option', { value: t.tag, selected: g.tag === t.tag }, '#' + t.tag)));
  const sections = [
    h('details', {}, h('summary', {}, t('Filters')), q, tagSel, check(t('Tags'), 'tags', true), check(t('Orphans'), 'orphans', true), check(t('Unresolved links'), 'unresolved', true)),
    h('details', {}, h('summary', {}, t('Groups')), h('label', {}, t('Color by folder'), h('input', { type: 'checkbox', checked: g.colorBy === 'folder', onchange: (e) => { g.colorBy = e.target.checked ? 'folder' : 'none'; gv.setOptions({ colorBy: g.colorBy }, false); gv.recolor(); save(); } })), groupsBox),
    h('details', {}, h('summary', {}, t('Display')), h('label', {}, t('Style'), h('select', { class: 'input', onchange: (e) => { g.style = e.target.value; gv.setOptions({ style: g.style }, false); S.local?.setOptions({ style: g.style }, false); save(); } }, h('option', { value: 'constellation', selected: g.style !== 'classic' }, t('Constellation')), h('option', { value: 'classic', selected: g.style === 'classic' }, t('Classic')))), check(t('Arrows'), 'arrows'), range(t('Text fade'), 'textFade', 0, 1.5, 0.05), range(t('Node size'), 'nodeSize', 0.4, 3, 0.05), range(t('Link thickness'), 'linkThickness', 0.3, 4, 0.1)),
    h('details', {}, h('summary', {}, t('Forces')), range(t('Center force'), 'centerForce', 0, 1, 0.01), range(t('Repel force'), 'repelForce', 0, 4, 0.05), range(t('Link force'), 'linkForce', 0, 3, 0.05), range(t('Link distance'), 'linkDistance', 20, 250, 1)),
  ];
  const panel = h('div', { class: 'graph-panel' + (ls('gpOpen', false) ? '' : ' collapsed') });
  const toggle = h('button', { class: 'icon-btn gp-toggle', title: t('Graph settings'), 'aria-label': t('Graph settings'),
    onclick: () => { const c = panel.classList.toggle('collapsed'); lsSet('gpOpen', !c); } }, '⚙', h('span', { class: 'gp-label' }, ' ' + t('Settings')));
  panel.append(toggle, h('div', { class: 'gp-body' }, ...sections));
  return panel;
}

// ───────────────────────── dialogs ─────────────────────────
async function tokensDialog() {
  const box = h('div', { style: { display: 'grid', gap: '10px' } });
  const draw = async (fresh) => {
    const { tokens } = await api('GET', '/api/tokens');
    const name = h('input', { class: 'input', placeholder: t('Token name, e.g. “Claude Desktop”') });
    const scope = h('select', { class: 'input' }, h('option', { value: 'rw' }, t('Read + write')), h('option', { value: 'r' }, t('Read only')));
    const origin = location.origin;
    const snippet = fresh && JSON.stringify({ mcpServers: { vaultfree: { command: 'node', args: ['/path/to/vaultfree/bin/vaultfree.js', 'mcp', '--url', origin, '--token', fresh.token, '--vault', V()] } } }, null, 2);
    box.replaceChildren(
      h('p', { class: 'muted' }, 'Tokens let AI agents and scripts use the REST API or the MCP server (see /llms.txt). The token is shown only once.'),
      h('div', { class: 'row' }, name, scope, h('button', { class: 'btn primary', onclick: async () => {
        try { const created = await api('POST', '/api/tokens', { name: name.value || 'token', scopes: scope.value === 'r' ? ['read'] : ['read', 'write'] }); draw(created); } catch (e) { toast(e.message, 'error'); }
      } }, t('Create'))),
      fresh && h('div', {}, h('b', {}, 'New token (copy it now):'), h('pre', { class: 'snippet' }, fresh.token), h('b', {}, 'MCP client config:'), h('pre', { class: 'snippet' }, snippet)),
      h('table', { class: 'table' }, h('tr', {}, h('th', {}, t('Name')), h('th', {}, t('Scopes')), h('th', {}, t('Last used')), h('th')),
        tokens.map((tok) => h('tr', {}, h('td', {}, tok.name), h('td', {}, tok.scopes.join('+')), h('td', { class: 'muted' }, tok.lastUsed ? fmtTime(tok.lastUsed) : t('never')),
          h('td', {}, h('button', { class: 'btn small danger', onclick: async () => { await api('DELETE', '/api/tokens/' + tok.id); draw(); } }, t('Revoke')))))));
  };
  modal(t('API tokens & AI integration'), box, { wide: true });
  draw();
}

async function membersDialog() {
  const box = h('div', { style: { display: 'grid', gap: '10px' } });
  const owner = S.vault.role === 'owner';
  const draw = async () => {
    const { members } = await api('GET', API('/members'));
    const uname = h('input', { class: 'input', placeholder: t('Username to add') });
    const role = h('select', { class: 'input' }, ['viewer', 'editor', 'owner'].map((r) => h('option', { value: r, selected: r === 'editor' }, r)));
    box.replaceChildren(
      h('table', { class: 'table' }, members.map((m) => h('tr', {}, h('td', {}, m.displayName || m.username, h('span', { class: 'muted' }, ' @' + m.username)),
        h('td', {}, owner ? h('select', { class: 'input', onchange: async (e) => { try { await api('PUT', API('/members/' + m.username), { role: e.target.value }); } catch (x) { toast(x.message, 'error'); } draw(); } },
          ['viewer', 'editor', 'owner'].map((r) => h('option', { value: r, selected: r === m.role }, r))) : m.role),
        owner && h('td', {}, h('button', { class: 'btn small danger', onclick: async () => { try { await api('DELETE', API('/members/' + m.username)); } catch (x) { toast(x.message, 'error'); } draw(); } }, t('Remove')))))),
      owner ? h('label', { class: 'row muted' }, h('input', { type: 'checkbox', checked: S.vault.allowCopy !== false, onchange: async (e) => { try { await api('PATCH', API(''), { allowCopy: e.target.checked }); S.vault.allowCopy = e.target.checked; toast(e.target.checked ? 'Members can copy this vault' : 'Copying and export disabled for members', 'ok'); } catch (x) { toast(x.message, 'error'); } } }), t('Allow members to copy / export this vault')) : null,
      owner ? h('div', { class: 'row' }, uname, role, h('button', { class: 'btn primary', onclick: async () => { try { await api('PUT', API('/members/' + uname.value.trim()), { role: role.value }); draw(); } catch (x) { toast(x.message, 'error'); } } }, t('Add')))
        : h('p', { class: 'muted' }, 'Only owners can change membership.'),
      h('button', { class: 'btn', onclick: forkDialog }, t('Copy this vault to my own vault…')));
  };
  modal(tf.members(S.vault.name), box);
  draw();
}

async function shareDialog() {
  const isAdmin = S.user.role === 'admin';
  const isOwner = S.vault.role === 'owner';
  const box = h('div', { style: { display: 'grid', gap: '14px' } });
  let share = null, lastLink = '';
  const baseUrl = () => share?.url || S.cfg?.publicUrl || location.origin;
  const draw = async () => {
    if (isAdmin) { try { share = await api('GET', '/api/admin/share'); } catch { share = null; } }
    const invites = isOwner ? (await api('GET', API('/invites'))).invites : [];
    const base = h('input', { class: 'input', value: baseUrl() });
    const role = h('select', { class: 'input' }, h('option', { value: 'editor' }, t('Can edit')), h('option', { value: 'viewer' }, t('Can only read')));
    const uses = h('select', { class: 'input' }, [['1', t('One person')], ['5', t('Up to 5 people')], ['25', t('Up to 25 people')]].map(([v, l]) => h('option', { value: v }, l)));
    const hours = h('select', { class: 'input' }, [['0', t('Never expires')], ['24', t('1 day')], ['72', t('3 days')], ['168', t('7 days')], ['720', t('30 days')]].map(([v, l]) => h('option', { value: v, selected: v === '0' }, l)));
    const linkBox = h('div');
    const showLink = () => {
      if (!lastLink) return linkBox.replaceChildren();
      const url = base.value.replace(/\/+$/, '') + '/#invite=' + lastLink;
      const local = /^(https?:\/\/)?(localhost|127\.|\[::1\])/.test(base.value);
      const inp = h('input', { class: 'input', readonly: true, value: url, onclick: (e) => e.target.select() });
      linkBox.replaceChildren(h('div', { class: 'row' }, inp, h('button', { class: 'btn', onclick: async () => { await navigator.clipboard?.writeText(url); toast(t('Link copied'), 'ok'); } }, t('Copy'))),
        local && h('div', { class: 'muted', style: { color: 'var(--warn)' } }, '⚠ This address only works on your own computer. Start “Share online” below, or enter your public address above.'));
    };
    base.addEventListener('input', showLink);

    const inviteSection = isOwner ? h('section', { style: { display: 'grid', gap: '8px' } },
      h('b', {}, tf.invitePeople(S.vault.name)),
      h('div', { class: 'muted' }, 'They open the link, choose a username and password, and join automatically.'),
      h('div', { class: 'row' }, role, uses, hours),
      h('button', { class: 'btn primary', onclick: async () => { try { const r = await api('POST', API('/invites'), { role: role.value, maxUses: Number(uses.value), hours: Number(hours.value) }); lastLink = r.token; showLink(); } catch (e) { toast(e.message, 'error'); } } }, t('Create invite link')),
      linkBox,
      h('label', { class: 'muted' }, t('Public address used in the link')), base,
      invites.length ? h('table', { class: 'table' }, invites.map((i) => h('tr', {}, h('td', {}, i.role), h('td', { class: 'muted' }, i.uses + '/' + i.maxUses + ' used · ' + (i.expires ? 'expires ' + fmtTime(i.expires) : 'never expires')),
        h('td', {}, h('button', { class: 'btn small danger', onclick: async () => { await api('DELETE', API('/invites/' + i.id)); draw(); } }, t('Revoke')))))) : null)
      : h('p', { class: 'muted' }, 'Only vault owners can create invite links.');

    let shareSection = null;
    if (isAdmin) {
      const s = share;
      shareSection = h('section', { style: { display: 'grid', gap: '8px', borderTop: '1px solid var(--border)', paddingTop: '12px' } },
        h('b', {}, t('Share online')),
        h('div', { class: 'muted' }, 'Gives this server a public HTTPS address (Cloudflare quick tunnel) so people outside your network can connect. The address changes every time you start it, and stops when you stop it or restart the server.'),
        !s ? h('div', { class: 'muted' }, 'Status unavailable.')
          : s.permanent ? h('div', { style: { display: 'grid', gap: '6px' } }, h('div', { class: 'row' }, h('input', { class: 'input', readonly: true, value: s.url || '' }), h('button', { class: 'btn', onclick: async () => { await navigator.clipboard?.writeText(s.url || ''); toast(t('Address copied'), 'ok'); } }, t('Copy'))), h('div', { class: 'muted' }, 'This server has a permanent address (named Cloudflare tunnel configured by the server owner). It does not change when the server restarts.'))
          : !s.available ? h('div', { class: 'banner' }, 'The tunnel tool (cloudflared) is not installed here. It is included in the Docker image; for other setups see docs/DEPLOYMENT.md.')
          : s.active ? h('div', { style: { display: 'grid', gap: '8px' } },
              h('div', { class: 'row' }, h('input', { class: 'input', readonly: true, value: s.url, onclick: (e) => e.target.select() }), h('button', { class: 'btn', onclick: async () => { await navigator.clipboard?.writeText(s.url); toast(t('Address copied'), 'ok'); } }, t('Copy'))),
              h('div', { class: 'muted' }, 'Anyone with this address can see the login page. Sign-up stays closed: only invite links or accounts you create can get in. Use strong passwords.'),
              h('button', { class: 'btn danger', onclick: async () => { await api('DELETE', '/api/admin/share'); draw(); } }, t('Stop sharing')))
          : h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; e.target.textContent = t('Starting tunnel…'); try { await api('POST', '/api/admin/share'); } catch (x) { toast(x.message, 'error'); } draw(); } }, t('Start sharing online')),
        s?.error && h('div', { class: 'err' }, s.error));
    }
    box.replaceChildren(inviteSection, shareSection);
    showLink();
  };
  modal(t('Invite & share'), box, { wide: true });
  draw();
}

function forkDialog() {
  const folders = [...new Set(S.notes.filter((n) => n.folder).map((n) => n.folder.split('/')[0]))].sort();
  const name = h('input', { class: 'input', value: 'Copy of ' + S.vault.name });
  const folder = h('select', { class: 'input' }, h('option', { value: '' }, t('Everything')), folders.map((f) => h('option', { value: f }, tf.onlyFolder(f))));
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; go.textContent = t('Copying…');
    try {
      const r = await api('POST', API('/ops/fork'), { name: name.value, folder: folder.value });
      m.close();
      S.vaults = (await api('GET', '/api/vaults')).vaults;
      lsSet('vault', r.id);
      await enterWorkspace();
      toast('Copied ' + r.notes + ' notes into your own vault “' + r.name + '”', 'ok');
    } catch (e) { toast(e.message, 'error'); go.disabled = false; go.textContent = t('Copy'); }
  } }, t('Copy'));
  const m = modal(t('Copy to my own vault'), h('div', { style: { display: 'grid', gap: '8px' } },
    h('p', { class: 'muted' }, 'Creates a new vault that only you own, with a snapshot of these notes and their attachments. It stays yours even if you later lose access to the original, and it does not receive further changes.'),
    h('label', {}, t('New vault name')), name, h('label', {}, t('What to copy')), folder,
    h('div', { class: 'row end' }, go)));
}

async function adminDialog() {
  const box = h('div', { style: { display: 'grid', gap: '10px' } });
  const draw = async () => {
    const { users } = await api('GET', '/api/admin/users');
    const u = h('input', { class: 'input', placeholder: t('Username') }), p = h('input', { class: 'input', type: 'password', placeholder: t('Initial password') });
    const adm = h('input', { type: 'checkbox' });
    box.replaceChildren(
      h('table', { class: 'table' }, users.map((x) => h('tr', {}, h('td', {}, x.username), h('td', { class: 'muted' }, x.role), h('td', {}, x.disabled ? 'disabled' : ''),
        h('td', {}, x.id !== S.user.id && h('button', { class: 'btn small', onclick: async () => { await api('PATCH', '/api/admin/users/' + x.id, { disabled: !x.disabled }); draw(); } }, x.disabled ? t('Enable') : t('Disable')))))),
      h('b', {}, t('Add user')), h('div', { class: 'row' }, u, p), h('label', { class: 'row' }, adm, t('Administrator')),
      h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', '/api/admin/users', { username: u.value, password: p.value, role: adm.checked ? 'admin' : 'user' }); toast('User created', 'ok'); draw(); } catch (e) { toast(e.message, 'error'); } } }, t('Create user')),
      h('p', { class: 'muted' }, 'Then add them to a vault with the 👥 button.'));
  };
  modal(t('Users'), box);
  draw();
}

// ───────────────────────── palette & shortcuts ─────────────────────────
function commands() {
  const c = [
    { label: t('Create new note'), run: () => newNote() },
    { label: t('Toggle file panel'), run: () => togglePanel('left') },
    { label: t('Toggle side panel'), run: () => togglePanel('right') },
    { label: t('New folder'), run: () => newFolder() },
    ...(S.cur ? [{ label: t('Move note to folder…'), run: moveCurrentDialog }] : []),
    { label: t('Open daily note'), run: dailyNote },
    { label: t('Toggle graph view'), run: toggleGraph },
    { label: t('Toggle light/dark theme'), run: toggleTheme },
    { label: t('Layout: editor only'), run: () => { S.mode = 'edit'; lsSet('mode', 'edit'); renderMain(); } },
    { label: t('Layout: split editor + preview'), run: () => { S.mode = 'split'; lsSet('mode', 'split'); renderMain(); } },
    { label: t('Layout: reading view'), run: () => { S.mode = 'preview'; lsSet('mode', 'preview'); renderMain(); } },
    { label: t('Search in vault'), run: () => { S.sbTab = 'search'; renderSidebar(); $('#search-input')?.focus(); } },
    { label: t('API tokens & MCP setup'), run: tokensDialog },
    { label: t('Vault members'), run: membersDialog },
    { label: t('Invite people & share online'), run: shareDialog },
    { label: t('Create new vault'), run: createVault },
    { label: t('Copy this vault (or a folder) to my own vault'), run: forkDialog },
    { label: t('Download vault export (JSON)'), run: () => { location.href = API('/export'); } },
    { label: t('Sign out'), run: logout },
  ];
  if (S.cur) c.push({ label: t('Delete current note'), run: () => deleteNote(S.cur.path) });
  return c;
}

function quickSwitcher() {
  picker(t('Find or create a note…'), (q) => {
    const lq = q.toLowerCase();
    const hits = S.notes.filter((n) => !lq || n.path.toLowerCase().includes(lq) || n.title.toLowerCase().includes(lq))
      .sort((a, b) => (baseName(a.path).toLowerCase().startsWith(lq) ? 0 : 1) - (baseName(b.path).toLowerCase().startsWith(lq) ? 0 : 1) || b.mtime - a.mtime)
      .map((n) => ({ label: n.title, hint: n.folder, path: n.path }));
    if (q && !S.notes.some((n) => baseName(n.path).toLowerCase() === lq)) hits.push({ label: tf.createNamed(q), create: q });
    return hits;
  }, (it) => (it.create ? createNote(it.create, `# ${baseName(it.create)}\n\n`) : openNote(it.path)));
}

document.addEventListener('keydown', (e) => {
  if (!S.vault) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); saveNow(); }
  else if (mod && k === 'o') { e.preventDefault(); quickSwitcher(); }
  else if (mod && k === 'p') { e.preventDefault(); picker(t('Command…'), (q) => commands().filter((c) => c.label.toLowerCase().includes(q.toLowerCase())), (c) => c.run()); }
  else if (mod && k === 'g') { e.preventDefault(); toggleGraph(); }
  else if (mod && k === 'n') { e.preventDefault(); newNote(); }
  else if (mod && e.shiftKey && k === 'f') { e.preventDefault(); S.sbTab = 'search'; renderSidebar(); $('#search-input')?.focus(); }
});

// Never fail silently: show unexpected errors (e.g. a dialog that could not load)
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(String(e.reason?.message || e.reason), 'error'); });

boot();
