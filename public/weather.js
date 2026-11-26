// 溫度／風圖層：氣象署約 360 個測站的即時觀測（/api/weather）。
// 每站一個依溫度上色的點，加一支白色箭頭表示風往哪裡吹、長度表示風速。
// 點和箭頭都固定畫面像素大小（每幀依鏡頭到台灣的距離換算），拉遠時不會糊成一團就淡出。
import * as THREE from 'three';

const EARTH_KM = 6371;
const REFRESH_MS = 5 * 60e3;   // 測站每 10 分鐘更新，伺服器快取 3 分鐘
const ALT_KM = 0.3;            // 稍微離地，避免和地面圖塊互相閃爍
const POINT_PX = 10;
const ARROW_PX_PER_MS = 4;     // 每 1 m/s 多少像素（拉近時；拉遠時和點一起縮小，最小 45%）
const FULL_SIZE_KM_PER_PX = 1.5;
const ARROW_MAX_MS = 20;       // 超過的畫一樣長
const SHOW_KM_PER_PX = [3, 6]; // 每像素幾公里：3 以下完整顯示，6 以上不顯示
export const TEMP_MIN = 0, TEMP_MAX = 35;

// 溫度顏色：0°C 藍 → 青 → 綠 → 黃 → 35°C 紅
export function tempColor(t, out = new THREE.Color()) {
  const x = THREE.MathUtils.clamp((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
  return out.setHSL((1 - x) * 0.66, 0.9, 0.55, THREE.SRGBColorSpace);
}

function geoToVec(lat, lng, altKm, out = new THREE.Vector3()) {
  const r = 1 + altKm / EARTH_KM;
  const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lng);
  return out.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

export class WeatherLayer {
  constructor(scene, camera, renderer) {
    this.camera = camera;
    this.renderer = renderer;
    this.enabled = false;
    this.status = '';
    this.obsTime = null;      // Date
    this.stations = [];
    this.opacity = 1;         // 外部設定（資料太舊時調淡）
    this.timer = 0;
    this.arrowScale = 0;      // 目前箭頭用的「每 m/s 幾公里」，差太多才重建

    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 30;
    scene.add(this.group);

    this.pointMat = new THREE.PointsMaterial({
      size: POINT_PX, sizeAttenuation: false, vertexColors: true,
      transparent: true, depthTest: false, depthWrite: false,
      map: makeDotTexture(), alphaTest: 0.05,
    });
    this.arrowMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    });
    this.points = null;
    this.arrows = null;
    this.center = geoToVec(23.7, 121, 0);
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.load();
    this.timer = setInterval(() => this.load(), REFRESH_MS);
  }

  disable() {
    this.enabled = false;
    clearInterval(this.timer);
    this.group.visible = false;
  }

  async load() {
    if (!this.stations.length) this.status = '測站資料下載中…';
    try {
      const res = await fetch('/api/weather');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      this.stations = data.stations;
      this.obsTime = data.obsTime ? new Date(data.obsTime) : null;
      this.status = '';
      this.build();
    } catch (err) {
      if (!this.stations.length) this.status = `測站資料讀取失敗：${err.message}`;
    }
  }

  // 依溫度、風速統計，給資訊列用
  summary() {
    let lo = null, hi = null, windy = null;
    for (const s of this.stations) {
      if (s.temp !== null) {
        if (!lo || s.temp < lo.temp) lo = s;
        if (!hi || s.temp > hi.temp) hi = s;
      }
      if (s.wspd !== null && (!windy || s.wspd > windy.wspd)) windy = s;
    }
    return { lo, hi, windy };
  }

  build() {
    for (const o of [this.points, this.arrows]) {
      if (o) { this.group.remove(o); o.geometry.dispose(); }
    }
    const pos = [], col = [];
    const c = new THREE.Color(), v = new THREE.Vector3();
    for (const s of this.stations) {
      if (s.temp === null) continue;
      geoToVec(s.lat, s.lon, ALT_KM, v);
      pos.push(v.x, v.y, v.z);
      tempColor(s.temp, c);
      col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.points = new THREE.Points(g, this.pointMat);
    this.points.renderOrder = 31;
    this.points.frustumCulled = false;

    // 箭頭：每站 3 段（桿子＋兩邊箭頭）= 6 個頂點，長度每幀依縮放改
    const windy = this.stations.filter((s) => s.wspd !== null && s.wdir !== null && s.wspd > 0);
    this.windStations = windy;
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(windy.length * 18), 3));
    this.arrows = new THREE.LineSegments(ag, this.arrowMat);
    this.arrows.renderOrder = 30;
    this.arrows.frustumCulled = false;
    this.arrowScale = 0;
    this.group.add(this.arrows, this.points);
  }

  // 每幀呼叫。visible：外部判斷（太空俯瞰、台灣在地球正面）
  update(visible) {
    if (!this.enabled || !this.points || !visible) { this.group.visible = false; return; }
    const dist = this.camera.position.distanceTo(this.center);
    const pxScale = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.renderer.domElement.clientHeight);
    const kmPerPx = dist * pxScale * EARTH_KM;
    const [a, b] = SHOW_KM_PER_PX;
    const fade = 1 - THREE.MathUtils.smoothstep(kmPerPx, a, b);
    this.group.visible = fade > 0.01;
    if (!this.group.visible) return;
    this.pointMat.opacity = fade * this.opacity;
    this.arrowMat.opacity = 0.85 * fade * this.opacity;
    // 拉遠時測站擠在一起，點和箭頭跟著縮小
    const k = THREE.MathUtils.clamp(FULL_SIZE_KM_PER_PX / kmPerPx, 0.45, 1);
    this.pointMat.size = POINT_PX * k;
    const scale = kmPerPx * ARROW_PX_PER_MS * k; // 每 m/s 幾公里
    if (Math.abs(scale - this.arrowScale) > this.arrowScale * 0.03) {
      this.layoutArrows(scale, (kmPerPx * this.pointMat.size) / 2);
    }
  }

  // 箭頭從點的邊緣開始（baseKm = 點的半徑），微風也看得到
  layoutArrows(kmPerMs, baseKm) {
    this.arrowScale = kmPerMs;
    const arr = this.arrows.geometry.attributes.position;
    const p = new THREE.Vector3(), e = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3();
    const tip = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), h = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    let i = 0;
    const put = (vec) => { arr.setXYZ(i++, vec.x, vec.y, vec.z); };
    for (const s of this.windStations) {
      geoToVec(s.lat, s.lon, ALT_KM, p);
      up.copy(p).normalize();
      e.crossVectors(Y, up).normalize(); // 東
      n.crossVectors(up, e);             // 北
      // 氣象的風向是「從哪裡吹來」，箭頭畫往下風處
      const to = THREE.MathUtils.degToRad(s.wdir + 180);
      dir.copy(n).multiplyScalar(Math.cos(to)).addScaledVector(e, Math.sin(to));
      const len = (Math.min(s.wspd, ARROW_MAX_MS) * kmPerMs) / EARTH_KM;
      const base = baseKm / EARTH_KM;
      const head = Math.min(len * 0.6, (kmPerMs * 2.5) / EARTH_KM);
      tip.copy(p).addScaledVector(dir, base + len);
      side.crossVectors(up, dir);
      h.copy(p).addScaledVector(dir, base);
      put(h); put(tip);
      h.copy(tip).addScaledVector(dir, -head).addScaledVector(side, head * 0.6);
      put(tip); put(h);
      h.copy(tip).addScaledVector(dir, -head).addScaledVector(side, -head * 0.6);
      put(tip); put(h);
    }
    arr.needsUpdate = true;
  }
}

// 圓點貼圖（有深色外框，在亮的地面上也看得清楚）
function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.fill();
  g.beginPath();
  g.arc(16, 16, 10.5, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
