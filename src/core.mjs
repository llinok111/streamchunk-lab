// streamchunk core — pure geometry/topology planning for progressive mesh delivery.
// No three.js, no DOM, no I/O, no environment access. Node-importable as-is.
//
// Everything here is combinatorial on triangle areas + shared edges, so there is
// deliberately NO absolute epsilon anywhere: decisions compare areas and counts
// of the same mesh, which makes every result invariant under uniform scaling.

const FNV_OFFSET = 2166136261;
// Relative area tolerance used only to break floating-point near-ties when
// ordering triangles. It is RELATIVE (|a-b| <= 1e-9 * max(a,b)), never absolute,
// so the plan is invariant under any uniform scale of the input mesh.
export const REL_AREA_TOL = 1e-9;
const FNV_PRIME = 16777619;

/** FNV-1a 32-bit over a sequence of integers (deterministic, endian-free). */
export function fnv1a(values) {
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < values.length; i++) {
    let v = values[i] >>> 0;
    for (let b = 0; b < 4; b++) {
      h ^= (v & 0xff);
      h = Math.imul(h, FNV_PRIME) >>> 0;
      v >>>= 8;
    }
  }
  return h >>> 0;
}

/** Per-triangle area (no epsilon, pure cross product / 2). */
export function triangleAreas(positions, indices) {
  const F = (indices.length / 3) | 0;
  const areas = new Float64Array(F);
  for (let t = 0; t < F; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const ax = positions[i1] - positions[i0], ay = positions[i1 + 1] - positions[i0 + 1], az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0], by = positions[i2 + 1] - positions[i0 + 1], bz = positions[i2 + 2] - positions[i0 + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    areas[t] = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return areas;
}

/**
 * Half-edge adjacency. nbr[h] = triangle sharing the edge opposite corner (h%3)
 * of half-edge h, or -1 if the edge is a boundary or non-manifold (>2 incident
 * triangles). edgeId[h] groups half-edges of the same undirected edge.
 */
export function buildAdjacency(indices) {
  const F = (indices.length / 3) | 0;
  const buckets = new Map();
  for (let t = 0; t < F; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e];
      const b = indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(t * 3 + e);
    }
  }
  const nbr = new Int32Array(F * 3).fill(-1);
  const edgeId = new Int32Array(F * 3).fill(-1);
  let nonManifoldEdges = 0;
  let eid = 0;
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i++) edgeId[arr[i]] = eid;
    if (arr.length === 2) {
      nbr[arr[0]] = (arr[1] / 3) | 0;
      nbr[arr[1]] = (arr[0] / 3) | 0;
    } else if (arr.length > 2) {
      nonManifoldEdges++;
    }
    eid++;
  }
  return { nbr, edgeId, F, edgeCount: eid, nonManifoldEdges };
}

/**
 * Seam-aware greedy chunking: grow each chunk from the largest unassigned
 * triangle, always taking the frontier triangle that shares the most edges with
 * the chunk (interior growth), tie-broken by area then triangle id. Ties never
 * depend on absolute area magnitude, only comparison, so chunking is identical
 * under any uniform scale.
 *
 * opts.maxTris  — hard triangle budget per chunk (required, >= 4)
 */
