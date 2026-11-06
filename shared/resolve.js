// Obsidian-style wikilink resolution, shared by server and browser.

export function createResolver(paths) {
  const byPath = new Map();
  const byName = new Map();
  for (const p of paths) {
    const noExt = p.replace(/\.md$/i, '');
    byPath.set(noExt.toLowerCase(), p);
    const base = noExt.split('/').pop().toLowerCase();
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(p);
  }
  const common = (a, b) => {
    const x = a.split('/'), y = b.split('/');
    let i = 0;
    while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++;
    return i;
  };
  const pick = (cands, from) =>
    [...cands].sort((a, b) => common(b, from) - common(a, from) || a.split('/').length - b.split('/').length || a.localeCompare(b))[0];

  return function resolve(target, from = '') {
    let t = (target || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!t) return from || null;
    const lt = t.toLowerCase().replace(/\.md$/, '');
    if (lt.includes('/')) {
      const exact = byPath.get(lt);
      if (exact) return exact;
      const suffix = [...byPath.entries()].filter(([k]) => k.endsWith('/' + lt)).map(([, v]) => v);
      return suffix.length ? pick(suffix, from) : null;
    }
    const c = byName.get(lt);
    if (!c) return null;
    return c.length === 1 ? c[0] : pick(c, from);
  };
}
