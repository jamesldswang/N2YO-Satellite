// 星鏈（Starlink）圖層：上萬顆衛星畫成光點。
// 資料：伺服器的 /api/starlink（CelesTrak 的 TLE，伺服器端快取）。
// 計算：starlink-worker.js 定期算出位置和速度，這裡每一幀外插，並標出在台灣地平線上的。
import * as THREE from 'three';

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
  }

  onMessage(msg) {
    if (msg.type === 'loaded') {
      this.count = msg.count;
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
      this.base = msg;
    }
  }

  // 每一幀呼叫。ms = 模擬時鐘；up = 觀測點（台灣）的單位向量；fast = 是否在加速模擬。
  update(ms, up, fast) {
    if (!this.enabled || !this.points) return;
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
    if (!base || Math.abs(ms - base.ms) > 5 * 60e3) { this.points.visible = false; return; }

    const dt = ms - base.ms;
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
