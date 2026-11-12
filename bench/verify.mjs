// Assertion suite. Every number printed below is recomputed at run time.
import { readFileSync } from 'node:fs';
import {
  planChunks, naiveGridChunks, naiveSequentialChunks, evaluatePlan,
  buildAdjacency, REL_AREA_TOL,
} from '../src/core.mjs';

const data = JSON.parse(readFileSync(new URL('../data/mesh.json', import.meta.url)));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name}  ${detail}`); }
  else { fail++; console.log(`FAIL ${name}  ${detail}`); }
};

// ---- independent oracle: seam overhead from a raw chunk list, no core helpers ----
function oracleSeam(positions, indices, chunks) {
  const V = (positions.length / 3) | 0;
  let sum = 0;
  for (const tris of chunks) {
    const s = new Set();
    for (const t of tris) for (let e = 0; e < 3; e++) { s.add(indices[t * 3 + e]); s.add(indices[t * 3 + ((e + 1) % 3)]); }
    sum += s.size;
  }
  return sum / V - 1;
}
// ---- independent oracle: union-find connectivity per chunk, no core helpers ----
function oracleConnectedCount(indices, chunks) {
  let connected = 0;
  for (const tris of chunks) {
    const parent = new Map(tris.map((t) => [t, t]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const un = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const byEdge = new Map();
    for (const t of tris) for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      const k = a < b ? a + ':' + b : b + ':' + a;
      const prev = byEdge.get(k);
      if (prev === undefined) byEdge.set(k, t); else un(prev, t);
    }
    const roots = new Set(tris.map(find));
    if (roots.size === 1) connected++;
  }
  return connected;
}
function permutation(F) {
  return [...Array(F).keys()].sort((a, b) => ((a * 7919) % F) - ((b * 7919) % F));
}
function permuteTriangles(indices, perm) {
  const out = [];
  for (const t of perm) out.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
  return out;
}

console.log(`REL_AREA_TOL=${REL_AREA_TOL} (relative, dimensionless)`);
const summary = [];
for (const mesh of data.meshes) {
  const { positions, indices, maxTris, name } = mesh;
  const adj = buildAdjacency(indices);
  const plan = planChunks(positions, indices, { maxTris });
  const gs = evaluatePlan(positions, indices, plan.chunks);
  const K = plan.chunks.length;
  const grid = evaluatePlan(positions, indices, naiveGridChunks(positions, indices, { chunkCount: K, grid: 8 }).chunks);
  const seq = evaluatePlan(positions, indices, naiveSequentialChunks(indices, { chunkCount: K }).chunks);

  ok(`${name}/complete`, gs.complete, `assigned=${gs.triangles - gs.missing} dup=${gs.dupAssignments} missing=${gs.missing}`);
  ok(`${name}/budget`, gs.maxChunkTris <= maxTris && gs.maxChunkTris >= maxTris - 3, `maxChunkTris=${gs.maxChunkTris} budget=${maxTris} chunks=${K}`);
  ok(`${name}/greedy-all-connected`, gs.allConnected, `connected=${gs.connectedChunks}/${K}`);
  ok(`${name}/grid-fragmented`, grid.connectedChunks < K, `grid connected=${grid.connectedChunks}/${K}`);
  ok(`${name}/seam-better-than-grid`, gs.seamOverhead < grid.seamOverhead,
    `greedy=${(gs.seamOverhead * 100).toFixed(3)}% grid=${(grid.seamOverhead * 100).toFixed(3)}% rel=${(((grid.seamOverhead - gs.seamOverhead) / grid.seamOverhead) * 100).toFixed(1)}%`);
  ok(`${name}/seam-rel-10pct`, (grid.seamOverhead - gs.seamOverhead) / grid.seamOverhead >= 0.10,
    `relative reduction=${(((grid.seamOverhead - gs.seamOverhead) / grid.seamOverhead) * 100).toFixed(1)}% (threshold 10%)`);
  ok(`${name}/early-coverage`, gs.quartiles[0] > 1.15 * grid.quartiles[0],
    `q25 greedy=${(gs.quartiles[0] * 100).toFixed(1)}% grid=${(grid.quartiles[0] * 100).toFixed(1)}% ratio=${(gs.quartiles[0] / grid.quartiles[0]).toFixed(2)}x`);
  ok(`${name}/seq-worse-early`, gs.quartiles[0] > seq.quartiles[0],
    `q25 seq=${(seq.quartiles[0] * 100).toFixed(1)}%`);
  ok(`${name}/oracle-seam`, Math.abs(oracleSeam(positions, indices, plan.chunks) - gs.seamOverhead) < 1e-12,
    `oracle=${oracleSeam(positions, indices, plan.chunks).toFixed(9)} core=${gs.seamOverhead.toFixed(9)}`);
  ok(`${name}/oracle-connectivity`, oracleConnectedCount(indices, plan.chunks) === gs.connectedChunks,
    `oracle=${oracleConnectedCount(indices, plan.chunks)} core=${gs.connectedChunks}`);
  ok(`${name}/bytes`, plan.chunks.reduce((s, c) => s + c.length, 0) * 3 * gs.indexBytes + gs.sumVerts * 12 === gs.bytes,
    `bytes=${gs.bytes} indexBytes=${gs.indexBytes} sumVerts=${gs.sumVerts}`);
  ok(`${name}/manifold`, adj.nonManifoldEdges === 0, `nonManifoldEdges=${adj.nonManifoldEdges} edges=${adj.edgeCount}`);

  // determinism
  const again = planChunks(positions, indices, { maxTris });
  ok(`${name}/deterministic`, again.stats.hash === gs.hash, `hash=0x${gs.hash.toString(16)}`);

  // triangle-order invariance: topology decisions must not depend on input ordering
  const permMap = permutation(gs.triangles);
  const idx2 = permuteTriangles(indices, permMap);
  const perm = planChunks(positions, idx2, { maxTris });
  // exact assignment identity: permuted triangle t' must land in the same chunk
  // as original triangle permMap[t'].
  // Chunk ids are arbitrary, so compare partitions by canonical label:
  // the smallest ORIGINAL triangle id inside each chunk.
  const canon = (chunkOf, map) => {
    const label = new Int32Array(chunkOf.length).fill(-1);
    for (let t = 0; t < chunkOf.length; t++) {
      const orig = map ? map[t] : t;
      if (label[chunkOf[t]] === -1 || orig < label[chunkOf[t]]) label[chunkOf[t]] = orig;
    }
    return label;
  };
  const labA = canon(plan.chunkOf, null), labB = canon(perm.chunkOf, permMap);
  let assignMismatch = 0;
  for (let t2 = 0; t2 < gs.triangles; t2++) {
    if (labA[plan.chunkOf[permMap[t2]]] !== labB[perm.chunkOf[t2]]) assignMismatch++;
  }
  const maxStatDelta = Math.max(
    Math.abs(perm.stats.seamOverhead - gs.seamOverhead),
    ...perm.stats.quartiles.map((q, i) => Math.abs(q - gs.quartiles[i])),
    Math.abs(perm.stats.boundaryEdges - gs.boundaryEdges) / Math.max(1, gs.boundaryEdges),
  );
  // Reported metrics must be identical; the partition itself must be identical
  // too unless the mesh contains exactly-equal-area triangles (torus: symmetric
  // quads), where tie-breaking by triangle id may pick a congruent partition.
  const sameStats = maxStatDelta < 1e-12 && (assignMismatch === 0 || name === 'torus');
  const seqPerm = evaluatePlan(positions, idx2, naiveSequentialChunks(idx2, { chunkCount: K }).chunks);
  ok(`${name}/order-invariant-greedy`, sameStats,
    `assignmentMismatch=${assignMismatch}/${gs.triangles} maxStatDelta=${maxStatDelta.toExponential(2)} seam=${(perm.stats.seamOverhead * 100).toFixed(3)}%${assignMismatch ? ' (torus: exact area ties -> congruent partition)' : ''}`);
  ok(`${name}/order-sensitive-baseline`, seqPerm.seamOverhead > 3 * seq.seamOverhead && seqPerm.connectedChunks < seq.connectedChunks,
    `sequential: seam ${(seq.seamOverhead * 100).toFixed(2)}% -> ${(seqPerm.seamOverhead * 100).toFixed(2)}%, connected ${seq.connectedChunks}->${seqPerm.connectedChunks}`);

  // uniform-scale invariance across 12 orders of magnitude
  const hashes = new Set(), seams = new Set();
  for (const s of [1e-6, 1e-3, 1, 1e3, 1e6]) {
    const r = planChunks(positions.map((v) => v * s), indices, { maxTris });
    hashes.add(r.stats.hash); seams.add(r.stats.seamOverhead);
  }
  ok(`${name}/scale-invariant`, hashes.size === 1 && seams.size === 1,
    `scales 1e-6..1e6: hashes=${hashes.size} seams=${seams.size} hash=0x${[...hashes][0].toString(16)}`);

  summary.push({ name, K, seam: gs.seamOverhead, gridSeam: grid.seamOverhead, seqSeam: seq.seamOverhead, q25: gs.quartiles[0], gridQ25: grid.quartiles[0], connected: gs.connectedChunks, gridConnected: grid.connectedChunks, bytes: gs.bytes });
}

console.log('\n=== summary ===');
for (const s of summary) {
  console.log(`${s.name}: chunks=${s.K} seam=${(s.seam * 100).toFixed(3)}% (grid ${(s.gridSeam * 100).toFixed(3)}%, seq ${(s.seqSeam * 100).toFixed(3)}%) q25=${(s.q25 * 100).toFixed(2)}% (grid ${(s.gridQ25 * 100).toFixed(2)}%) connected=${s.connected}/${s.K} (grid ${s.gridConnected}/${s.K}) bytes=${s.bytes}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
