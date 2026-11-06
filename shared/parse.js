// Shared (server + browser) markdown metadata parsing. Zero dependencies.

export const ATTACHMENT_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico',
  'pdf', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov',
  'zip', 'csv', 'txt', 'json',
]);

export function extOf(target) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(target);
  return m ? m[1].toLowerCase() : '';
}
export const isAttachmentTarget = (t) => ATTACHMENT_EXT.has(extOf(t));

const FENCE = /^\s*(`{3,}|~{3,})/;
const blank = (s) => ' '.repeat(s.length);

/** Replace code (fenced + inline) with spaces so offsets stay valid. */
export function maskCode(text) {
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const t = line.trim();
      if (t.length >= fence.len && t[0] === fence.ch && /^(`+|~+)$/.test(t)) fence = null;
      lines[i] = blank(line);
      continue;
    }
    const m = FENCE.exec(line);
    if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      lines[i] = blank(line);
      continue;
    }
    lines[i] = line.replace(/(`+)[^`\n]*?\1/g, (s) => blank(s));
  }
  return lines.join('\n');
}

function scalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(scalar);
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseYaml(src) {
  const data = {};
  let key = null;
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    let m;
    if (!/^\s/.test(line) && (m = /^([^:]+):\s*(.*)$/.exec(line))) {
      key = m[1].trim();
      data[key] = scalar(m[2]);
    } else if (key && (m = /^\s*-\s+(.*)$/.exec(line))) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(scalar(m[1]));
    }
  }
  return data;
}

export function parseFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, bodyStart: 0 };
  return { data: parseYaml(m[1]), body: text.slice(m[0].length), bodyStart: m[0].length };
}

const WIKI = /(!?)\[\[([^\[\]\n|#]*)(?:#([^\[\]\n|]*))?(?:\|([^\[\]\n]*))?\]\]/g;

export function parseWikiInner(inner) {
  const m = /^([^|#]*)(?:#([^|]*))?(?:\|(.*))?$/.exec(inner);
  return { target: (m[1] || '').trim(), heading: m[2]?.trim() || '', alias: m[3]?.trim() || '' };
}

/** Rewrite wikilinks outside code. fn({embed,target,heading,alias}) => new target string | undefined */
export function replaceWikiLinks(text, fn) {
  const masked = maskCode(text);
  let out = '';
  let last = 0;
  WIKI.lastIndex = 0;
  let m;
  while ((m = WIKI.exec(masked))) {
    const link = { embed: m[1] === '!', target: (m[2] || '').trim(), heading: m[3]?.trim() || '', alias: m[4]?.trim() || '' };
    const nt = fn(link);
    if (nt === undefined || nt === link.target) continue;
    const rebuilt = `${m[1]}[[${nt}${link.heading ? '#' + link.heading : ''}${link.alias ? '|' + link.alias : ''}]]`;
    out += text.slice(last, m.index) + rebuilt;
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

export function extractLinks(masked) {
  const links = [];
  let m;
  WIKI.lastIndex = 0;
  while ((m = WIKI.exec(masked))) {
    links.push({ target: (m[2] || '').trim(), heading: m[3]?.trim() || '', alias: m[4]?.trim() || '', embed: m[1] === '!' });
  }
  const md = /(?<!!)\[[^\]\n]*\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/g;
  while ((m = md.exec(masked))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    try { links.push({ target: decodeURIComponent(m[1]).replace(/^\.\//, '').replace(/\.md$/i, ''), heading: '', alias: '', embed: false }); } catch { /* ignore */ }
  }
  return links;
}

export function extractTags(masked, frontmatter = {}) {
  const tags = new Set();
  const re = /(?:^|\s)#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
  let m;
  while ((m = re.exec(masked))) tags.add(m[1].replace(/\/+$/, ''));
  let fm = frontmatter.tags ?? frontmatter.tag;
  if (typeof fm === 'string') fm = fm.split(/[,\s]+/);
  if (Array.isArray(fm)) for (const t of fm) if (typeof t === 'string' && t.trim()) tags.add(t.trim().replace(/^#/, ''));
  tags.delete('');
  return [...tags];
}

export function extractHeadings(masked) {
  const out = [];
  masked.split('\n').forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

export const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

export function parseNote(path, content) {
  const fm = parseFrontmatter(content);
  const masked = maskCode(fm.body);
  const base = path.split('/').pop().replace(/\.md$/i, '');
  const headings = extractHeadings(masked);
  const aliases = [].concat(fm.data.aliases ?? fm.data.alias ?? []).filter((x) => typeof x === 'string');
  return {
    path,
    title: typeof fm.data.title === 'string' && fm.data.title ? fm.data.title : base,
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    frontmatter: fm.data,
    aliases,
    tags: extractTags(masked, fm.data),
    links: extractLinks(masked),
    headings,
    words: (masked.match(/[\p{L}\p{N}']+/gu) || []).length,
  };
}
