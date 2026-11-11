// 雲圖圖層：氣象署 O-B0033-001（向日葵 9 號全盤面紅外線黑白雲圖，經過 server.js 的 /api/clouds）。
// 圖是衛星從東經 140.7° 上空看下去的「靜止衛星投影」，不是經緯度方格，
// 所以在 shader 裡把雲球上每一點的經緯度用 CGMS 標準公式換成圖上的位置再取樣。
// 紅外線越亮代表越冷（雲頂越高），亮度轉成雲的不透明度。
import * as THREE from 'three';

const REFRESH_MS = 10 * 60e3;   // 氣象署每 10 分鐘出一張
const TEX_SIZE = 2750;          // 原圖 5500，縮一半（約 4 公里一格）省下 GPU 記憶體
const HIST_TEX_SIZE = 2048;     // 回放用的歷史雲圖再小一點（約 5.5 公里一格），一次要留好幾張
const MAX_CACHED = 4;           // 回放時最多留幾張歷史雲圖在 GPU（每張約 17 MB）

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
    this.uniforms = {
      cloudMap: { value: null },
      opacity: { value: 1 },    // 模擬時間離觀測時間太遠時調淡（app.js 設定）
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
      this.live = { tex: await makeTexture(await res.blob(), TEX_SIZE), t };
      if (!this.shown || this.shown === old) this.display(this.live);
      if (old) disposeTex(old.tex);
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
    if (hit) { hit.used = Date.now(); this.display(hit); } else this.fetchFrame(want);
    const next = frames[frames.indexOf(want) + 1]; // 回放時先把下一張載好，換圖才不會卡
    if (next && !this.cache.has(next.file)) this.fetchFrame(next);
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
