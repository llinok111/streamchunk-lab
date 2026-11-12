// Renderer + interaction only. All planning/measurement comes from src/core.mjs,
// which is the exact module bench/verify.mjs asserts on.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { planChunks, naiveGridChunks, naiveSequentialChunks, evaluatePlan } from './src/core.mjs';

const [$mesh, $mode, $slider, $k, $stats, $hash, $view] = ['mesh', 'mode', 'slider', 'k', 'stats', 'hashcheck', 'view'].map((id) => document.getElementById(id));
const meshData = await (await fetch('./data/mesh.json')).json();
const reference = await (await fetch('./data/reference.json')).json();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(2.6, 1.9, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a2230, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(3, 5, 2);
scene.add(key);

for (const m of meshData.meshes) {
  const o = document.createElement('option');
  o.value = m.name; o.textContent = m.name;
  $mesh.appendChild(o);
}

let groups = [];
let state = null;

function disposeGroups() {
  for (const g of groups) {
    scene.remove(g);
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  groups = [];
}

function planFor(mesh, mode) {
  const K = reference.reference.find((r) => r.name === mesh.name).chunkCount;
  if (mode === 'greedy') return planChunks(mesh.positions, mesh.indices, { maxTris: mesh.maxTris });
  if (mode === 'grid') return naiveGridChunks(mesh.positions, mesh.indices, { chunkCount: K, grid: 8 });
  return naiveSequentialChunks(mesh.indices, { chunkCount: K });
}

function build(mesh, mode) {
  disposeGroups();
  const plan = planFor(mesh, mode);
  state = { mesh, mode, plan, stats: evaluatePlan(mesh.positions, mesh.indices, plan.chunks) };
  const pos = mesh.positions, idx = mesh.indices;
  const total = plan.chunks.length;
  $slider.max = String(total);
  $slider.value = String(total);
  const palette = new THREE.Color();
  const bbox = new THREE.Box3();
  plan.chunks.forEach((tris, ci) => {
    const posArr = new Float32Array(tris.length * 9);
    const colArr = new Float32Array(tris.length * 9);
    palette.setHSL((ci / Math.max(1, total)) * 0.8, 0.65, 0.55);
    let p = 0;
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const v = idx[t * 3 + e] * 3;
        posArr[p] = pos[v]; posArr[p + 1] = pos[v + 1]; posArr[p + 2] = pos[v + 2];
        colArr[p] = palette.r; colArr[p + 1] = palette.g; colArr[p + 2] = palette.b;
        p += 3;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    bbox.union(geom.boundingBox);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geom, mat));
    scene.add(g);
    groups.push(g);
  });
  const c = bbox.getCenter(new THREE.Vector3()), size = bbox.getSize(new THREE.Vector3()).length();
  camera.position.set(c.x + size * 0.7, c.y + size * 0.5, c.z + size * 0.7);
  controls.target.copy(c);
  controls.update();
  render();
}

function render() {
  const visible = Number($slider.value);
  groups.forEach((g, i) => (g.visible = i < visible));
  $k.textContent = `${visible} / ${groups.length}`;
  if (!state) return;
  const s = state.stats;
  const ref = reference.reference.find((r) => r.name === state.mesh.name);
  const baked = state.mode === 'greedy' ? ref.greedy : state.mode === 'grid' ? ref.grid : ref.sequential;
  const q25 = s.quartiles[0];
  const rows = [
    ['triangles', s.triangles], ['chunks', s.chunkCount],
    ['seam vertex overhead', `${(s.seamOverhead * 100).toFixed(3)}%`],
    ['prefix surface @25% chunks', `${(q25 * 100).toFixed(2)}%`],
    ['connected chunks', `${s.connectedChunks}/${s.chunkCount}`],
    ['boundary edges', s.boundaryEdges],
    ['payload bytes', s.bytes],
  ];
  $stats.innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  const sameSeam = Math.abs(baked.seamOverhead - s.seamOverhead) < 1e-12;
  const sameQ = Math.abs(baked.quartiles[0] - q25) < 1e-12;
  const sameHash = baked.hash === undefined || baked.hash === s.hash;
  $hash.innerHTML = `node-baked check: seam ${sameSeam ? '<span class="ok">match</span>' : '<span class="bad">MISMATCH</span>'} · q25 ${sameQ ? '<span class="ok">match</span>' : '<span class="bad">MISMATCH</span>'} · plan hash ${sameHash ? '<span class="ok">match</span> 0x' + s.hash.toString(16) + '</span>' : '<span class="bad">MISMATCH</span>'}`;
}

function resize() {
  const w = $view.clientWidth, h = $view.clientHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function boot() {
  resize();
  build(meshData.meshes.find((m) => m.name === $mesh.value), $mode.value);
}
$mesh.addEventListener('change', boot);
$mode.addEventListener('change', boot);
$slider.addEventListener('input', render);
addEventListener('resize', () => { resize(); renderer.render(scene, camera); });

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  controls.update();
  renderer.render(scene, camera);
  if (now - last > 1000) last = now;
});
boot();
