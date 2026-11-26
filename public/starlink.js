// 星鏈（Starlink）圖層：上萬顆衛星畫成光點。
// 資料：伺服器的 /api/starlink（CelesTrak 的 TLE，伺服器端快取）。
// 計算：starlink-worker.js 定期算出位置和速度，這裡每一幀外插，並標出在台灣地平線上的。
import * as THREE from 'three';
import { makeSatModel, setModelLit } from './models.js';

// 近距離的 3D 模型：離鏡頭最近的 MODEL_MAX 顆。真實大小（翼展約 30 m）在幾十公里外就不到 1 像素，
// 所以畫面大小改成 MODEL_PX × MODEL_REF_KM ÷ 距離（越近越大），小於 MODEL_MIN_PX 就不畫模型、只留光點。
const EARTH_KM = 6371;
const MODEL_MAX = 60;
const MODEL_PX = 48, MODEL_MIN_PX = 6, MODEL_REF_KM = 600;
const MODEL_RANGE = (MODEL_PX * MODEL_REF_KM) / MODEL_MIN_PX / EARTH_KM;
const MODEL_REAL = 0.03 / EARTH_KM; // 真實翼展：比像素大小還大時（1 公里內）用真實大小
const DEG = Math.PI / 180;
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const vP = new THREE.Vector3(), vUp = new THREE.Vector3(), vFwd = new THREE.Vector3(), vRight = new THREE.Vector3();
const basis = new THREE.Matrix4();

const COLOR_UP = new THREE.Color(0xd9f1ff);   // 在台灣地平線上
const COLOR_DOWN = new THREE.Color(0x4f6680); // 其他

export class StarlinkLayer {
  constructor(scene) {
    this.scene = scene;
    this.worker = null;
    this.points = null;
    this.count = 0;
    this.above = 0;
    this.status = '';
    this.enabled = false;
    this.loading = false;
    this.busy = false;
    this.base = null;      // { ms, pos, vel }：最近一次 Worker 算出的結果
    this.lastRequest = 0;
    this.dataset = null;   // null = 最新資料（/api/starlink）；字串 = 歷史備份檔名（回放用）
    this.wanted = null;    // 想要切換到的資料
    this.switching = false;
    this.models = [];      // 近距離 3D 模型（重複使用）
    this.near = [];        // 這一幀要畫模型的 [距離, 索引]
  }

  // 回放時改用那個時間點的 TLE 備份；null = 最新資料。切換在背景進行，換好之前繼續用舊的。
  async useDataset(file) {
    this.wanted = file;
    if (!this.worker || this.switching || file === this.dataset) return;
    this.switching = true;
    try {
      const res = await fetch(file ? `/api/starlink/history/${encodeURIComponent(file)}` : '/api/starlink');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      this.dataset = file;
      this.base = null;
      this.worker.postMessage({ type: 'load', text });
    } catch (err) {
      console.warn('星鏈歷史資料載入失敗', err);
      this.wanted = this.dataset; // 不要一直重試
    } finally {
      this.switching = false;
    }
    if (this.wanted !== this.dataset) this.useDataset(this.wanted);
  }

