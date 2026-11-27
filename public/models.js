// 衛星的簡化 3D 模型，用 Three.js 基本幾何體組成，不需要外部模型檔。
// 模型座標：+X = 軌道的側向（右）、+Y = 遠離地球（天頂）、+Z = 前進方向。
// 每個模型會縮放到最長邊 = 1，實際畫面大小由 app.js 依距離調整。
import * as THREE from 'three';

// 金屬外皮：金屬度高、加上程式產生的紋理（皺摺金箔、拉絲金屬、太陽能電池格）。
// 金屬的顏色主要來自反射環境，所以 app.js 要設定 scene.environment，不然金屬會是黑的。
const MATERIALS = {
  gold:   { color: 0xd4a73a, metalness: 1.0, roughness: 0.32, tex: 'foil', bumpScale: 0.7 },     // 隔熱金箔（MLI）
  white:  { color: 0xdfe3e8, metalness: 0.7, roughness: 0.32, tex: 'brushed', bumpScale: 0.4 }, // 鋁合金艙段、散熱板
  silver: { color: 0xd0d6de, metalness: 1.0, roughness: 0.22, tex: 'foil', bumpScale: 0.6 },    // 哈伯的銀色隔熱層
  panel:  { color: 0x6f86c8, metalness: 0.35, roughness: 0.4, envMapIntensity: 0.35, tex: 'cells', emissive: 0x0a1630 }, // 太陽能板
  dark:   { color: 0x5a5f66, metalness: 0.9, roughness: 0.4, tex: 'brushed', bumpScale: 0.4 },  // 桁架、支架
};
const TEX_PER_UNIT = 10; // 長方體每單位長度重複幾次紋理（模型最長邊約 1）

let textures = null;
function canvasTexture(size, draw, srgb) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function getTextures() {
  if (textures) return textures;
  textures = {
    // 皺摺的金屬箔：隨機的亮暗多邊形當凹凸貼圖
    foil: { bumpMap: canvasTexture(256, (g, n) => {
      g.fillStyle = '#808080'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 260; i++) {
        const v = 105 + Math.floor(Math.random() * 50);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.beginPath();
        const x = Math.random() * n, y = Math.random() * n, r = 8 + Math.random() * 26;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + Math.random();
          g.lineTo(x + Math.cos(a) * r * (0.5 + Math.random()), y + Math.sin(a) * r * (0.5 + Math.random()));
        }
        g.fill();
      }
    }) },
    // 拉絲金屬：橫向細紋
    brushed: { bumpMap: canvasTexture(256, (g, n) => {
      for (let y = 0; y < n; y++) {
        const v = 110 + Math.floor(Math.random() * 40);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(0, y, n, 1);
      }
    }) },
    // 太陽能電池：深藍色的格子，格線是銀色的
    cells: { map: canvasTexture(128, (g, n) => {
      g.fillStyle = '#c8ccd2'; g.fillRect(0, 0, n, n);
      const k = n / 4;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const v = Math.floor(Math.random() * 14);
        g.fillStyle = `rgb(${14 + v},${32 + v},${92 + v})`;
        g.fillRect(i * k + 2, j * k + 2, k - 4, k - 4);
      }
    }, true) },
  };
  return textures;
}

// 每個模型有自己的材質，才能個別調暗（進入地球陰影時）；紋理共用。
function materialSet() {
  const set = {};
  const tex = getTextures();
  for (const [k, { tex: name, ...v }] of Object.entries(MATERIALS)) {
    set[k] = new THREE.MeshStandardMaterial({ ...v, ...tex[name] });
  }
  return set;
}

// BoxGeometry 每一面的 uv 都是 0–1，長條的太陽能板紋理會被拉長；改成依邊長重複。
// 面的順序：+x、−x（d × h）、+y、−y（w × d）、+z、−z（w × h），每面 4 個頂點。
function scaleBoxUv(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const sizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = sizes[f];
    for (let i = f * 4; i < f * 4 + 4; i++) {
      uv.setXY(i, uv.getX(i) * Math.max(su * TEX_PER_UNIT, 1), uv.getY(i) * Math.max(sv * TEX_PER_UNIT, 1));
    }
  }
}

