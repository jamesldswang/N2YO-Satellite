// 月球視角：月球在中心，繞月衛星、地球、太陽都在真實位置（真實距離、真實大小）。
// 有自己的場景和鏡頭（和地球畫面共用 renderer、canvas），做法同 solar-system.js。
// - 位置：server.js 的 /api/lunar/<UTC 日期>（NASA JPL Horizons 月心星曆，J2000 黃道，每 10 分鐘一筆含速度，一次 4 天），
//   lunar-math.js 的 stateAt() 用 Hermite 內插。
// - 月球的方向：IAU 2009 月球自轉模型（lunar-math.js 的 moonAxes()，和 Horizons 的天平動差 0.01° 以內）。
// - 軌道線：用現在的位置速度算克卜勒橢圓（只考慮月球重力，畫一圈的形狀；實際軌道會被地球、太陽慢慢拉歪）。
// 場景座標：1 = 月球半徑（1737.4 km）；黃道 x → +X、黃道北極 → +Y、黃道 y → −Z（同 solar-system.js）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { moonAxes, stateAt, keplerOrbit, MOON_KM } from './lunar-math.js';

const DEG = Math.PI / 180;
const EARTH_R = 6371 / MOON_KM;
const ORBIT_POINTS = 256;
const SAT_PX = 9;           // 衛星點的大小（像素）
const EARTH_MIN_PX = 6;     // 地球太小時至少畫幾像素
const SUN_PX = 90;
const MAX_DAYS = 4;         // 最多留幾天的星曆
const OBLIQUITY = 84381.448 / 3600 * DEG;
const COLORS = { '-85': 0xffb347, '-155': 0x6ee7a8, '-152': 0xff8fb1, '-192': 0x8fc0ff, '-193': 0xc6a0ff };
// 追蹤清單滑鼠停留時的簡介（格式同 sat-info.js 的 satInfo()）
export const LUNAR_INFO = {
  '-85': { title: 'LRO 月球勘測軌道器', kind: 'NASA・月球測繪', norad: 35315,
    text: 'NASA 在 2009 年發射，用高解析度相機拍遍整個月面、量地形和溫度，阿波羅登陸點留下的足跡和儀器就是它拍到的。繞月球南北極的低軌道，約 2 小時一圈。', facts: ['2009 年發射', '繞極軌道'] },
  '-155': { title: 'Danuri 韓國探月衛星（KPLO）', kind: '韓國 KARI・月球探測', norad: 53365,
    text: '南韓第一個月球探測器，2022 年發射、年底進入月球軌道。帶著 NASA 的 ShadowCam，專門拍月球兩極永遠照不到太陽的隕石坑底部，找可能藏著的水冰。', facts: ['2022 年發射', '繞極軌道'] },
  '-152': { title: 'Chandrayaan-2 月船 2 號軌道器', kind: '印度 ISRO・月球探測', norad: 44441,
    text: '印度 2019 年發射的月球軌道器（同行的維克拉姆登陸器著陸失敗，軌道器一直正常運作），繪製月面地圖、分析表面成分，也幫 2023 年月船 3 號的登陸轉傳訊號。', facts: ['2019 年發射', '繞極軌道'] },
  '-192': { title: 'ARTEMIS P1（原 THEMIS-B）', kind: 'NASA・太空物理', norad: 30581,
    text: '原本是 2007 年發射、研究極光的 THEMIS 衛星之一，2011 年改道送到月球軌道，量測太陽風和月球的交互作用。名字和 NASA 的阿提米絲登月計畫無關。很扁的橢圓軌道，約一天一圈。', facts: ['2007 年發射', '2011 年起繞月'] },
  '-193': { title: 'ARTEMIS P2（原 THEMIS-C）', kind: 'NASA・太空物理', norad: 30582,
    text: '和 P1 一起從 THEMIS 改道到月球的雙胞胎，兩顆在不同位置同時量測，分得出太陽風在月球附近怎麼變化。很扁的橢圓軌道，約一天一圈。', facts: ['2007 年發射', '2011 年起繞月'] },
};

