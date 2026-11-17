import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphView } from '../web/js/graph.js';

// Runs the force simulation without a canvas: `connected` notes joined by links plus `orphans` with none.
function simulate(connected, orphans, ticks = 400) {
  const g = Object.create(GraphView.prototype);
  const nodes = [];
  const total = connected + orphans;
  const mk = (id, i) => {
    const a = (i / total) * Math.PI * 2 * 7, r = (120 + Math.sqrt(total) * 14) * Math.sqrt(i / total);
    return { id, label: id, type: 'note', folder: '', x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, fx: null, fy: null };
  };
  for (let i = 0; i < connected; i++) nodes.push(mk('c' + i, i));
  for (let i = 0; i < orphans; i++) nodes.push(mk('o' + i, connected + i));
  const links = [];
  for (let i = 1; i < connected; i++) links.push({ s: nodes[i], t: nodes[Math.floor((i - 1) / 2)] }); // a tree
  const deg = new Map();
  for (const l of links) { deg.set(l.s, (deg.get(l.s) || 0) + 1); deg.set(l.t, (deg.get(l.t) || 0) + 1); }
  Object.assign(g, {
    nodes, links, deg, alpha: 1, alphaTarget: 0, autoFit: false, ticks: 0, dirty: false,
    opt: { centerForce: 0.07, repelForce: 2, linkForce: 1, linkDistance: 95, territories: false, layout: 'force', clusterForce: 0.25, style: 'constellation', nodeSize: 1 },
  });
  for (let i = 0; i < ticks; i++) g._tick();
  const dist = (n) => Math.hypot(n.x, n.y);
  const conn = nodes.filter((n) => deg.get(n)), orph = nodes.filter((n) => !deg.get(n));
  let minGap = Infinity;
  for (let i = 0; i < orph.length; i++) for (let j = i + 1; j < orph.length; j++) minGap = Math.min(minGap, Math.hypot(orph[i].x - orph[j].x, orph[i].y - orph[j].y));
  return { reach: Math.max(...conn.map(dist)), orphanMax: Math.max(...orph.map(dist)), minGap };
}

test('notes without links stay right next to the linked graph instead of drifting away', () => {
  for (const [connected, orphans] of [[15, 6], [30, 30], [10, 60], [40, 12], [80, 25], [5, 100]]) {
    const r = simulate(connected, orphans);
    // before the fix they ended up 2 to 6 times further out than the linked part
    const limit = Math.max(r.reach + 40, orphans * 3.2) * 1.15;
    assert.ok(r.orphanMax <= limit, `${connected}+${orphans}: orphans reach ${r.orphanMax.toFixed(0)}, linked part ${r.reach.toFixed(0)}, limit ${limit.toFixed(0)}`);
  }
});

test('having unlinked notes does not blow up the linked part of the graph', () => {
  for (const [connected, orphans] of [[15, 6], [10, 60], [40, 12]]) {
    const alone = simulate(connected, 0).reach, withOrphans = simulate(connected, orphans).reach;
    assert.ok(withOrphans <= alone * 1.25, `${connected}+${orphans}: ${withOrphans.toFixed(0)} vs ${alone.toFixed(0)} without them`);
  }
});

test('unlinked notes do not pile up on each other', () => {
  for (const [connected, orphans] of [[15, 6], [10, 60], [5, 100]]) {
    const r = simulate(connected, orphans);
    assert.ok(r.minGap > 8, `${connected}+${orphans}: closest pair ${r.minGap.toFixed(1)}px apart`);
  }
});

test('a vault where nothing is linked is left alone (no ring to hold them in)', () => {
  const g = Object.create(GraphView.prototype);
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, label: 'n' + i, type: 'note', folder: '', x: Math.cos(i) * 80, y: Math.sin(i) * 80, vx: 0, vy: 0, fx: null, fy: null }));
  Object.assign(g, {
    nodes, links: [], deg: new Map(), alpha: 1, alphaTarget: 0, autoFit: false, ticks: 0, dirty: false,
    opt: { centerForce: 0.07, repelForce: 2, linkForce: 1, linkDistance: 95, territories: false, layout: 'force', clusterForce: 0.25, style: 'constellation', nodeSize: 1 },
  });
  for (let i = 0; i < 400; i++) g._tick();
  assert.ok(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.ok(Math.max(...nodes.map((n) => Math.hypot(n.x, n.y))) < 600);
});