function box(g, m, w, h, d, x = 0, y = 0, z = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  scaleBoxUv(geo, w, h, d);
  const mesh = new THREE.Mesh(geo, m);
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

// 星鏈 V2 Mini：扁平的本體（約 2.7 × 4.1 m，朝地球那面是相位陣列天線），
// 左右各一片長條太陽能板，翼展約 30 m。
function starlink(g, m) {
  box(g, m.dark, 0.09, 0.02, 0.14);
  box(g, m.white, 0.084, 0.004, 0.13, 0, -0.012, 0);
  for (const s of [-1, 1]) {
    box(g, m.silver, 0.04, 0.006, 0.006, s * 0.065, 0, 0); // 支架
    box(g, m.panel, 0.4, 0.003, 0.14, s * 0.29, 0, 0);
  }
}

// ---------- 繞月衛星（月球視角，lunar.js）：+Y = 遠離月球、−Y = 朝月面的儀器 ----------

// 拋物面天線：淺碟（朝 +Y 或 −Y）加一根桿子
function dish(g, m, r, x, y, z, up = 1) {
  const d = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, 0.6), m);
  d.scale.y = 0.6 * up;
  d.position.set(x, y, z);
  g.add(d);
  return d;
}

// LRO：直立的長方體本體，側邊一根桿子撐著一大片太陽能板，另一側桿子末端是高增益碟形天線，
// 底面朝月球的是相機（LROC）和雷射測高儀（LOLA）
function lro(g, m) {
  box(g, m.gold, 0.26, 0.38, 0.26);
  box(g, m.dark, 0.2, 0.012, 0.012, -0.23, 0.08, 0);
  box(g, m.panel, 0.42, 0.004, 0.34, -0.55, 0.08, 0);
  box(g, m.dark, 0.22, 0.012, 0.012, 0.24, 0.12, 0);
  dish(g, m.white, 0.09, 0.36, 0.14, 0);
  cyl(g, m.silver, 0.05, 0.12, 'y', 0.05, -0.24, 0.05);
  cyl(g, m.dark, 0.035, 0.08, 'y', -0.07, -0.22, -0.06);
}

// Danuri（KPLO）：方形本體，左右兩片太陽能板，頂上碟形天線，底面朝月球的 ShadowCam
function danuri(g, m) {
  box(g, m.gold, 0.26, 0.24, 0.24);
  for (const sx of [-1, 1]) {
    box(g, m.dark, 0.08, 0.01, 0.01, sx * 0.17, 0, 0);
    box(g, m.panel, 0.34, 0.004, 0.22, sx * 0.38, 0, 0);
  }
  box(g, m.dark, 0.012, 0.12, 0.012, 0, 0.18, -0.06);
  dish(g, m.white, 0.08, 0, 0.24, -0.06);
  cyl(g, m.silver, 0.06, 0.1, 'y', 0, -0.17, 0.03);
}

// 月船 2 號軌道器：金箔方塊本體，單側一片大太陽能板，頂上碟形天線，底面相機
function chandrayaan2(g, m) {
  box(g, m.gold, 0.32, 0.3, 0.3);
  box(g, m.dark, 0.1, 0.012, 0.012, -0.21, 0.04, 0);
  box(g, m.panel, 0.4, 0.004, 0.3, -0.46, 0.04, 0);
  box(g, m.dark, 0.012, 0.1, 0.012, 0.06, 0.2, 0.06);
  dish(g, m.white, 0.1, 0.06, 0.25, 0.06);
  cyl(g, m.silver, 0.045, 0.08, 'y', -0.06, -0.19, -0.06);
  cyl(g, m.silver, 0.03, 0.06, 'y', 0.08, -0.18, 0.08);
}

// ARTEMIS（原 THEMIS）：會自旋的八角柱，側面貼太陽能電池；四根細長的電場線狀天線往外伸，
// 上下各一根軸向天線，兩根磁力計桿
function artemis(g, m) {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.11, 8), m.panel);
  g.add(body);
  for (const y of [-0.06, 0.06]) {
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.01, 8), m.gold);
    lid.position.y = y;
    g.add(lid);
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 8;
    const wire = box(g, m.white, 0.36, 0.003, 0.003, Math.cos(a) * 0.31, 0, Math.sin(a) * 0.31);
    wire.rotation.y = -a;
  }
  box(g, m.white, 0.004, 0.5, 0.004);
  for (const a of [Math.PI * 0.5, Math.PI * 1.25]) {
    const b = box(g, m.dark, 0.2, 0.008, 0.008, Math.cos(a) * 0.22, 0.03, Math.sin(a) * 0.22);
    b.rotation.y = -a;
  }
}

const BUILDERS = { iss, tiangong, hubble, generic, geo, starlink, lro, danuri, chandrayaan2, artemis };
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