const toScene = (v, out) => out.set(v[0] / MOON_KM, v[2] / MOON_KM, -v[1] / MOON_KM);
const dirScene = (v, out) => out.set(v[0], v[2], -v[1]);
// 星曆一段 BLOCK_DAYS 天（和 server.js 的 LUNAR_BLOCK_DAYS 一樣，從 1970-01-01 起對齊）；回傳段落第一天的毫秒
const BLOCK_DAYS = 4, BLOCK_MS = BLOCK_DAYS * 864e5;
const blockOf = (ms) => Math.floor(ms / BLOCK_MS) * BLOCK_MS;
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(32, 32, 26, 0, 2 * Math.PI); g.fill();
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.stroke();
  return new THREE.CanvasTexture(c);
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,250,230,1)');
  grad.addColorStop(0.12, 'rgba(255,235,170,0.95)');
  grad.addColorStop(0.35, 'rgba(255,200,90,0.3)');
  grad.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function starField() {
  const n = 2500, pos = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.randomDirection(); pos.set([v.x, v.y, v.z], i * 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false }));
}

export class LunarView {
  // earthMap：地球畫面的日間貼圖 uniform（共用）；texBase：月球貼圖所在的資料夾
  constructor(canvas, earthMap, texBase) {
    this.canvas = canvas;
    this.earthMap = earthMap;
    this.on = false;
    this.status = '';
    this.days = new Map();     // 段落第一天 'YYYY-MM-DD' -> { bodies } | 'loading' | { error }
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 600);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.03;   // 離月面約 50 km
    this.controls.maxDistance = 400;    // 地球約在 210–235
    this.controls.enabled = false;
    this.placed = false;                // 第一次有地球位置時把鏡頭擺好

