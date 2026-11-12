// Timing harness: 1 cold run + 7 warm repetitions per planner, median reported.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import {
  planChunks, naiveGridChunks, naiveSequentialChunks, evaluatePlan,
} from '../src/core.mjs';

const data = JSON.parse(readFileSync(new URL('../data/mesh.json', import.meta.url)));
const mesh = data.meshes.find((m) => m.name === 'torus');
const { positions, indices, maxTris } = mesh;
const K = planChunks(positions, indices, { maxTris }).chunks.length;
const REPS = 7;
const BATCH = 20;   // iterations per timed sample: the single-plan workload (~ms) is
                    // too short for a 7-sample median to be stable, so each sample
                    // times BATCH plans and reports per-plan milliseconds.

const time = (fn) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < BATCH; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / BATCH;
};
const summarize = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return {
    n, min: +s[0].toFixed(4), median: +s[(n - 1) >> 1].toFixed(4),
    p95: +s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)].toFixed(4),
    max: +s[n - 1].toFixed(4), mean: +mean.toFixed(4), stddev: +sd.toFixed(4),
    rsd_pct: +(100 * sd / mean).toFixed(3), samples: s.map((v) => +v.toFixed(4)),
  };
};

const suites = {
  greedy: () => planChunks(positions, indices, { maxTris }),
  grid: () => naiveGridChunks(positions, indices, { chunkCount: K, grid: 8 }),
  sequential: () => naiveSequentialChunks(indices, { chunkCount: K }),
};

const out = { generatedAt: new Date().toISOString(), mesh: 'torus', triangles: indices.length / 3, vertices: positions.length / 3, chunks: K, budgetTris: maxTris, reps: REPS, batch: BATCH, env: { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length, model: cpus()[0]?.model?.trim() } };
for (const [name, fn] of Object.entries(suites)) {
  const cold = time(fn);                    // first touch: cold
  const warm = [];
  for (let i = 0; i < REPS; i++) warm.push(time(fn));
  out[name] = { cold_ms: +cold.toFixed(4), warm: summarize(warm) };
}

const gp = out.greedy.warm.median, bp = out.grid.warm.median;
out.verdict = {
  greedy_median_ms: gp, grid_median_ms: bp, median_speedup_vs_grid: +(bp / gp).toFixed(3),
  cold_greedy_ms: out.greedy.cold_ms, cold_grid_ms: out.grid.cold_ms,
  note: 'quality metrics (seam/coverage/connectivity) come from bench/verify.mjs, not timing',
};
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
