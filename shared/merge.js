// Line-based three-way merge (diff3 style). Used so concurrent edits by several
// users/AI agents are merged instead of overwritten.

const MAX_CELLS = 16_000_000;

function lcsMatch(a, b) {
  const match = new Array(a.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { match[s] = s; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; match[ea] = eb; }
  const n = ea - s, m = eb - s;
  if (n === 0 || m === 0) return match;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[s + i] === b[s + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[s + i] === b[s + j]) { match[s + i] = s + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return match;
}

/** Line diff: [{t:'same'|'add'|'del', line}] from oldText to newText. */
export function diffLines(oldText, newText) {
  const A = oldText.split('\n'), B = newText.split('\n');
  const m = lcsMatch(A, B);
  if (!m) return [...A.map((line) => ({ t: 'del', line })), ...B.map((line) => ({ t: 'add', line }))];
  const out = [];
  let j = 0;
  for (let i = 0; i < A.length; i++) {
    if (m[i] >= 0) { while (j < m[i]) out.push({ t: 'add', line: B[j++] }); out.push({ t: 'same', line: A[i] }); j = m[i] + 1; } else out.push({ t: 'del', line: A[i] });
  }
  while (j < B.length) out.push({ t: 'add', line: B[j++] });
  return out;
}

const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

/** @returns {{text:string, conflict:boolean}} */
export function merge3(base, ours, theirs) {
  if (ours === theirs) return { text: ours, conflict: false };
  if (base === ours) return { text: theirs, conflict: false };
  if (base === theirs) return { text: ours, conflict: false };
  const B = base.split('\n'), O = ours.split('\n'), T = theirs.split('\n');
  const mo = lcsMatch(B, O), mt = lcsMatch(B, T);
  if (!mo || !mt) return { text: ours, conflict: true };
  const out = [];
  let conflict = false, bi = 0, oi = 0, ti = 0;
  const flush = (bEnd, oEnd, tEnd) => {
    const bs = B.slice(bi, bEnd), os = O.slice(oi, oEnd), ts = T.slice(ti, tEnd);
    if (same(os, bs)) out.push(...ts);
    else if (same(ts, bs) || same(os, ts)) out.push(...os);
    else {
      conflict = true;
      out.push('<<<<<<< yours', ...os, '=======', ...ts, '>>>>>>> theirs');
    }
  };
  for (let i = 0; i < B.length; i++) {
    if (mo[i] >= 0 && mt[i] >= 0) {
      flush(i, mo[i], mt[i]);
      out.push(B[i]);
      bi = i + 1; oi = mo[i] + 1; ti = mt[i] + 1;
    }
  }
  flush(B.length, O.length, T.length);
  return { text: out.join('\n'), conflict };
}
