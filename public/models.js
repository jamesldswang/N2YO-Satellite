// 衛星的簡化 3D 模型，用 Three.js 基本幾何體組成，不需要外部模型檔。
// 模型座標：+X = 軌道的側向（右）、+Y = 遠離地球（天頂）、+Z = 前進方向。
// 每個模型會縮放到最長邊 = 1，實際畫面大小由 app.js 依距離調整。
import * as THREE from 'three';

const MATERIALS = {
  gold:   { color: 0xc9a227, metalness: 0.3, roughness: 0.45 },               // 隔熱金箔
  white:  { color: 0xe6e8ea, metalness: 0.1, roughness: 0.6 },                // 艙段、散熱板
  silver: { color: 0xc3c9d1, metalness: 0.35, roughness: 0.35 },              // 哈伯外殼
  panel:  { color: 0x2c55a8, metalness: 0.3, roughness: 0.35, emissive: 0x0c1a3d }, // 太陽能板
  dark:   { color: 0x3a3d42, metalness: 0.2, roughness: 0.6 },
};

// 每個模型有自己的材質，才能個別調暗（進入地球陰影時）。
function materialSet() {
  const set = {};
  for (const [k, v] of Object.entries(MATERIALS)) set[k] = new THREE.MeshStandardMaterial(v);
  return set;
}

function box(g, m, w, h, d, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}
// axis：圓柱的長軸方向 'x' | 'y' | 'z'
function cyl(g, m, r, len, axis, x = 0, y = 0, z = 0, r2 = r) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r2, len, 20), m);
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}

// 國際太空站：橫向的長桁架，兩端各兩組成對的大型太陽能板，中間是前後串接的艙段。
function iss(g, m) {
  box(g, m.dark, 1.0, 0.025, 0.025);
  for (const x of [-0.45, -0.33, 0.33, 0.45]) {
    for (const z of [-0.2, 0.2]) box(g, m.panel, 0.09, 0.004, 0.34, x, 0, z);
    box(g, m.dark, 0.012, 0.012, 0.06, x, 0, 0); // 旋轉接頭
  }
  for (const x of [-0.17, 0.17]) box(g, m.white, 0.07, 0.004, 0.16, x, -0.03, 0); // 散熱板
  cyl(g, m.white, 0.032, 0.5, 'z', 0, -0.05, 0.02);
  cyl(g, m.white, 0.03, 0.2, 'x', 0, -0.05, 0.2);   // 前端的哥倫布號、希望號
  cyl(g, m.white, 0.026, 0.14, 'y', 0, -0.1, -0.12); // 下方的俄羅斯艙段
}

// 天宮（中國太空站）：T 字形，核心艙前後向，兩個實驗艙左右展開，末端各有一對大型太陽能板。
function tiangong(g, m) {
  cyl(g, m.white, 0.05, 0.42, 'z', 0, 0, -0.05);
  const node = new THREE.Mesh(new THREE.SphereGeometry(0.058, 20, 14), m.white);
  node.position.set(0, 0, 0.18);
  g.add(node);
  for (const s of [-1, 1]) {
    cyl(g, m.white, 0.048, 0.36, 'x', s * 0.23, 0, 0.18);
    for (const z of [0.18 - 0.23, 0.18 + 0.23]) box(g, m.panel, 0.1, 0.004, 0.38, s * 0.44, 0, z);
    box(g, m.dark, 0.06, 0.01, 0.012, s * 0.42, 0, 0.18);
    box(g, m.panel, 0.12, 0.004, 0.07, s * 0.1, 0, -0.2); // 核心艙的小太陽能板
  }
}

// 哈伯太空望遠鏡：銀色圓筒，前端有鏡蓋，兩側各一片長條太陽能板。
function hubble(g, m) {
  cyl(g, m.silver, 0.09, 0.5, 'z', 0, 0, 0.05);
  cyl(g, m.silver, 0.1, 0.18, 'z', 0, 0, -0.29);
  const door = box(g, m.dark, 0.17, 0.005, 0.17, 0, 0.09, 0.38);
  door.rotation.x = -0.6;
  for (const s of [-1, 1]) {
    box(g, m.panel, 0.11, 0.004, 0.5, s * 0.2, 0, -0.05);
    box(g, m.dark, 0.06, 0.008, 0.008, s * 0.12, 0, -0.05);
  }
  cyl(g, m.white, 0.004, 0.18, 'y', 0, 0.12, -0.2); // 高增益天線桿
}

// 一般低軌衛星（例如福衛五號、NOAA 20）：金箔包覆的本體、單側一大片太陽能板、朝地球的天線。
function generic(g, m) {
  box(g, m.gold, 0.22, 0.2, 0.3);
  box(g, m.dark, 0.18, 0.008, 0.008, 0.2, 0, 0);
  box(g, m.panel, 0.5, 0.004, 0.28, 0.54, 0, 0);
  cyl(g, m.white, 0.03, 0.08, 'y', 0, -0.14, 0.06);
  cyl(g, m.white, 0.008, 0.12, 'y', -0.06, 0.16, -0.08);
}

// 地球同步衛星（例如向日葵 9 號）：方形本體、南北兩側展開的太陽能板、朝地球的碟形天線。
function geo(g, m) {
  box(g, m.gold, 0.24, 0.24, 0.24);
  for (const s of [-1, 1]) {
    box(g, m.dark, 0.1, 0.008, 0.008, s * 0.17, 0, 0);
    for (const x of [0.31, 0.5, 0.69]) box(g, m.panel, 0.18, 0.004, 0.22, s * x, 0, 0);
  }
  cyl(g, m.white, 0.13, 0.04, 'y', 0, -0.16, 0.04, 0.03);
  cyl(g, m.white, 0.06, 0.03, 'y', 0.07, 0.14, 0);
}

const BUILDERS = { iss, tiangong, hubble, generic, geo };
const KNOWN = { 25544: 'iss', 48274: 'tiangong', 20580: 'hubble' };

// 依 NORAD 編號選模型；不認得的依軌道週期分成同步衛星或一般衛星。
export function modelKind(id, satrec) {
  if (KNOWN[id]) return KNOWN[id];
  if (satrec && (2 * Math.PI) / satrec.no > 600) return 'geo'; // 週期超過 10 小時
  return 'generic';
}

export function makeSatModel(kind) {
  const g = new THREE.Group();
  const mats = materialSet();
  (BUILDERS[kind] || generic)(g, mats);
  // 縮放到最長邊 = 1、中心在原點。
  const bb = new THREE.Box3().setFromObject(g);
  const size = bb.getSize(new THREE.Vector3());
  const center = bb.getCenter(new THREE.Vector3());
  const k = 1 / Math.max(size.x, size.y, size.z);
  for (const c of g.children) {
    c.position.sub(center).multiplyScalar(k);
    c.scale.multiplyScalar(k);
  }
  g.userData.kind = kind;
  g.userData.mats = Object.values(mats).map((mat) => ({
    mat, color: mat.color.clone(), emissive: mat.emissive.clone(),
  }));
  g.userData.lit = true;
  return g;
}

// 進入地球陰影時調暗（場景沒有投影，所以要自己處理）。
export function setModelLit(g, lit) {
  if (g.userData.lit === lit) return;
  g.userData.lit = lit;
  const f = lit ? 1 : 0.3; // dim but still a visible silhouette
  for (const { mat, color, emissive } of g.userData.mats) {
    mat.color.copy(color).multiplyScalar(f);
    mat.emissive.copy(emissive).multiplyScalar(f);
  }
}

export function disposeModel(g) {
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  for (const { mat } of g.userData.mats) mat.dispose();
}
