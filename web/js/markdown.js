// Safe Markdown -> HTML renderer with Obsidian extensions (wikilinks, callouts, tags, embeds, tasks).
import { slugify, parseFrontmatter, isAttachmentTarget, parseWikiInner } from '/shared/parse.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function safeUrl(u) {
  u = u.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(https?:|mailto:)/i.test(u)) return '#';
  return u;
}

function wikilink(bang, inner, ctx) {
  const { target, heading, alias } = parseWikiInner(inner);
  if (bang) {
    if (isAttachmentTarget(target)) {
      const url = ctx.fileUrl?.(target);
      if (/\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(target)) return `<img src="${esc(url || '')}" alt="${esc(alias || target)}" loading="lazy">`;
      if (/\.(mp3|wav|ogg|m4a)$/i.test(target)) return `<audio controls src="${esc(url || '')}"></audio>`;
      if (/\.(mp4|webm|mov)$/i.test(target)) return `<video controls src="${esc(url || '')}"></video>`;
      return `<a href="${esc(url || '#')}" target="_blank" rel="noopener">${esc(target)}</a>`;
    }
    const p = ctx.resolve?.(target);
    if (p) return `<div class="embed-note" data-path="${esc(p)}" data-heading="${esc(heading)}"><div class="embed-title">${esc(target)}</div></div>`;
  }
  const label = alias || (heading ? `${target || ''} > ${heading}` : target);
  const p = target ? ctx.resolve?.(target) : ctx.current;
  const cls = p ? 'internal-link' : 'internal-link unresolved';
  return `<a class="${cls}" href="#" data-path="${esc(p || '')}" data-target="${esc(target)}" data-heading="${esc(heading)}">${esc(label || target)}</a>`;
}

export function inline(text, ctx = {}) {
  const stash = [];
  const put = (h) => `\u0000${stash.push(h) - 1}\u0000`;
  text = text.replace(/\u0000/g, '');
  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => put(`<code>${esc(c.trim())}</code>`));
  text = text.replace(/(!?)\[\[([^\[\]\n]+?)\]\]/g, (_, bang, inner) => put(wikilink(bang, inner, ctx)));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url) => {
    const u = /^(https?:|data:image)/i.test(url) ? url : ctx.fileUrl?.(decodeURI(url)) || url;
    return put(`<img src="${esc(safeUrl(u))}" alt="${esc(alt)}" loading="lazy">`);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url) => {
    if (/\.md(#.*)?$/i.test(url) && !/^[a-z]+:/i.test(url)) {
      const t = decodeURI(url).replace(/\.md.*$/i, '');
      const p = ctx.resolve?.(t);
      return put(`<a class="internal-link${p ? '' : ' unresolved'}" href="#" data-path="${esc(p || '')}" data-target="${esc(t)}">${inline(label, ctx)}</a>`);
    }
    return put(`<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${inline(label, ctx)}</a>`);
  });
  text = esc(text);
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (_, pre, url) => pre + put(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  text = text.replace(/(^|\s)#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu, (_, pre, tag) => `${pre}<a class="tag" href="#" data-tag="${tag}">#${tag}</a>`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
  return text.replace(/\n/g, '<br>');
}

const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR = /^ {0,3}([-*_])( *\1){2,} *$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function startsBlock(l, next) {
  return FENCE.test(l) || /^#{1,6}\s/.test(l) || HR.test(l) || /^\s*>/.test(l) || LIST.test(l) || (l.includes('|') && next !== undefined && TABLE_SEP.test(next));
}

function splitRow(l) {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parseBlocks(lines, ctx, off = 0) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const ch = m[1][0], len = m[1].length;
      const buf = [];
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.length >= len && t[0] === ch && /^(`+|~+)$/.test(t)) break;
        buf.push(lines[i++]);
      }
      i++;
      html += `<pre><code${m[2] ? ` class="language-${esc(m[2])}"` : ''}>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if ((m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line))) {
      html += `<h${m[1].length} id="${esc(slugify(m[2]))}" data-line="${off + i}">${inline(m[2], ctx)}</h${m[1].length}>`;
      i++; continue;
    }
    if (HR.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*> ?/, ''));
      const co = /^\[!(\w+)\]([+-]?)\s*(.*)$/.exec(buf[0]);
      if (co) {
        const type = co[1].toLowerCase();
        html += `<div class="callout callout-${esc(type)}"><div class="callout-title">${inline(co[3] || co[1][0].toUpperCase() + type.slice(1), ctx)}</div><div class="callout-body">${parseBlocks(buf.slice(1), ctx)}</div></div>`;
      } else html += `<blockquote>${parseBlocks(buf, ctx)}</blockquote>`;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cell = (t, c, k) => `<${t}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c || '', ctx)}</${t}>`;
      html += `<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if ((m = LIST.exec(line))) {
      const base = indentOf(line);
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const lm = LIST.exec(lines[i]);
        if (!lm || indentOf(lines[i]) !== base) break;
        const item = { first: lm[3], line: off + i, body: [] };
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const nx = lines.slice(i + 1).find((x) => x.trim());
            if (nx !== undefined && indentOf(nx) > base) { item.body.push(''); i++; continue; }
            break;
          }
          if (indentOf(l) > base) { item.body.push(l); i++; } else break;
        }
        items.push(item);
        while (i < lines.length && !lines[i].trim() && LIST.test(lines.slice(i + 1).find((x) => x.trim()) || '') && indentOf(lines.slice(i + 1).find((x) => x.trim())) === base) i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>` + items.map((it) => {
        const min = Math.min(...it.body.filter((x) => x.trim()).map(indentOf), Infinity);
        const body = it.body.map((x) => (x.trim() ? x.replace(/\t/g, '    ').slice(min) : ''));
        const tm = /^\[( |x|X)\]\s+(.*)$/.exec(it.first);
        const first = tm ? `<input type="checkbox" class="task" data-line="${it.line}" ${tm[1] !== ' ' ? 'checked' : ''}> ${inline(tm[2], ctx)}` : inline(it.first, ctx);
        return `<li${tm ? ' class="task-item"' : ''}>${first}${body.some((x) => x.trim()) ? parseBlocks(body, ctx, it.line + 1) : ''}</li>`;
      }).join('') + `</${tag}>`;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) buf.push(lines[i++]);
    html += `<p>${inline(buf.join('\n'), ctx)}</p>`;
  }
  return html;
}

export function renderMarkdown(src, ctx = {}) {
  const fm = parseFrontmatter(src.replace(/\r\n?/g, '\n'));
  const text = src.replace(/\r\n?/g, '\n');
  const fmLines = fm.bodyStart ? text.slice(0, fm.bodyStart).split('\n').length - 1 : 0;
  let props = '';
  const keys = Object.keys(fm.data);
  if (keys.length) {
    props = '<div class="properties">' + keys.map((k) => {
      const v = fm.data[k];
      const vals = Array.isArray(v) ? v : [v];
      return `<div class="prop"><span class="prop-key">${esc(k)}</span><span class="prop-val">${vals.map((x) => (/^tags?$/.test(k) ? `<a class="tag" href="#" data-tag="${esc(String(x).replace(/^#/, ''))}">#${esc(String(x).replace(/^#/, ''))}</a>` : `<span>${esc(String(x ?? ''))}</span>`)).join(' ')}</span></div>`;
    }).join('') + '</div>';
  }
  return props + parseBlocks(fm.body.split('\n'), ctx, fmLines);
}
