import { t } from './i18n.js';

export const $ = (s, r = document) => r.querySelector(s);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error(data?.error?.message || res.statusText);
    e.status = res.status; e.code = data?.error?.code; e.data = data?.error;
    throw e;
  }
  return data;
}

export function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

/** Generic modal. content: node. Returns {close, el}. */
export function modal(title, content, { wide = false } = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('b', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': t('Close') }, '✕')),
      h('div', { class: 'modal-body' }, content)));
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  return { close, el: back };
}

export function ask(title, { value = '', label = '', ok = t('OK'), type = 'text' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type, value, class: 'input', autofocus: true });
    const done = (v) => { m.close(); resolve(v); };
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); done(input.value.trim() || null); } },
      label && h('label', {}, label), input,
      h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, t('Cancel')), h('button', { class: 'btn primary' }, ok)));
    const m = modal(title, form);
    m.el.addEventListener('mousedown', (e) => { if (e.target === m.el) resolve(null); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function confirmBox(title, text, ok = t('Confirm')) {
  return new Promise((resolve) => {
    const done = (v) => { m.close(); resolve(v); };
    const m = modal(title, h('div', {}, h('p', {}, text),
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => done(false) }, t('Cancel')), h('button', { class: 'btn danger', onclick: () => done(true) }, ok))));
  });
}

/** Filterable list picker (quick switcher / command palette). */
export function picker(placeholder, getItems, onPick) {
  const input = h('input', { class: 'input big', placeholder, autofocus: true });
  const list = h('div', { class: 'picker-list' });
  let items = [], sel = 0;
  const render = () => {
    items = getItems(input.value.trim());
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.slice(0, 50).map((it, i) => h('div', { class: 'picker-item' + (i === sel ? ' sel' : ''), onclick: () => pick(i), onmousemove: () => { sel = i; mark(); } },
      h('span', {}, it.label), it.hint && h('span', { class: 'muted' }, it.hint))));
  };
  const mark = () => [...list.children].forEach((c, i) => c.classList.toggle('sel', i === sel));
  const pick = (i) => { const it = items[i]; if (!it) return; m.close(); onPick(it); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, Math.min(items.length, 50) - 1); mark(); e.preventDefault(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); mark(); e.preventDefault(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  });
  const m = modal('', h('div', {}, input, list));
  m.el.classList.add('picker');
  render();
  setTimeout(() => input.focus(), 0);
}

export const fmtTime = (t) => new Date(t).toLocaleString();
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const baseName = (p) => p.split('/').pop().replace(/\.md$/i, '');
