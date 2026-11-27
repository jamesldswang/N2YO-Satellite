// 雲圖圖層：氣象署 O-B0033-001（向日葵 9 號全盤面紅外線黑白雲圖，經過 server.js 的 /api/clouds）。
// 圖是衛星從東經 140.7° 上空看下去的「靜止衛星投影」，不是經緯度方格，
// 所以在 shader 裡把雲球上每一點的經緯度用 CGMS 標準公式換成圖上的位置再取樣。
// 紅外線越亮代表越冷（雲頂越高），亮度轉成雲的不透明度。
import * as THREE from 'three';

const REFRESH_MS = 10 * 60e3;   // 氣象署每 10 分鐘出一張
const TEX_SIZE = 2750;          // 原圖 5500，縮一半（約 4 公里一格）省下 GPU 記憶體
const HIST_TEX_SIZE = 2048;     // 回放用的歷史雲圖再小一點（約 5.5 公里一格），一次要留好幾張
const MAX_CACHED = 4;           // 回放時最多留幾張歷史雲圖在 GPU（每張約 17 MB）
// 短時外推：用最新一張和約 1 小時前的一張算出雲的移動，模擬到最新觀測之後時把雲往前推
export const FORECAST_MAX_HOURS = 3; // 再久外推就不可靠（雲會生成、消散），app.js 改回「不隨模擬變化」
const FLOW_GAP_MIN = 60;             // 理想的兩張間隔
const FLOW_GAP_RANGE = [40, 90];     // 可接受的間隔（分鐘）
const FLOW_STEPS = 4;                // shader 沿著移動場分幾段往回追

async function makeTexture(blob, size) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false;                   // ImageBitmap 不能翻轉；shader 的 v = 0 就是圖的最上面
  tex.colorSpace = THREE.NoColorSpace; // 亮度是資料（溫度），不要做色彩轉換
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}
const disposeTex = (tex) => { tex.dispose(); tex.image?.close?.(); };