export function planChunks(positions, indices, opts = {}) {
  const maxTris = opts.maxTris | 0;
  if (maxTris < 4) throw new Error('maxTris must be >= 4');
  const { nbr, F } = buildAdjacency(indices);
  const areas = triangleAreas(positions, indices);

  // Seed order: largest area first, ties by index (scale-invariant).
  const order = new Int32Array(F);
  for (let t = 0; t < F; t++) order[t] = t;
  const cmp = (a, b) => {
    const la = areas[a], lb = areas[b];
    const m = Math.max(la, lb);
    if (Math.abs(la - lb) <= REL_AREA_TOL * m) return a - b;
    return lb - la;
  };
  order.sort(cmp);

  const chunkOf = new Int32Array(F).fill(-1);
  const chunks = [];
  const frontier = [];
  const sharedCache = new Int32Array(0);

  for (let oi = 0; oi < F; oi++) {
    const seed = order[oi];
    if (chunkOf[seed] !== -1) continue;
    const cid = chunks.length;
    const tris = [];
    chunkOf[seed] = cid;
    tris.push(seed);
    for (let e = 0; e < 3; e++) {
      const n = nbr[seed * 3 + e];
      if (n !== -1 && chunkOf[n] === -1) frontier.push(n);
    }
    while (tris.length < maxTris && frontier.length > 0) {
      // Pick best frontier triangle: most shared edges, then largest area, then lowest id.
      let best = 0, bestShared = -1, bestArea = -1, bestId = 0;
      for (let i = 0; i < frontier.length; i++) {
        const t = frontier[i];
        if (chunkOf[t] !== -1) continue;
        let shared = 0;
        for (let e = 0; e < 3; e++) {
          const n = nbr[t * 3 + e];
          if (n !== -1 && chunkOf[n] === cid) shared++;
        }
        const a = areas[t];
        const sameArea = shared === bestShared && Math.abs(a - bestArea) <= REL_AREA_TOL * Math.max(a, bestArea);
        if (shared > bestShared || sameArea && t < bestId || (shared === bestShared && !sameArea && a > bestArea)) {
          best = t; bestShared = shared; bestArea = a; bestId = t;
        }
      }
      if (bestShared < 0) break;
      // Remove chosen candidates that are already assigned, keep the rest.
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const t = frontier[i];
        if (t === best || chunkOf[t] !== -1) continue;
        next.push(t);
      }
      frontier.length = 0;
      for (let i = 0; i < next.length; i++) frontier.push(next[i]);
      chunkOf[best] = cid;
      tris.push(best);
      for (let e = 0; e < 3; e++) {
        const n = nbr[best * 3 + e];
        if (n !== -1 && chunkOf[n] === -1) frontier.push(n);
      }
    }
    frontier.length = 0;
    chunks.push(tris);
  }
  return { chunks, chunkOf, stats: evaluatePlan(positions, indices, chunks) };
}

/**
 * Baseline A: spatial grid order. Triangles are bucketed by centroid into a
 * grid^3 lattice, then cut into consecutive equal-size groups. This is what a
 * naive exporter does when it wants "spatially local" chunks: it never looks at
 * topology, so chunks are spatially tight but topologically shredded.
 */
export function naiveGridChunks(positions, indices, opts = {}) {
  const chunkCount = opts.chunkCount | 0;
  const grid = opts.grid || 8;
  const F = (indices.length / 3) | 0;
  if (chunkCount < 1) throw new Error('chunkCount must be >= 1');
  const cx = new Float64Array(F), cy = new Float64Array(F), cz = new Float64Array(F);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < F; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    cx[t] = (positions[a] + positions[b] + positions[c]) / 3;
    cy[t] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    cz[t] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    if (cx[t] < minX) minX = cx[t]; if (cx[t] > maxX) maxX = cx[t];
    if (cy[t] < minY) minY = cy[t]; if (cy[t] > maxY) maxY = cy[t];
    if (cz[t] < minZ) minZ = cz[t]; if (cz[t] > maxZ) maxZ = cz[t];
  }
  const span = [maxX - minX, maxY - minY, maxZ - minZ];
  const cell = (v, lo, d) => {
    if (!(d > 0)) return grid >> 1;            // flat axis: any fixed cell
    return Math.min(grid - 1, Math.max(0, Math.floor(((v - lo) / d) * grid)));
  };
  const keys = new Int32Array(F);
  for (let t = 0; t < F; t++) {
    const ix = cell(cx[t], minX, span[0]);
    const iy = cell(cy[t], minY, span[1]);
    const iz = cell(cz[t], minZ, span[2]);
    keys[t] = (ix * grid + iy) * grid + iz;
  }
  const order = new Int32Array(F);
  for (let t = 0; t < F; t++) order[t] = t;
  order.sort((a, b) => (keys[a] - keys[b]) || (a - b));
  return sliceEven(order, chunkCount);
}

/** Baseline B: plain index order (what a loader does with a single buffer). */
export function naiveSequentialChunks(indices, opts = {}) {
  const chunkCount = opts.chunkCount | 0;
  const F = (indices.length / 3) | 0;
  if (chunkCount < 1) throw new Error('chunkCount must be >= 1');
  const order = new Int32Array(F);
  for (let t = 0; t < F; t++) order[t] = t;
  return sliceEven(order, chunkCount);
}

function sliceEven(order, chunkCount) {
  const F = order.length;
  const chunks = [];
  const base = Math.floor(F / chunkCount);
  const extra = F % chunkCount;
  let p = 0;
  for (let k = 0; k < chunkCount; k++) {
    const n = base + (k < extra ? 1 : 0);
    chunks.push(Array.from(order.subarray(p, p + n)));
    p += n;
  }
  return { chunks };
}

