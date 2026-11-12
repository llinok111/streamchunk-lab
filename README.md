# streamchunk-lab — topology-aware progressive mesh chunking

**Promise:** cutting a 4,480-triangle torus into 8 budgeted chunks, every chunk stays edge-connected (**8/8**, spatial-grid baseline **2/8**) while seam vertex overhead drops from **28.393% → 23.929%** (−15.7%) and the first 25% of chunks already cover **35.0%** of surface area (baseline 28.4%, **1.23×**). Verified by one command.

Upstream: none

```bash
node tools/gen-sample.mjs && node bench/verify.mjs && node bench/bench.mjs
```

Open the page with `python3 -m http.server 4173` and visit `http://localhost:4173` (three@0.169.0 via pinned CDN importmap).

## What it does

Streaming 3D loaders must split a mesh into byte-budgeted chunks. The common approach is spatial bucketing (sort triangles by centroid cell, cut every N). It is spatially local but shreds topology: neighbouring triangles land in different chunks, so each chunk re-sends vertices and every chunk is a cloud of disconnected patches. `planChunks` instead grows chunks over the half-edge graph, always adding the frontier triangle that shares the most edges with the chunk (interior growth, ties by area then id). Result: connected chunks by construction, fewer boundary edges, fewer duplicated vertices.

The plan is invariant under uniform scale (tested 1e-6 … 1e6, identical plan hash) and under triangle re-ordering — the index-order baseline is not (permuting triangle order takes its seam overhead from 14.29% to **387.14%** and its connected chunks from 8/8 to **0/8**).

## Evidence (real run, 2026-11-13)

| mesh | tris | chunks | seam greedy | seam grid | seam seq | q25 greedy | q25 grid | connected greedy | connected grid |
|---|---|---|---|---|---|---|---|---|---|
| torus | 4480 | 8 | **23.929%** | 28.393% | 14.286% | **35.00%** | 28.43% | **8/8** | 2/8 |
| bumpy-sphere | 2080 | 9 | **37.315%** | 49.352% | 31.481% | **51.43%** | 38.25% | **9/9** | 1/9 |
| terrain | 4608 | 12 | **20.908%** | 26.781% | 22.449% | **40.52%** | 24.58% | **12/12** | 2/12 |

`bench/verify.mjs`: **48 passed, 0 failed**. Independent oracles (Set-based seam, union-find connectivity) agree with core to 1e-12 / exactly. Byte accounting matches the formula `tris*3*indexBytes + verts*12`.

`bench/result.json` (torus, 1 cold + 7 warm samples, 20 plans per sample):

| planner | cold ms | median ms | p95 ms | RSD |
|---|---|---|---|---|
| greedy (this repo) | 15.389 | 11.696 | 12.450 | 2.52% |
| spatial grid baseline | 1.646 | 0.788 | 0.828 | 2.27% |
| index order baseline | 0.182 | 0.154 | 0.176 | 6.98% |

**The greedy planner is 14.8× slower than spatial bucketing** (11.7 ms for 4,480 triangles ≈ 2.6 µs/1k triangles). That cost is paid once at build/export time, not per frame; this repo does not claim a speed win.

## 本轮创新

Existing exporters either cut by index order or by spatial cell; neither can promise that a chunk is a connected surface patch. Here the chunk plan is grown on the half-edge graph with an explicit per-chunk connectivity invariant that is **re-checked by an independent union-find oracle**, and the same plan is proven invariant under 12 orders of magnitude of uniform scale and under arbitrary triangle re-ordering (both asserted, not assumed). The browser computes the identical plan with the identical `src/core.mjs` and diffs seam/coverage/plan-hash against `data/reference.json` baked by node.

## Known limitations

- `REL_AREA_TOL = 1e-9` is a **relative** tolerance used only to break floating-point area ties during ordering (never an absolute area/length threshold). Consequence: the plan is scale-invariant by construction, but on meshes with many exactly-equal-area triangles (the symmetric torus) re-ordering may select a congruent partition instead of the identical one — all reported metrics still agree to ≤1.2e-15, and the partition is bit-identical for the sphere and terrain.
- Connectivity is a *per-chunk* guarantee, not a manifold guarantee: a chunk may contain a handle or a boundary loop, and the whole mesh may be non-manifold (non-manifold edges are counted, not fixed).
- Budget is triangle count, not bytes; byte figures assume float32 positions + 16-bit indices (32-bit above 65,535 vertices) and omit normals/UVs.
- The planner is O(F · k) per chunk in the frontier scan; >200k triangles should use a priority queue.
- Grid baseline uses 8³ centroid cells and equal group sizes; a different cell count changes its numbers, so the comparison is scoped to that baseline implementation in `src/core.mjs`.

## Files

```
src/core.mjs          pure planning + evaluation (no three, no DOM, no I/O)
tools/gen-sample.mjs  deterministic meshes -> data/mesh.json + data/reference.json
bench/verify.mjs      48 assertions incl. two independent oracles
bench/bench.mjs       1 cold + 7 warm samples, 20 plans/sample -> bench/result.json
main.js, index.html   three.js viewer: chunk slider, planner toggle, live vs baked check
```
