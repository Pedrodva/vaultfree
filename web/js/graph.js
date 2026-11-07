// Obsidian-style interactive graph: force simulation (Barnes-Hut), canvas rendering,
// zoom/pan/drag, hover-highlight of neighbours, groups, filters. No dependencies.

const DEFAULTS = {
  centerForce: 0.07, repelForce: 2, linkForce: 1, linkDistance: 95,
  nodeSize: 1, linkThickness: 1, textFade: 0.8, arrows: false, colorBy: 'folder', groups: [], style: 'constellation',
  territories: false, clusterForce: 0.25, layout: 'force', depth: 1,
};

const PALETTE = ['#a88bfa', '#5eead4', '#f59e0b', '#f472b6', '#60a5fa', '#a3e635', '#fb7185', '#38bdf8', '#e879f9', '#facc15'];

export class GraphView {
  constructor(canvas, { onOpen, onHover, current = null, options = {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opt = { ...DEFAULTS, ...options };
    this.onOpen = onOpen || (() => {});
    this.onHover = onHover || (() => {});
    this.onBackground = arguments[1]?.onBackground || (() => {});
    this.current = current;
    this.nodes = []; this.links = []; this.byId = new Map();
    this.view = { x: 0, y: 0, k: 1 };
    this.alpha = 0; this.alphaTarget = 0;
    this.hover = null; this.drag = null; this.pan = null; this.moved = false;
    this.dirty = true; this.running = true;
    this.autoFit = true; this.ticks = 0; // keep the view framed while the layout settles, until the user moves it
    this.colors = {};
    this.folderColor = new Map();
    this._bind();
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas.parentElement || canvas);
    const loop = () => { if (!this.running) return; this._tick(); this._draw(); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  destroy() { this.running = false; cancelAnimationFrame(this._raf); this._ro.disconnect(); }

  readTheme() {
    const cs = getComputedStyle(this.canvas);
    const g = (n, d) => cs.getPropertyValue(n).trim() || d;
    this.colors = { bg: g('--graph-bg', g('--bg', '#1e1e1e')), node: g('--graph-node', '#9aa0a6'), link: g('--graph-link', '#4a4a4f'),
      text: g('--text', '#dcddde'), accent: g('--accent', '#a88bfa'), dim: g('--graph-dim', '#33333a'), ghost: g('--graph-ghost', '#5b5b66'), tag: g('--graph-tag', '#5eead4') };
    this.dirty = true;
  }

  setOptions(o, reheat = true) {
    Object.assign(this.opt, o);
    if (reheat) this.reheat();
    this.dirty = true;
  }

  setCurrent(id) { this.current = id; this.dirty = true; }

  setData({ nodes, edges }) {
    const old = this.byId;
    const R = 120 + Math.sqrt(nodes.length) * 14;
    this.nodes = nodes.map((n, i) => {
      const prev = old.get(n.id);
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2 * 7;
      const r = R * Math.sqrt(i / Math.max(1, nodes.length));
      return Object.assign(n, { x: prev ? prev.x : Math.cos(a) * r, y: prev ? prev.y : Math.sin(a) * r, vx: 0, vy: 0, fx: null, fy: null });
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = edges.filter((e) => this.byId.has(e.source) && this.byId.has(e.target))
      .map((e) => ({ s: this.byId.get(e.source), t: this.byId.get(e.target), mutual: e.mutual }));
    const deg = new Map();
    for (const l of this.links) { deg.set(l.s, (deg.get(l.s) || 0) + 1); deg.set(l.t, (deg.get(l.t) || 0) + 1); }
    this.deg = deg;
    this._markHubs();
    this.adj = new Map(this.nodes.map((n) => [n, new Set()]));
    for (const l of this.links) { this.adj.get(l.s).add(l.t); this.adj.get(l.t).add(l.s); }
    this.readTheme();
    this._assignColors();
    const same = old.size === nodes.length && nodes.every((n) => old.has(n.id));
    if (!same) { this.autoFit = true; this.ticks = 0; }
    if (!old.size) this.fit(false);
    this.alpha = 1;
    if (this.opt.layout === 'orbit') { this._orbit(); this.alpha = 0; this.fit(false); }
    this.dirty = true;
  }

  /** Static radial layout: the current note in the middle, neighbours in rings by link distance. */
  _orbit() {
    const center = this.byId.get(this.current) || this.nodes[0];
    if (!center) return;
    const maxD = Math.max(1, this.opt.depth || 1);
    const depth = new Map([[center, 0]]);
    let frontier = [center];
    for (let d = 1; d <= maxD; d++) {
      const next = [];
      for (const n of frontier) for (const m of this.adj.get(n)) if (!depth.has(m)) { depth.set(m, d); next.push(m); }
      frontier = next;
    }
    const rings = new Map();
    for (const n of this.nodes) { const d = depth.has(n) ? depth.get(n) : maxD + 1; if (!rings.has(d)) rings.set(d, []); rings.get(d).push(n); }
    this.ringR = [];
    for (const [d, arr] of rings) {
      if (d === 0) { center.x = center.y = 0; continue; }
      arr.sort((a, b) => a.label.localeCompare(b.label));
      const R = 62 * d + Math.max(0, arr.length - 8) * 4;
      this.ringR.push(R);
      arr.forEach((n, i) => { const a = (i / arr.length) * Math.PI * 2 - Math.PI / 2 + d * 0.35; n.x = Math.cos(a) * R; n.y = Math.sin(a) * R; });
    }
    for (const n of this.nodes) { n.hx = n.fx = n.x; n.hy = n.fy = n.y; n.vx = n.vy = 0; n.ring = depth.has(n) ? depth.get(n) : maxD + 1; }
  }

  screenPos(n) { return { x: this.w / 2 + this.view.x + n.x * this.view.k, y: this.h / 2 + this.view.y + n.y * this.view.k }; }

  _assignColors() {
    const folders = [...new Set(this.nodes.filter((n) => n.type === 'note').map((n) => n.folder.split('/')[0] || ''))].sort();
    folders.forEach((f, i) => this.folderColor.set(f, f ? PALETTE[i % PALETTE.length] : null));
    for (const n of this.nodes) n.color = this._colorOf(n);
  }

  _colorOf(n) {
    if (n.type === 'unresolved') return this.colors.ghost;
    if (n.type === 'tag') return this.colors.tag;
    for (const g of this.opt.groups) {
      const q = (g.query || '').trim();
      if (!q) continue;
      const tag = /^tag:#?(\S+)/i.exec(q), path = /^path:(\S+)/i.exec(q);
      if (tag && n.tags?.some((t) => t === tag[1] || t.startsWith(tag[1] + '/'))) return g.color;
      if (path && n.id.toLowerCase().includes(path[1].toLowerCase())) return g.color;
      if (!tag && !path && n.label.toLowerCase().includes(q.toLowerCase())) return g.color;
    }
    if (this.opt.colorBy === 'freshness' && n.mtime) {
      const days = (Date.now() - n.mtime) / 86400000;
      return days < 7 ? '#5eead4' : days < 30 ? '#f59e0b' : '#fb7185';
    }
    if (this.opt.colorBy === 'folder') return this.folderColor.get(n.folder.split('/')[0] || '') || this.colors.node;
    return this.colors.node;
  }

  recolor() { this.readTheme(); for (const n of this.nodes) n.color = this._colorOf(n); this.dirty = true; }

  reheat(a = 0.6) { this.alpha = Math.max(this.alpha, a); }

  /** Hubs = the best-connected notes (top ~15%, at least 3 links). Constellation labels and halos them. */
  _markHubs() {
    const degs = this.nodes.map((n) => this.deg.get(n) || 0).sort((a, b) => b - a);
    const cut = Math.max(3, degs[Math.min(degs.length - 1, Math.floor(degs.length * 0.15))] || 0);
    for (const n of this.nodes) n.hub = (this.deg.get(n) || 0) >= cut && n.type === 'note';
  }

  radius(n) {
    const d = this.deg?.get(n) || 0;
    const base = this.opt.style === 'classic' ? 3 + Math.sqrt(d) * 2.1 : 1.8 + Math.sqrt(d) * 1.35;
    return base * this.opt.nodeSize * (n.type === 'unresolved' ? 0.8 : 1);
  }

  // ---------- simulation ----------
  _tick() {
    if (this.alpha < 0.002 && this.alphaTarget === 0) return;
    this.alpha += (this.alphaTarget - this.alpha) * 0.0228;
    if (this.autoFit && ++this.ticks % 6 === 0) this.fit(false);
    const a = this.alpha, o = this.opt, nodes = this.nodes;
    // link force
    for (const l of this.links) {
      const s = l.s, t = l.t;
      let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy;
      const len = Math.hypot(dx, dy) || 1e-6;
      const ds = this.deg.get(s), dt = this.deg.get(t);
      const k = ((len - o.linkDistance) / len) * a * 0.5 * o.linkForce / Math.min(ds, dt);
      dx *= k; dy *= k;
      const b = ds / (ds + dt);
      t.vx -= dx * b; t.vy -= dy * b; s.vx += dx * (1 - b); s.vy += dy * (1 - b);
    }
    // many-body repulsion (Barnes-Hut)
    this._repel(a * 40 * o.repelForce);
    // collections pull their notes together so they form islands
    const cf = o.territories && o.layout !== 'orbit' ? o.clusterForce : 0;
    if (cf > 0) {
      const groups = new Map();
      for (const n of nodes) {
        if (n.type !== 'note') continue;
        const k = n.folder.split('/')[0];
        if (!k) continue;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { x: 0, y: 0, n: 0 }));
        g.x += n.x; g.y += n.y; g.n++;
      }
      // keep islands apart so they do not pile up
      const list = [...groups.values()];
      for (const g of list) { g.cx = g.x / g.n; g.cy = g.y / g.n; g.r = 26 * Math.sqrt(g.n) + 24; g.px = 0; g.py = 0; }
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j];
          if (A.n < 2 || B.n < 2) continue;
          let dx = B.cx - A.cx, dy = B.cy - A.cy;
          const d = Math.hypot(dx, dy) || 0.01, want = (A.r + B.r) * 1.05;
          if (d < want) { dx /= d; dy /= d; const f = (want - d) * 0.09 * a; A.px -= dx * f; A.py -= dy * f; B.px += dx * f; B.py += dy * f; }
        }
      }
      for (const n of nodes) {
        if (n.type !== 'note') continue;
        const g = groups.get(n.folder.split('/')[0]);
        if (g && g.n > 1) { n.vx += (g.cx - n.x) * cf * a + g.px; n.vy += (g.cy - n.y) * cf * a + g.py; }
      }
    }
    // centre pull
    for (const n of nodes) { n.vx -= n.x * o.centerForce * a * 0.1; n.vy -= n.y * o.centerForce * a * 0.1; }
    for (const n of nodes) {
      if (n.fx != null) { n.x = n.fx; n.vx = 0; } else { n.vx *= 0.6; n.x += n.vx; }
      if (n.fy != null) { n.y = n.fy; n.vy = 0; } else { n.vy *= 0.6; n.y += n.vy; }
    }
    this.dirty = true;
  }