  async enable() {
    this.enabled = true;
    if (this.points) { this.points.visible = true; return; }
    if (this.loading) return;
    this.loading = true;
    this.status = '下載星鏈資料中…';
    try {
      const res = await fetch('/api/starlink');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const text = await res.text();
      this.status = '計算中…';
      this.worker = new Worker('starlink-worker.js');
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.status = '星鏈計算失敗（需要網路載入 satellite.js）';
        this.busy = false;
      };
      this.worker.postMessage({ type: 'load', text });
    } catch (err) {
      this.status = `星鏈：${err.message}`;
    } finally {
      this.loading = false;
    }
  }

  disable() {
    this.enabled = false;
    if (this.points) this.points.visible = false;
    for (const m of this.models) m.visible = false;
  }

  // 每一幀在 update() 之後呼叫：把離鏡頭最近、在畫面內的星鏈畫成 3D 模型。
  updateModels(camera, viewPx, sunDir) {
    let used = 0;
    if (this.enabled && this.points?.visible) {
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const p = this.points.geometry.attributes.position.array, v = this.base.vel;
      const c = camera.position, r2 = MODEL_RANGE * MODEL_RANGE;
      const near = this.near;
      near.length = 0;
      for (let k = 0; k < p.length; k += 3) {
        const dx = p[k] - c.x, dy = p[k + 1] - c.y, dz = p[k + 2] - c.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2 || !frustum.containsPoint(vP.set(p[k], p[k + 1], p[k + 2]))) continue;
        near.push([d2, k]);
      }
      near.sort((a, b) => a[0] - b[0]);
      const tanHalf = Math.tan((camera.fov * DEG) / 2);
      for (const [d2, k] of near) {
        if (used >= MODEL_MAX) break;
        const d = Math.sqrt(d2);
        const px = Math.min(MODEL_PX, (MODEL_PX * MODEL_REF_KM) / EARTH_KM / d);
        if (px < MODEL_MIN_PX) break;
        let m = this.models[used];
        if (!m) {
          m = makeSatModel('starlink');
          this.models.push(m);
          this.scene.add(m);
        }
        used++;
        m.position.set(p[k], p[k + 1], p[k + 2]);
        vUp.copy(m.position).normalize();
        vFwd.set(v[k], v[k + 1], v[k + 2]);
        vFwd.addScaledVector(vUp, -vFwd.dot(vUp)).normalize();
        vRight.crossVectors(vUp, vFwd);
        m.quaternion.setFromRotationMatrix(basis.makeBasis(vRight, vUp, vFwd));
        const worldPerPx = (2 * d * tanHalf) / viewPx;
        m.scale.setScalar(Math.max(px * worldPerPx, MODEL_REAL));
        // 地球陰影（圓柱模型）
        const s = m.position.dot(sunDir);
        setModelLit(m, s > 0 || vP.copy(m.position).addScaledVector(sunDir, -s).lengthSq() > 1);
        m.visible = true;
      }
    }
    for (let i = used; i < this.models.length; i++) this.models[i].visible = false;
    this.modelCount = used;
  }

  onMessage(msg) {
    if (msg.type === 'loaded') {
      this.count = msg.count;
      if (this.points) { // 換了一份資料（回放），顆數可能不同，重建
        this.scene.remove(this.points);
        this.points.geometry.dispose();
        this.points.material.dispose();
        this.points = null;
      }
      this.busy = false;
      this.base = null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(msg.count * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(msg.count * 3), 3));
      this.points = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 2.5, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
      }));
      this.points.frustumCulled = false;
      this.points.visible = false; // 等第一批位置算好
      this.scene.add(this.points);
    } else if (msg.type === 'tick') {
      this.busy = false;
      if (this.points && msg.count === this.count) this.base = msg; // 換資料前送出的舊結果不要用
    }
  }

  // 每一幀呼叫。ms = 模擬時鐘；up = 觀測點（台灣）的單位向量；speed = 模擬倍速（即時 = 1）。
  update(ms, up, speed = 1) {
    if (!this.enabled || !this.points) return;
    const fast = speed > 1;
    // 定期請 Worker 重算：即時每秒一次；加速模擬時更頻繁，外插的時間才不會太長。
    const interval = fast ? 400 : 1000;
    const base = this.base;
    const stale = !base || Math.abs(ms - base.ms) > (fast ? 60e3 : 10e3);
    if (!this.busy && (Date.now() - this.lastRequest > interval || stale)) {
      this.busy = true;
      this.lastRequest = Date.now();
      this.worker.postMessage({ type: 'tick', ms });
    }
    // 跳時間（例如點過境預報）之後，舊結果外插太遠會不準，先藏起來等新結果。
    // 高倍速回放時 Worker 算一次（約 0.2 秒）模擬時間就過了好幾分鐘，門檻跟著倍速放寬。
    const hideAfter = Math.max(5 * 60e3, speed * 1500);
    if (!base || Math.abs(ms - base.ms) > hideAfter) { this.points.visible = false; return; }

    // 直線外插只在短時間內準（低軌衛星 90 秒約偏 30 公里，畫面上看不出來；再久就明顯飄出軌道），
    // 超過 90 秒就停在那裡等下一批結果。高倍速回放時光點會一跳一跳的。
    const dt = Math.max(-90e3, Math.min(90e3, ms - base.ms));
    const pos = this.points.geometry.attributes.position;
    const col = this.points.geometry.attributes.color;
    const p = pos.array, c = col.array, bp = base.pos, bv = base.vel;
    let above = 0;
    for (let k = 0; k < p.length; k += 3) {
      const x = bp[k] + bv[k] * dt, y = bp[k + 1] + bv[k + 1] * dt, z = bp[k + 2] + bv[k + 2] * dt;
      p[k] = x; p[k + 1] = y; p[k + 2] = z;
      // 在台灣地平線上 ⇔ 衛星在台灣切平面的外側：(p − up)·up > 0，地球半徑 = 1。
      const isUp = x * up.x + y * up.y + z * up.z > 1;
      const color = isUp ? COLOR_UP : COLOR_DOWN;
      c[k] = color.r; c[k + 1] = color.g; c[k + 2] = color.b;
      if (isUp) above++;
    }
    pos.needsUpdate = col.needsUpdate = true;
    this.above = above;
    this.points.visible = true;
    this.status = '';
  }
}
