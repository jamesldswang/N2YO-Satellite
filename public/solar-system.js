// 太陽系示意模式：太陽在中心，八大行星加月亮，有自己的場景和鏡頭（和地球畫面共用 renderer、canvas）。
// - 方向是真的：行星用 planets.js（JPL 軌道根數）算日心黃道位置，月亮用 sun-moon.js 的地心黃道經緯度。
// - 距離是示意：畫的距離 = SCALE × √(真實 AU)，海王星（30 AU）和水星（0.39 AU）才放得進同一個畫面；
//   開根號只改距離、不改方向，所以軌道形狀會稍微變形，但行星在哪個方向、誰追過誰都是對的。
// - 大小是示意：行星放大很多倍，月亮離地球的距離也放大（真實比例下月亮貼在地球上看不出來）。
// 場景座標：黃道 x（春分點）→ +X，黃道北極 → +Y，黃道 y → −Z（從 +Y 往下看，行星逆時針公轉）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLANETS, planetPosition, planetOrbit } from './planets.js';
import { moonEcliptic } from './sun-moon.js';

const DEG = Math.PI / 180;
const SCALE = 10;           // 1 AU 畫在 10 單位
const SUN_R = 1.6;
const MOON_DIST = 1.1;      // 月亮離地球（示意）
const MOON_R = 0.055;
const ORBIT_POINTS = 256;
const MIN_PX = 9;           // 行星在畫面上至少幾像素（拉遠時放大，免得看不見）
const MOON_MIN_PX = 4.5;    // 月亮（行星的一半）
const ORBIT_EVERY_MS = 5 * 365.25 * 864e5; // 軌道根數變得很慢，模擬時間差 5 年才重算軌道線
const OBLIQUITY = 23.4393 * DEG;

const LOOK = {
  mercury: { r: 0.22, color: 0x9a948c },
  venus: { r: 0.34, color: 0xe8cf9a },
  earth: { r: 0.36, color: 0xffffff },
  mars: { r: 0.27, color: 0xc1502e },
  jupiter: { r: 0.95, color: 0xd8b48a },
  saturn: { r: 0.8, color: 0xe3cf98 },
  uranus: { r: 0.55, color: 0x9fd8e0 },
  neptune: { r: 0.53, color: 0x5577dd },
};

// 日心黃道（AU）→ 場景座標（距離開根號）
function toScene(v, out) {
  const r = Math.hypot(v.x, v.y, v.z);
  const k = r > 0 ? (SCALE * Math.sqrt(r)) / r : 0;
  return out.set(v.x * k, v.z * k, -v.y * k);
}
// 黃道經緯度（弧度）→ 場景座標的單位向量
const eclDir = (lon, lat, out) => out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,240,200,0.9)');
  grad.addColorStop(0.3, 'rgba(255,200,90,0.35)');
  grad.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function starField() {
  const n = 2500, pos = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.randomDirection().multiplyScalar(1500);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.7 }));
}

export class SolarSystem {
  // earthMap：地球畫面用的日間貼圖 uniform（{ value: Texture }），載入後共用，不重複佔 GPU 記憶體
  constructor(canvas, earthMap) {
    this.canvas = canvas;
    this.earthMap = earthMap;
    this.on = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 4000);
    this.camera.position.set(0, 48, 70);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN; // 按住滾輪拖曳 = 平移（和右鍵一樣）
    this.controls.minDistance = 2;
    this.controls.maxDistance = 260;
    this.controls.enabled = false;

