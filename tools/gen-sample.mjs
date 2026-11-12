// Deterministic sample generator: three structurally different meshes.
// Same command twice -> byte-identical output (verified with sha256 in README).
import { writeFileSync, mkdirSync } from 'node:fs';
import { planChunks, naiveGridChunks, naiveSequentialChunks, evaluatePlan } from '../src/core.mjs';

const round = (v) => Math.round(v * 1e6) / 1e6;

function torus(R = 1, r = 0.38, nu = 56, nv = 40) {
  const pos = [], idx = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = (i / nu) * Math.PI * 2, v = (j / nv) * Math.PI * 2;
      pos.push(round((R + r * Math.cos(v)) * Math.cos(u)), round((R + r * Math.cos(v)) * Math.sin(u)), round(r * Math.sin(v)));
    }
  }
  const at = (i, j) => (i % nu) * nv + (j % nv);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    idx.push(a, b, c, a, c, d);
  }
  return { name: 'torus', maxTris: 600, positions: pos, indices: idx };
}

function bumpySphere(nu = 40, nv = 26) {
  const pos = [], idx = [];
  for (let i = 0; i <= nv; i++) {
    const phi = (i / nv) * Math.PI;
    for (let j = 0; j < nu; j++) {
      const th = (j / nu) * Math.PI * 2;
      // deterministic low-frequency bumps: radius 1 +/- 0.16
      const rr = 1 + 0.16 * Math.sin(3 * th) * Math.sin(2 * phi);
      pos.push(round(rr * Math.sin(phi) * Math.cos(th)), round(rr * Math.cos(phi)), round(rr * Math.sin(phi) * Math.sin(th)));
    }
  }
  const at = (i, j) => i * nu + (j % nu);
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    idx.push(a, b, c, a, c, d);
  }
  return { name: 'bumpy-sphere', maxTris: 240, positions: pos, indices: idx };
}

function terrain(n = 48, size = 2) {
  const pos = [], idx = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const x = (i / n - 0.5) * size, z = (j / n - 0.5) * size;
    const y = 0.18 * Math.sin(2.1 * x) * Math.cos(1.7 * z) + 0.07 * Math.sin(5.3 * x + 1.1 * z);
    pos.push(round(x), round(y), round(z));
  }
  const at = (i, j) => i * (n + 1) + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    idx.push(a, b, c, a, c, d);
  }
  return { name: 'terrain', maxTris: 600, positions: pos, indices: idx };
}

const meshes = [torus(), bumpySphere(), terrain()];

const reference = [];
for (const m of meshes) {
  const greedy = planChunks(m.positions, m.indices, { maxTris: m.maxTris });
  const k = greedy.chunks.length;
  const grid = naiveGridChunks(m.positions, m.indices, { chunkCount: k, grid: 8 });
  const seq = naiveSequentialChunks(m.indices, { chunkCount: k });
  const gs = evaluatePlan(m.positions, m.indices, greedy.chunks);
  const bs = evaluatePlan(m.positions, m.indices, grid.chunks);
  const ss = evaluatePlan(m.positions, m.indices, seq.chunks);
  reference.push({
    name: m.name, maxTris: m.maxTris, chunkCount: k,
    greedy: { seamOverhead: gs.seamOverhead, quartiles: gs.quartiles, coverageAUC: gs.coverageAUC, allConnected: gs.allConnected, hash: gs.hash, bytes: gs.bytes, maxChunkTris: gs.maxChunkTris },
    grid: { seamOverhead: bs.seamOverhead, quartiles: bs.quartiles, coverageAUC: bs.coverageAUC, connectedChunks: bs.connectedChunks, hash: bs.hash, bytes: bs.bytes },
    sequential: { seamOverhead: ss.seamOverhead, quartiles: ss.quartiles, coverageAUC: ss.coverageAUC, connectedChunks: ss.connectedChunks },
  });
  console.log(`${m.name}: F=${gs.triangles} V=${gs.vertices} chunks=${k} seam greedy=${(gs.seamOverhead * 100).toFixed(2)}% grid=${(bs.seamOverhead * 100).toFixed(2)}% seq=${(ss.seamOverhead * 100).toFixed(2)}% | connected greedy=${gs.connectedChunks}/${k} grid=${bs.connectedChunks}/${k}`);
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const out = new URL('../data/', import.meta.url);
writeFileSync(new URL('mesh.json', out), JSON.stringify({ meshes }, null, 0));
writeFileSync(new URL('reference.json', out), JSON.stringify({ generatedBy: 'tools/gen-sample.mjs', reference }, null, 2));
console.log('wrote data/mesh.json and data/reference.json');