    this.stars = starField();
    this.scene.add(this.stars);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.12)); // 暗面留一點（地照）
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.scene.add(this.sunLight, this.sunLight.target);

    // 月球：貼圖中央（球的 +X）= 經度 0°，+Y = 北極，−Z = 東經 90°
    this.moonMat = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), this.moonMat);
    this.scene.add(this.moon);
    new THREE.TextureLoader().load(`${texBase}/moon_1024.jpg`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.moonMat.map = t;
      this.moonMat.color.set(0xffffff);
      this.moonMat.needsUpdate = true;
    });

    this.earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 64, 32), new THREE.MeshLambertMaterial({ color: 0x6f9fe0 }));
    this.earth.visible = false;
    this.scene.add(this.earth);

    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sun.visible = false;
    this.scene.add(this.sun);

    this.labelsEl = document.createElement('div');
    this.labelsEl.id = 'lunar-labels';
    this.labelsEl.hidden = true;
    document.getElementById('labels').after(this.labelsEl);
    this.earthLabel = this.makeLabel('地球', 'earth');
    this.sunLabel = this.makeLabel('太陽', 'sun');

    const dot = dotTexture();
    this.sats = new Map(); // id -> { name, point, orbit, label, color, pos, info }
    for (const [id, color] of Object.entries(COLORS)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const point = new THREE.Points(g, new THREE.PointsMaterial({ color, size: SAT_PX, sizeAttenuation: false, map: dot, transparent: true, alphaTest: 0.3 }));
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_POINTS * 3), 3));
      const orbit = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
      point.visible = orbit.visible = false;
      point.frustumCulled = orbit.frustumCulled = false;
      this.scene.add(point, orbit);
      const label = this.makeLabel('', 'sat');
      label.style.color = `#${color.toString(16).padStart(6, '0')}`;
      this.sats.set(id, { id, name: '', point, orbit, label, color, pos: new THREE.Vector3(), shown: false, text: '', alt: 0, period: 0, speed: 0, seesEarth: false });
    }

    this.selected = null;       // 追蹤清單選取的衛星 id
    this.spin = false;          // true = 太空固定（星空不動，看得到月球、地球自轉）；false = 跟著月球轉（月球看起來不動）
    this.qLast = null;          // 上一幀月球的方向（跟著月球轉時用）
    this._q = new THREE.Quaternion();
    this.earthPos = new THREE.Vector3();
    this.sunDir = new THREE.Vector3(1, 0, 0);
    this.haveSun = false;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  makeLabel(text, kind) {
    const el = document.createElement('div');
    el.className = `label lunar-label ${kind}`;
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

  // 下載某一段的星曆（失敗 1 分鐘後才再試）
  async ensureDay(day) {
    const cur = this.days.get(day);
    if (cur && (cur === 'loading' || !cur.error || Date.now() - cur.at < 60e3)) return;
    this.days.set(day, 'loading');
    try {
      const res = await fetch(`/api/lunar/${day}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      this.days.set(day, json);
    } catch (err) {
      this.days.set(day, { error: err.message, at: Date.now() });
    }
    // 只留最近用到的幾天
    while (this.days.size > MAX_DAYS) this.days.delete(this.days.keys().next().value);
  }

  // 某個天體在 ms 的狀態：先找那段的資料，接縫處（每段最後約 1 分鐘）再找下一段
  state(id, ms) {
    const b = blockOf(ms);
    for (const day of [dayStr(b), dayStr(b + BLOCK_MS), dayStr(b - BLOCK_MS)]) {
      const d = this.days.get(day);
      const b = d?.bodies?.find((x) => x.id === id);
      const s = stateAt(b, ms);
      if (s) return { s, name: b.name };
    }
    return null;
  }

  bodyError(id, ms) {
    const b = this.days.get(dayStr(blockOf(ms)))?.bodies?.find((x) => x.id === id);
    return b?.error ? { name: b.name, error: b.error } : null;
  }

  // 每幀呼叫（只在月球視角）
  update(ms) {
    const block = blockOf(ms);
    const today = dayStr(block);
    this.ensureDay(today);
    // 過了半段就先抓下一段（10000 倍時一段只要 35 秒，抓一段要約 5 秒）；模擬往回走時抓前一段
    if (ms - block > BLOCK_MS / 2) this.ensureDay(dayStr(block + BLOCK_MS)); else this.ensureDay(dayStr(block - BLOCK_MS));

    const d = this.days.get(today);
    this.status = d === 'loading' || !d ? '月球星曆下載中…（NASA JPL Horizons）' : d.error ? `月球星曆載入失敗：${d.error}` : '';

    // 月球方向
    const ax = moonAxes(ms);
    const x = dirScene(ax.x, new THREE.Vector3()), y = dirScene(ax.y, new THREE.Vector3()), z = dirScene(ax.z, new THREE.Vector3());
    this.moon.quaternion.setFromRotationMatrix(this._m.makeBasis(x, z, y.negate()));
    // 不是「自轉」模式時，鏡頭跟著月球轉，月球看起來不動（同地球畫面平常的做法）；星空跟著一起轉
    if (!this.spin && this.qLast) {
      const dq = this._q.copy(this.qLast).invert().premultiply(this.moon.quaternion);
      this.camera.position.applyQuaternion(dq);
      this.controls.target.applyQuaternion(dq);
      this.stars.quaternion.premultiply(dq);
    }
    (this.qLast ??= new THREE.Quaternion()).copy(this.moon.quaternion);

    // 太陽
    const sun = this.state('10', ms);
    if (sun) {
      this.sunDir.set(sun.s[0], sun.s[2], -sun.s[1]).normalize();
      this.haveSun = true;
    }
    this.sunLight.position.copy(this.sunDir);
    this.sunLight.target.position.set(0, 0, 0);

    // 地球
    const earth = this.state('399', ms);
    this.earth.visible = Boolean(earth);
    if (earth) {
      toScene(earth.s, this.earthPos);
      this.earth.position.copy(this.earthPos);
      const em = this.earth.material;
      if (this.earthMap.value && em.map !== this.earthMap.value) { em.map = this.earthMap.value; em.color.set(0xffffff); em.needsUpdate = true; }
      this.orientEarth(ms);
      if (!this.placed && this.haveSun) this.placeCamera();
    }

    // 衛星
    for (const sat of this.sats.values()) {
      const st = this.state(sat.id, ms);
      sat.shown = Boolean(st);
      sat.point.visible = sat.orbit.visible = sat.shown;
      if (!st) continue;
      sat.name = st.name;
      toScene(st.s, sat.pos);
      sat.point.geometry.attributes.position.setXYZ(0, sat.pos.x, sat.pos.y, sat.pos.z);
      sat.point.geometry.attributes.position.needsUpdate = true;
      const orb = keplerOrbit(st.s, ORBIT_POINTS);
      if (orb) {
        const attr = sat.orbit.geometry.attributes.position;
        orb.pts.forEach((p, i) => { toScene(p, this._v); attr.setXYZ(i, this._v.x, this._v.y, this._v.z); });
        attr.needsUpdate = true;
      }
      sat.orbit.visible = Boolean(orb);
      sat.period = orb ? orb.period : 0;
      sat.alt = Math.hypot(st.s[0], st.s[1], st.s[2]) - MOON_KM;
      sat.speed = Math.hypot(st.s[3], st.s[4], st.s[5]);
      sat.seesEarth = Boolean(earth) && !this.blocked(sat.pos, this.earthPos);
      sat.text = `${st.name} ${Math.round(sat.alt).toLocaleString()} km`;
    }

    this.controls.update();
    this.adjustCamera();
    this.placeLabels();
  }

  // 第一次：鏡頭擺在太陽那側（離太陽方向 50°，往地球那邊偏），看到的月球大半是亮的；
  // 地球不一定在畫面裡（例如滿月時地球和太陽同一邊，在鏡頭後面），拖曳轉一下就看得到
  placeCamera() {
    const s = this.sunDir;
    const e = this._v.copy(this.earthPos).normalize();
    let side = e.clone().addScaledVector(s, -e.dot(s));
    if (side.lengthSq() < 1e-6) side = new THREE.Vector3(0, 1, 0).cross(s);
    side.normalize();
    const dir = s.clone().multiplyScalar(Math.cos(50 * DEG)).addScaledVector(side, -Math.sin(50 * DEG)).add(new THREE.Vector3(0, 0.25, 0)).normalize();
    this.camera.position.copy(dir.multiplyScalar(9));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.placed = true;
  }

  adjustCamera() {
    const dist = this.camera.position.length();
    this.camera.near = Math.max(0.0005, (dist - 1) * 0.25);
    this.camera.far = Math.max(600, dist * 2 + 300);
    this.camera.updateProjectionMatrix();
    this.controls.zoomSpeed = THREE.MathUtils.clamp((dist - 1) * 2, 0.2, 1);
    this.controls.rotateSpeed = THREE.MathUtils.clamp((dist - 1) * 1.5, 0.15, 1);
    this.stars.position.copy(this.camera.position);
    this.stars.scale.setScalar(this.camera.far * 0.8);
    const pxScale = (2 * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, this.canvas.clientHeight);
    // 太陽：畫在鏡頭往太陽方向、接近遠裁切面的地方（真實距離 8.6 萬個月球半徑，遠超過遠裁切面）
    this.sun.visible = this.haveSun;
    const sunDist = this.camera.far * 0.7;
    this.sun.position.copy(this.camera.position).addScaledVector(this.sunDir, sunDist);
    this.sun.scale.setScalar(SUN_PX * sunDist * pxScale);
    // 地球太遠時至少 EARTH_MIN_PX 像素
    if (this.earth.visible) {
      const px = (2 * EARTH_R) / (this.camera.position.distanceTo(this.earthPos) * pxScale);
      this.earth.scale.setScalar(Math.max(1, EARTH_MIN_PX / px));
    }
  }

  orientEarth(ms) {
    const d = ms / 864e5 + 2440587.5 - 2451545;
    const g = (280.46061837 + 360.98564736629 * d) * DEG;
    const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
    const eqX = new THREE.Vector3(1, 0, 0), eqY = new THREE.Vector3(0, -se, -ce), eqZ = new THREE.Vector3(0, ce, -se);
    const lon0 = eqX.clone().multiplyScalar(Math.cos(g)).addScaledVector(eqY, Math.sin(g));
    const lon90 = eqX.clone().multiplyScalar(-Math.sin(g)).addScaledVector(eqY, Math.cos(g));
    this.earth.quaternion.setFromRotationMatrix(this._m.makeBasis(lon0, eqZ, lon90.negate()));
  }

  // 被月球擋住（鏡頭到那點的線段穿過月球）就不顯示標籤
  hiddenByMoon(p) { return this.blocked(this.camera.position, p); }

  // 線段 c→p 有沒有穿過月球
  blocked(c, p) {
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    const t = THREE.MathUtils.clamp(-(c.x * dx + c.y * dy + c.z * dz) / len2, 0, 1);
    const qx = c.x + t * dx, qy = c.y + t * dy, qz = c.z + t * dz;
    return t > 0 && t < 1 && qx * qx + qy * qy + qz * qz < 0.998;
  }

  place(el, pos, offsetPx, visible) {
    if (visible) {
      const v = this._v.copy(pos).project(this.camera);
      visible = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      if (visible) {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const x = ((v.x + 1) / 2) * w + offsetPx, y = ((1 - v.y) / 2) * h - offsetPx;
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
    el.style.display = visible ? '' : 'none';
  }

  placeLabels() {
    for (const sat of this.sats.values()) {
      if (sat.label.textContent !== sat.text) sat.label.textContent = sat.text;
      this.place(sat.label, sat.pos, 7, sat.shown && !this.hiddenByMoon(sat.pos));
    }
    const pxScale = (2 * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, this.canvas.clientHeight);
    const eDist = this.camera.position.distanceTo(this.earthPos);
    const ePx = (EARTH_R * this.earth.scale.x) / (eDist * pxScale);
    const km = Math.round(this.earthPos.length() * MOON_KM / 1000) * 1000;
    const eText = `地球 ${km.toLocaleString()} km`;
    if (this.earthLabel.textContent !== eText) this.earthLabel.textContent = eText;
    this.place(this.earthLabel, this.earthPos, ePx * 0.7 + 4, this.earth.visible && !this.hiddenByMoon(this.earthPos));
    this.place(this.sunLabel, this.sun.position, 18, this.sun.visible && !this.hiddenByMoon(this.sun.position));
  }

  // 追蹤清單點選：選取的衛星軌道線亮、其他變淡；不在畫面裡就把鏡頭轉過去。再點一次取消
  select(id) {
    this.selected = this.selected === id ? null : id;
    for (const sat of this.sats.values()) {
      const on = sat.id === this.selected;
      sat.orbit.material.opacity = this.selected === null ? 0.55 : on ? 1 : 0.15;
      sat.label.classList.toggle('selected', on);
    }
    const sat = this.sats.get(this.selected);
    if (sat?.shown) {
      const v = this._v.copy(sat.pos).project(this.camera);
      if (v.z >= 1 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85 || this.hiddenByMoon(sat.pos)) {
        const r = sat.pos.length();
        this.camera.position.copy(sat.pos).setLength(Math.min(Math.max(r * 2.2, 3), this.controls.maxDistance));
        this.controls.update();
      }
    }
  }

  // 追蹤清單用：每顆衛星的狀態（依高度排序）
  listInfo(ms) {
    return [...this.sats.values()].map((sat) => ({
      id: sat.id, name: sat.name || LUNAR_INFO[sat.id].title, color: `#${sat.color.toString(16).padStart(6, '0')}`,
      shown: sat.shown, alt: sat.alt, period: sat.period, speed: sat.speed, seesEarth: sat.seesEarth,
      error: sat.shown ? '' : (this.bodyError(sat.id, ms)?.error || '載入中…'),
    })).sort((a, b) => (a.shown ? a.alt : Infinity) - (b.shown ? b.alt : Infinity));
  }

  // 沒有星曆的衛星（給 app.js 的提示列）
  missing(ms) {
    const out = [];
    for (const id of this.sats.keys()) {
      const e = this.bodyError(id, ms);
      if (e) out.push(`${e.name}：${e.error}`);
    }
    return out;
  }
}