  _repel(strength) {
    const nodes = this.nodes;
    if (nodes.length < 2) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y; }
    const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
    const root = { x0: minX, y0: minY, size, cx: 0, cy: 0, m: 0, kids: null, node: null };
    const insert = (q, n, depth) => {
      if (q.m === 0) { q.node = n; q.cx = n.x; q.cy = n.y; q.m = 1; return; }
      const m = q.m;
      q.cx = (q.cx * m + n.x) / (m + 1); q.cy = (q.cy * m + n.y) / (m + 1); q.m = m + 1;
      if (!q.kids) {
        if (depth >= 40 || (q.node.x === n.x && q.node.y === n.y)) return; // coincident points stay in one leaf
        const old = q.node;
        q.node = null; q.kids = [null, null, null, null];
        child(q, old, depth);
      }
      child(q, n, depth);
    };
    const child = (q, n, depth) => {
      const h = q.size / 2;
      const ix = n.x >= q.x0 + h ? 1 : 0, iy = n.y >= q.y0 + h ? 1 : 0, idx = iy * 2 + ix;
      const c = q.kids[idx] || (q.kids[idx] = { x0: q.x0 + ix * h, y0: q.y0 + iy * h, size: h, cx: 0, cy: 0, m: 0, kids: null, node: null });
      insert(c, n, depth + 1);
    };
    for (const n of nodes) insert(root, n, 0);
    const theta2 = 0.81;
    const apply = (q, n) => {
      if (!q.m) return;
      let dx = q.cx - n.x, dy = q.cy - n.y;
      let d2 = dx * dx + dy * dy;
      if (!q.kids || (q.size * q.size) / d2 < theta2) {
        if (q.node === n && q.m === 1) return;
        if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = dx * dx + dy * dy + 1; }
        if (d2 > 160000) return;
        const w = (strength * q.m) / d2;
        n.vx -= dx * w; n.vy -= dy * w;
        return;
      }
      for (const c of q.kids) if (c) apply(c, n);
    };
    for (const n of nodes) apply(root, n);
  }

  // ---------- view ----------
  fit(animate = true) {
    if (!this.nodes.length) return;
    const w = this.w, h = this.h;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const pad = this.opt.territories && this.opt.layout !== 'orbit' ? 200 : 90; // islands extend beyond their notes
    const k = Math.min(w / (maxX - minX + pad), h / (maxY - minY + pad), 3);
    this.view = { k: isFinite(k) && k > 0 ? k : 1, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k };
    this.dirty = true;
  }

  _resize() {
    const p = this.canvas.parentElement || this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, p.clientWidth); this.h = Math.max(50, p.clientHeight);
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
    this.dpr = dpr; this.dirty = true;
    if (this.autoFit && this.nodes?.length) this.fit(false);
  }

  toWorld(px, py) { return { x: (px - this.w / 2 - this.view.x) / this.view.k, y: (py - this.h / 2 - this.view.y) / this.view.k }; }

  nodeAt(px, py) {
    const p = this.toWorld(px, py);
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      const r = this.radius(n) + 4 / this.view.k;
      if (d < r && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.autoFit = false;
      const [x, y] = pos(e);
      this.moved = false;
      const n = this.nodeAt(x, y);
      if (n) { this.drag = n; const w = this.toWorld(x, y); n.fx = w.x; n.fy = w.y; this.alphaTarget = 0.3; this.alpha = Math.max(this.alpha, 0.3); }
      else this.pan = { x, y, vx: this.view.x, vy: this.view.y };
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (this.drag) { this.moved = true; const w = this.toWorld(x, y); this.drag.fx = w.x; this.drag.fy = w.y; return; }
      if (this.pan) { this.moved = true; this.view.x = this.pan.vx + (x - this.pan.x); this.view.y = this.pan.vy + (y - this.pan.y); this.dirty = true; return; }
      const n = this.nodeAt(x, y);
      if (n !== this.hover) { this.hover = n; c.style.cursor = n ? 'pointer' : 'grab'; this.onHover(n, e); this.dirty = true; }
    });
    const up = () => {
      if (this.drag) {
        const n = this.drag;
        if (this.opt.layout === 'orbit') { n.fx = n.x = n.hx; n.fy = n.y = n.hy; } else n.fx = n.fy = null;
        this.alphaTarget = 0; this.drag = null;
        if (!this.moved && n.type === 'note') this.onOpen(n);
        else if (!this.moved && n.type === 'tag') this.onOpen(n);
      }
      if (this.pan && !this.moved) this.onBackground();
      this.pan = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { if (!this.drag && this.hover) { this.hover = null; this.onHover(null); this.dirty = true; } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.autoFit = false;
      const [x, y] = pos(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(8, Math.max(0.05, this.view.k * f));
      const w = this.toWorld(x, y);
      this.view.k = k;
      this.view.x = x - this.w / 2 - w.x * k;
      this.view.y = y - this.h / 2 - w.y * k;
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.fit(); this.autoFit = true; this.ticks = 0; });
    c.style.cursor = 'grab';
  }

  // ---------- drawing ----------
  _drawTerritories(view, C) {
    const { ctx } = this;
    const groups = new Map();
    for (const n of this.nodes) {
      if (n.type !== 'note') continue;
      const k = n.folder.split('/')[0];
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const fs = 13 / Math.max(view.k, 0.6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    for (const [k, arr] of groups) {
      if (arr.length < 2) continue;
      let cx = 0, cy = 0;
      for (const n of arr) { cx += n.x; cy += n.y; }
      cx /= arr.length; cy /= arr.length;
      const d = arr.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
      const r = d[Math.min(d.length - 1, Math.floor(d.length * 0.9))] + 26;
      const col = this.folderColor.get(k) || C.node;
      ctx.globalAlpha = 0.08; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.4; ctx.strokeStyle = col; ctx.lineWidth = 1 / view.k; ctx.setLineDash([5 / view.k, 4 / view.k]); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.95; ctx.fillStyle = col; ctx.fillText(k, cx, cy - r - fs * 0.9);
    }
    ctx.globalAlpha = 1;
  }

  _draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { ctx, w, h, view, colors: C, opt } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg || '#1e1e1e';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    if (opt.territories && opt.layout !== 'orbit') this._drawTerritories(view, C);
    if (opt.layout === 'orbit' && this.ringR) {
      ctx.strokeStyle = C.link; ctx.lineWidth = 1 / view.k; ctx.setLineDash([3 / view.k, 4 / view.k]); ctx.globalAlpha = 0.6;
      for (const R of this.ringR) { ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    const hov = this.hover || this.drag;
    const hl = hov ? this.adj.get(hov) : null;
    const isLit = (n) => !hov || n === hov || hl.has(n);

    // links
    const constel = opt.style !== 'classic';
    const lw = (constel ? Math.max(0.35, opt.linkThickness * 0.5) : Math.max(0.6, opt.linkThickness)) / Math.sqrt(view.k + 0.3);
    ctx.lineWidth = lw;
    ctx.strokeStyle = hov ? C.dim : C.link;
    ctx.globalAlpha = constel && !hov ? 0.7 : 1;
    ctx.beginPath();
    for (const l of this.links) {
      if (hov && (l.s === hov || l.t === hov)) continue;
      ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (hov) {
      ctx.strokeStyle = C.accent; ctx.lineWidth = lw * 1.4;
      ctx.beginPath();
      for (const l of this.links) if (l.s === hov || l.t === hov) { ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); }
      ctx.stroke();
    }
    if (opt.arrows) {
      ctx.fillStyle = hov ? C.dim : C.link;
      for (const l of this.links) {
        const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1;
        const r = this.radius(l.t) + 2, ux = dx / d, uy = dy / d, px = l.t.x - ux * r, py = l.t.y - uy * r, s = 5 / Math.sqrt(view.k);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - ux * s - uy * s * 0.5, py - uy * s + ux * s * 0.5); ctx.lineTo(px - ux * s + uy * s * 0.5, py - uy * s - ux * s * 0.5); ctx.fill();
      }
    }

    // nodes
    for (const n of this.nodes) {
      const r = this.radius(n);
      if (constel && (n.hub || n.id === this.current || n === hov)) { // soft halo, like a bright star
        ctx.globalAlpha = isLit(n) ? 0.16 : 0.04;
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = n.id === this.current ? C.accent : n.color || C.node; ctx.fill();
      }
      ctx.globalAlpha = isLit(n) ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.id === this.current ? C.accent : n.color || C.node;
      ctx.fill();
      if (n.id === this.current || n === hov) { ctx.lineWidth = (constel ? 1.2 : 2) / view.k; ctx.strokeStyle = C.accent; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;

    // labels (fade in with zoom, like Obsidian)
    const fade = Math.max(0, Math.min(1, (view.k - (1.2 - opt.textFade)) * 1.6));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fs = (constel ? 11 : 12) / Math.max(view.k, 0.55);
    const fadeSmall = Math.max(0, Math.min(1, (view.k - (2.4 - opt.textFade * 1.2)) * 1.4));
    const fadeHub = Math.min(1, 0.6 + view.k * 0.4);
    ctx.font = `${fs}px system-ui, sans-serif`;
    for (const n of this.nodes) {
      const lit = isLit(n);
      const emphasized = n === hov || n.id === this.current || (hov && hl.has(n));
      const base = opt.layout === 'orbit' ? (n.ring <= 1 ? 1 : 0) : constel ? (n.hub ? fadeHub : fadeSmall) : fade;
      const alpha = emphasized ? 1 : lit ? base * (n.type === 'unresolved' ? 0.6 : constel ? 0.95 : 0.85) : 0;
      if (alpha < 0.05) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = C.text;
      ctx.fillText(n.label, n.x, n.y + this.radius(n) + 3 / view.k);
    }
    ctx.globalAlpha = 1;
  }
}