    this.scene.add(starField());
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.12));
    this.scene.add(new THREE.PointLight(0xffffff, 2.6, 0, 0)); // 太陽在原點，不隨距離衰減

    const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 48, 24), new THREE.MeshBasicMaterial({ color: 0xffd76a }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(SUN_R * 6);
    this.scene.add(sun, glow);

    this.labelsEl = document.createElement('div');
    this.labelsEl.id = 'solar-labels';
    this.labelsEl.hidden = true;
    // 放在地球畫面標籤層的後面（同一層），才不會蓋到右邊的清單
    document.getElementById('labels').after(this.labelsEl);
    this.items = [{ name: '太陽', pos: new THREE.Vector3(), r: SUN_R, scale: 1, label: this.makeLabel('太陽', 'sun') }];

    this.planets = PLANETS.map((p) => {
      const look = LOOK[p.id];
      const mat = new THREE.MeshLambertMaterial({ color: look.color });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(look.r, 48, 24), mat);
      const holder = new THREE.Group(); // 位置
      holder.add(mesh);
      if (p.id === 'saturn') {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(look.r * 1.3, look.r * 2.2, 64),
          new THREE.MeshBasicMaterial({ color: 0xcdb88a, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }),
        );
        ring.rotation.x = -Math.PI / 2 + 26.7 * DEG; // 土星自轉軸傾斜約 27°
        holder.add(ring);
      }
      const orbit = new THREE.LineLoop(
        new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_POINTS * 3), 3)),
        new THREE.LineBasicMaterial({ color: p.id === 'earth' ? 0x6f9fe0 : 0x8a96a8, transparent: true, opacity: 0.4 }),
      );
      this.scene.add(holder, orbit);
      const item = { p, mesh, holder, orbit, pos: holder.position, r: look.r, scale: 1, label: this.makeLabel(p.name, p.id === 'earth' ? 'earth' : '') };
      this.items.push(item);
      return item;
    });
    this.earth = this.planets.find((x) => x.p.id === 'earth');

    this.moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_R, 32, 16), new THREE.MeshLambertMaterial({ color: 0xc8c8c8 }));
    this.moonOrbit = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => {
        const a = (i / 96) * 2 * Math.PI;
        return new THREE.Vector3(Math.cos(a) * MOON_DIST, 0, Math.sin(a) * MOON_DIST);
      })),
      new THREE.LineBasicMaterial({ color: 0x9fb4d0, transparent: true, opacity: 0.45 }),
    );
    this.scene.add(this.moon, this.moonOrbit);
    this.moonItem = { pos: this.moon.position, r: MOON_R, scale: 1, label: this.makeLabel('月亮', 'moon') };
    this.items.push(this.moonItem);

    this.orbitAt = -Infinity;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  makeLabel(text, kind) {
    const el = document.createElement('div');
    el.className = `label solar-label ${kind}`;
    el.textContent = text;
    this.labelsEl.append(el);
    return el;
  }

  setOn(on) {
    this.on = on;
    this.controls.enabled = on;
    this.labelsEl.hidden = !on;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // 每幀呼叫（只在示意模式）
  update(ms) {
    if (Math.abs(ms - this.orbitAt) > ORBIT_EVERY_MS) {
      for (const it of this.planets) {
        const attr = it.orbit.geometry.attributes.position;
        planetOrbit(it.p, ms, ORBIT_POINTS).forEach((v, i) => {
          toScene(v, this._v);
          attr.setXYZ(i, this._v.x, this._v.y, this._v.z);
        });
        attr.needsUpdate = true;
      }
      this.orbitAt = ms;
    }
    const pxScale = (2 * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, this.canvas.clientHeight);
    const minScale = (it, px = MIN_PX) => Math.max(1, (px * this.camera.position.distanceTo(it.pos) * pxScale) / (2 * it.r));
    for (const it of this.planets) {
      toScene(planetPosition(it.p, ms), it.holder.position);
      it.scale = minScale(it);
      it.holder.scale.setScalar(it.scale);
    }

    // 地球：共用地球畫面的貼圖，自轉軸傾斜 23.4°，依 GMST 轉到正確的經度朝太陽（看得出哪一面是白天）
    const em = this.earth.mesh.material;
    if (this.earthMap.value && em.map !== this.earthMap.value) { em.map = this.earthMap.value; em.needsUpdate = true; }
    this.orientEarth(ms);

    const m = moonEcliptic(ms);
    eclDir(m.lon, m.lat, this._v);
    // 地球放大時月亮的距離跟著放大，月亮才不會跑進地球裡
    const k = this.earth.scale;
    this.moon.position.copy(this.earth.holder.position).addScaledVector(this._v, MOON_DIST * k);
    this.moonOrbit.position.copy(this.earth.holder.position);
    this.moonOrbit.scale.setScalar(k);
    this.moonItem.scale = minScale(this.moonItem, MOON_MIN_PX);
    this.moon.scale.setScalar(this.moonItem.scale);

    this.controls.update();
    this.placeLabels();
  }

  orientEarth(ms) {
    const d = ms / 864e5 + 2440587.5 - 2451545;
    const g = (280.46061837 + 360.98564736629 * d) * DEG;
    const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
    // 赤道座標軸在場景裡的方向
    const eqX = new THREE.Vector3(1, 0, 0), eqY = new THREE.Vector3(0, -se, -ce), eqZ = new THREE.Vector3(0, ce, -se);
    const lon0 = eqX.clone().multiplyScalar(Math.cos(g)).addScaledVector(eqY, Math.sin(g));   // 經度 0°
    const lon90 = eqX.clone().multiplyScalar(-Math.sin(g)).addScaledVector(eqY, Math.cos(g)); // 東經 90°
    // 地球貼圖的球：+X = 0°E、+Y = 北、−Z = 90°E（和地球畫面一樣）
    this.earth.mesh.quaternion.setFromRotationMatrix(this._m.makeBasis(lon0, eqZ, lon90.negate()));
  }

  placeLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const pxScale = (2 * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, h);
    for (const it of this.items) {
      const v = this._v.copy(it.pos).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      it.label.style.display = visible ? '' : 'none';
      if (!visible) continue;
      // 標籤放在球的右上方，離球的邊緣幾個像素
      const rPx = (it.r * it.scale) / (this.camera.position.distanceTo(it.pos) * pxScale);
      const x = ((v.x + 1) / 2) * w + rPx * 0.7 + 4;
      const y = ((1 - v.y) / 2) * h - rPx * 0.7 - 4;
      it.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