export class CloudLayer {
  constructor(scene, sunDir) {
    this.enabled = false;
    this.status = '';
    this.obsTime = null;        // Date：現在畫面上這張的觀測時間
    this.timer = null;
    this.live = null;           // { tex, t }：最新的一張
    this.cache = new Map();     // 歷史檔名 -> { tex, t, used }（回放用）
    this.pending = new Set();   // 下載中的歷史檔名
    this.failed = new Set();    // 下載失敗的（例如已經超過 24 小時被刪掉），不再重試
    this.shown = null;          // 畫面上這張（live 或 cache 裡的某一張）
    this.liveBlob = null;       // 最新一張的原檔（算移動場用）
    this.flow = null;           // { t, tex, valid, gapMin, from }：對應 live.t 的移動場
    this.flowBusy = false;
    this.flowTried = 0;         // 上次嘗試的 live.t（失敗或沒有舊圖時不要一直重試）
    this.flowWorker = null;
    this.forecastHours = 0;     // 現在畫面外推了幾小時（app.js 顯示用）
    this.uniforms = {
      cloudMap: { value: null },
      opacity: { value: 1 },    // 模擬時間離觀測時間太遠時調淡（app.js 設定）
      flowMap: { value: null }, // 移動場（uv / 小時），沒有時 fcHours = 0
      fcHours: { value: 0 },    // 外推幾小時
      sunDir,                   // 和地球 shader 共用同一個 uniform，太陽位置一起動
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.006, 128, 96), // 比地表高約 40 公里，避免和地球 z-fighting
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: `
          varying vec3 vP;
          void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform sampler2D cloudMap; uniform vec3 sunDir; uniform float opacity;
          uniform sampler2D flowMap; uniform float fcHours;
          varying vec3 vP;
          const float DEG = 0.017453292519943295;
          const float SUB_LON = 140.7 * DEG;       // 向日葵 9 號的經度
          const float K = 20466275.0 / 65536.0 / 5500.0; // CFAC：每度在圖上佔的比例
          void main() {
            vec3 p = normalize(vP);
            // 場景座標：+X = 0°E、+Y = 北、-Z = 90°E（見 app.js 的 geoToVec）
            float lat = asin(clamp(p.y, -1.0, 1.0));
            float dl = atan(-p.z, p.x) - SUB_LON;
            // CGMS LRIT/HRIT 全球規範的經緯度 → 靜止衛星掃描角
            float c = atan(0.993305616 * tan(lat));
            float cc = cos(c);
            float rl = 6356.7523 / sqrt(1.0 - 0.00669438444 * cc * cc);
            float r1 = 42164.0 - rl * cc * cos(dl);
            float r2 = -rl * cc * sin(dl);
            float r3 = rl * sin(c);
            float rn = sqrt(r1 * r1 + r2 * r2 + r3 * r3);
            // 衛星看得到的半邊：cos(c)·cos(dl) > R/42164；邊緣影像拉長失真，慢慢淡出
            float facing = cc * cos(dl);
            float limb = smoothstep(0.17, 0.32, facing);
            if (limb <= 0.0) discard;
            float x = atan(-r2 / r1) / DEG;
            float y = asin(-r3 / rn) / DEG;
            vec2 uv = vec2(0.5 + x * K, 0.5 + y * K);
            // 外推：t 小時後這裡的雲，是現在「往上風處追回去」那裡的雲（分段沿著移動場走）
            if (fcHours > 0.0) {
              float h = fcHours / ${FLOW_STEPS}.0;
              for (int i = 0; i < ${FLOW_STEPS}; i++) uv -= texture2D(flowMap, uv).xy * h;
            }
            float v = texture2D(cloudMap, uv).r;
            // 實測（11 月清晨）：晴空海面約 0.24、台灣陸地 0.30、蒙古晴空陸地 0.42、
            // 華中雲帶 0.54、強對流 0.7 以上。單一紅外線頻道分不出很冷的地表和雲，
            // 所以冬天的西伯利亞、高原可能被當成薄雲。
            float a = smoothstep(0.38, 0.68, v) * limb * 0.92 * opacity;
            if (a < 0.01) discard;
            float d = dot(p, sunDir);
            float light = mix(0.34, 0.4 + 0.75 * max(d, 0.0), smoothstep(-0.1, 0.12, d)); // 紅外線日夜都有，夜裡也看得到雲
            gl_FragColor = vec4(vec3(light), a);
          }`,
      }),
    );
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.mesh.visible = Boolean(this.shown);
    this.load();
    this.flowTried = 0; // 關掉時可能錯過了，重新算
    this.updateFlow();
    this.timer = setInterval(() => this.load(), REFRESH_MS);
  }

  disable() {
    this.enabled = false;
    this.mesh.visible = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const [file, e] of this.cache) if (e !== this.shown) { disposeTex(e.tex); this.cache.delete(file); }
  }

  // 下載最新的一張
  async load() {
    if (!this.live) this.status = '雲圖下載中…';
    try {
      const res = await fetch('/api/clouds', { cache: 'no-store' });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const t = Date.parse(res.headers.get('X-Obs-Time'));
      this.status = '';
      if (this.live && this.live.t === t) return; // 還是同一張
      const old = this.live;
      const blob = await res.blob();
      this.live = { tex: await makeTexture(blob, TEX_SIZE), t };
      this.liveBlob = blob;
      if (!this.shown || this.shown === old) this.display(this.live);
      if (old) disposeTex(old.tex);
      this.updateFlow();
    } catch (err) {
      this.status = this.live ? '' : `雲圖載入失敗：${err.message}`;
      console.warn('雲圖載入失敗', err);
    }
  }

  // app.js 每 250 毫秒呼叫：ms = 模擬時鐘；frames = 歷史雲圖 [{ t, file }]（舊到新）；
  // simulating = 正在加速模擬或回放。模擬到過去時，換成那時候的雲圖（t ≤ ms 的最後一張）。
  showAt(ms, frames, simulating) {
    if (!this.enabled) return;
    let want = null; // null = 最新的一張
    if (simulating && frames.length && (!this.live || ms < this.live.t)) {
      let pick = frames[0]; // 比最早的還早就用最早的（app.js 會標成「不隨模擬變化」並調淡）
      for (const f of frames) { if (f.t <= ms) pick = f; else break; }
      if (!this.live || pick.t < this.live.t) want = pick;
    }
    if (!want) { if (this.live) this.display(this.live); return; }
    const hit = this.cache.get(want.file);
    if (hit) { hit.used = Date.now(); this.display(hit); } else {
      this.fetchFrame(want);
      // 高倍速時下載＋解碼比換圖慢，等到的時候時鐘已經走到下一張；
      // 先顯示已經載好、時間最接近（t ≤ ms）的那張，不然會一直停在最新的雲圖
      let best = null;
      for (const e of this.cache.values()) if (e.t <= ms && (!best || e.t > best.t)) best = e;
      if (best && (!this.shown || this.shown === this.live || best.t > this.shown.t || this.shown.t > ms)) {
        best.used = Date.now();
        this.display(best);
      }
    }
    const next = frames[frames.indexOf(want) + 1]; // 回放時先把下一張載好，換圖才不會卡
    if (next && !this.cache.has(next.file)) this.fetchFrame(next);
  }

  // 每幀呼叫：ms = 模擬時鐘。畫面是最新一張、時鐘已經超過觀測時間、又有移動場時才外推。
  // 即時模式不外推（畫面維持真正的觀測）。回傳外推的小時數（0 = 沒有外推）。
  setForecast(ms, simulating) {
    let h = 0;
    if (this.enabled && simulating && this.flow && this.live && this.shown === this.live && this.flow.t === this.live.t) {
      h = (ms - this.live.t) / 3600e3;
      if (h <= 0 || h > FORECAST_MAX_HOURS) h = 0;
    }
    this.forecastHours = h;
    this.uniforms.fcHours.value = h;
    return h;
  }

  // 有新的最新雲圖就重算移動場：到伺服器的歷史清單找約 1 小時前的一張
  async updateFlow() {
    if (!this.enabled || this.flowBusy || !this.live || !this.liveBlob) return;
    const t = this.live.t;
    if (this.flowTried === t) return;
    this.flowTried = t;
    this.flowBusy = true;
    try {
      const res = await fetch('/api/history', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const frames = (await res.json()).clouds || [];
      let pick = null;
      for (const f of frames) {
        const gap = (t - f.t) / 60e3;
        if (gap < FLOW_GAP_RANGE[0] || gap > FLOW_GAP_RANGE[1]) continue;
        if (!pick || Math.abs(gap - FLOW_GAP_MIN) < Math.abs((t - pick.t) / 60e3 - FLOW_GAP_MIN)) pick = f;
      }
      if (!pick) { console.info('雲的外推：找不到約 1 小時前的雲圖，先不外推'); return; }
      const oldRes = await fetch(`/api/clouds/history/${encodeURIComponent(pick.file)}`);
      if (!oldRes.ok) throw new Error(`HTTP ${oldRes.status}`);
      const oldBlob = await oldRes.blob();
      const gapHours = (t - pick.t) / 3600e3;
      this.flowWorker ??= new Worker('clouds-flow-worker.js');
      const out = await new Promise((resolve) => {
        this.flowWorker.onmessage = ({ data }) => resolve(data);
        this.flowWorker.postMessage({ id: t, oldBlob, newBlob: this.liveBlob, gapHours });
      });
      if (out.error) throw new Error(out.error);
      if (!this.live || this.live.t !== t) return; // 算的時候又來了新圖
      const n = out.grid;
      const half = new Uint16Array(n * n * 2);
      for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(out.flow[i]);
      const tex = new THREE.DataTexture(half, n, n, THREE.RGFormat, THREE.HalfFloatType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this.flow?.tex.dispose();
      this.flow = { t, tex, valid: out.valid, gapMin: Math.round(gapHours * 60), from: pick.t };
      this.uniforms.flowMap.value = tex;
    } catch (err) {
      console.warn('雲的移動場計算失敗', err);
    } finally {
      this.flowBusy = false;
    }
  }

  display(entry) {
    this.shown = entry;
    this.uniforms.cloudMap.value = entry.tex;
    this.obsTime = new Date(entry.t);
    this.mesh.visible = this.enabled;
  }

  async fetchFrame(f) {
    if (this.pending.has(f.file) || this.failed.has(f.file) || this.pending.size >= 2) return;
    this.pending.add(f.file);
    try {
      const res = await fetch(`/api/clouds/history/${encodeURIComponent(f.file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tex = await makeTexture(await res.blob(), HIST_TEX_SIZE);
      if (!this.enabled) { disposeTex(tex); return; }
      this.cache.set(f.file, { tex, t: f.t, used: Date.now() });
      // 超過上限就丟掉最久沒用到的（畫面上那張除外）
      while (this.cache.size > MAX_CACHED) {
        let oldest = null;
        for (const [file, e] of this.cache) if (e !== this.shown && (!oldest || e.used < oldest[1].used)) oldest = [file, e];
        if (!oldest) break;
        disposeTex(oldest[1].tex);
        this.cache.delete(oldest[0]);
      }
    } catch (err) {
      this.failed.add(f.file);
      console.warn('歷史雲圖載入失敗', f.file, err);
    } finally {
      this.pending.delete(f.file);
    }
  }
}