/**
 * Number of edge-connected components of a triangle set. Independent BFS built
 * from the raw index buffer inside this function (does not reuse planChunks'
 * half-edge table), so a verifier can trust it as a separate implementation.
 */
export function chunkComponents(indices, tris) {
  const local = new Map();            // triangle id -> local slot
  const edgeMap = new Map();          // undirected edge -> [local slots]
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    local.set(t, i);
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      let arr = edgeMap.get(key);
      if (!arr) { arr = []; edgeMap.set(key, arr); }
      arr.push(i);
    }
  }
  const seen = new Uint8Array(tris.length);
  let comps = 0;
  for (let start = 0; start < tris.length; start++) {
    if (seen[start]) continue;
    comps++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const si = stack.pop();
      const t = tris[si];
      for (let e = 0; e < 3; e++) {
        const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        for (const u of edgeMap.get(key)) {
          if (!seen[u]) { seen[u] = 1; stack.push(u); }
        }
      }
    }
  }
  return comps;
}

/**
 * Recompute every reported number from a raw chunk list. Deliberately takes
 * only {positions, indices, chunks}: an external verifier can rebuild all
 * figures without touching planChunks' internals or any shared constant.
 */
export function evaluatePlan(positions, indices, chunks) {
  const F = (indices.length / 3) | 0;
  const V = (positions.length / 3) | 0;
  const areas = triangleAreas(positions, indices);
  let totalArea = 0;
  for (let t = 0; t < F; t++) totalArea += areas[t];

  const assigned = new Int32Array(F).fill(-1);
  let dupAssignments = 0;
  chunks.forEach((tris, cid) => {
    for (const t of tris) {
      if (assigned[t] !== -1) dupAssignments++;
      else assigned[t] = cid;
    }
  });
  let missing = 0;
  for (let t = 0; t < F; t++) if (assigned[t] === -1) missing++;

  const indexBytes = V > 65535 ? 4 : 2;
  let sumVerts = 0, sumTris = 0, bytes = 0, connectedChunks = 0, boundaryEdges = 0;
  const perChunk = [];
  let cumArea = 0;
  const coverage = [];
  const chunkArea = [];
  for (const tris of chunks) {
    const verts = new Set();
    const edgeCount = new Map();
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
        verts.add(a); verts.add(b);
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }
    let bEdges = 0;
    for (const c of edgeCount.values()) if (c === 1) bEdges++;
    const comps = chunkComponents(indices, tris);
    const b = tris.length * 3 * indexBytes + verts.size * 3 * 4;
    let a = 0;
    for (const t of tris) a += areas[t];
    chunkArea.push(a);
    perChunk.push({ tris: tris.length, verts: verts.size, bytes: b, components: comps, boundaryEdges: bEdges });
    sumVerts += verts.size; sumTris += tris.length; bytes += b;
    boundaryEdges += bEdges;
    if (comps === 1) connectedChunks++;
    cumArea += a;
    coverage.push(totalArea > 0 ? cumArea / totalArea : 0);
  }

  const quartiles = [0.25, 0.5, 0.75, 1].map((f) => {
    if (coverage.length === 0) return 0;
    const i = Math.min(coverage.length - 1, Math.ceil(coverage.length * f) - 1);
    return coverage[i];
  });
  const auc = quartiles.reduce((s, v) => s + v, 0) / quartiles.length;

  // Assignment hash over every triangle -> chunk id (order-independent of chunk list order).
  const hash = fnv1a(Array.from(assigned));

  return {
    triangles: F, vertices: V, chunkCount: chunks.length,
    totalArea, maxChunkTris: chunks.reduce((m, c) => Math.max(m, c.length), 0),
    sumVerts, sumTris, bytes, indexBytes, perChunk,
    seamOverhead: V > 0 ? sumVerts / V - 1 : 0,
    vertexDuplication: sumVerts > 0 ? 1 - V / sumVerts : 0,
    connectedChunks, allConnected: chunks.length > 0 && connectedChunks === chunks.length,
    boundaryEdges, coverage, quartiles, coverageAUC: auc,
    dupAssignments, missing, complete: dupAssignments === 0 && missing === 0,
    hash,
  };
}

/** Plan + evaluate in one call, returning the object the browser also uses. */
export function planAndEvaluate(positions, indices, opts = {}) {
  const plan = planChunks(positions, indices, opts);
  const stats = evaluatePlan(positions, indices, plan.chunks);
  return { chunks: plan.chunks, stats };
}
