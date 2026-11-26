import * as THREE from 'three';

// 台灣高解析影像（EOX Sentinel-2 cloudless）的四分樹 LOD。
// 範圍和圖塊大小由伺服器的 /api/config 給（twTiles）。每個圖塊是一片自己的球面網格，
// 畫在地球上面：不寫深度、只和地球比深度，依層級排 renderOrder，細的蓋在粗的上面。
// 子圖塊還沒載入時就先看得到父圖塊；拉遠到 Blue Marble 已經夠清楚時整個淡出，不載入任何圖塊。

const EARTH_KM = 6371;
const SEG = 16;            // 每片網格每邊的格數
const MAX_TEXTURES = 64;   // 最多留幾塊貼圖（512² 含 mipmap 約 1.4 MB）
const MAX_LOADING = 4;
const EDGE_DEG = 0.3;      // 範圍邊緣和底圖混合的寬度（度）
const RETRY_MS = 30e3;
const SEA_MASK_URL = 'textures/taiwan-sea-mask.png';
const FADE_IN_MS = 300;
// 螢幕上每個像素多少公里時開始淡入（Blue Marble 5400 約 7 km／像素）
const FADE_FROM_KM = 8, FADE_FULL_KM = 3;
const NIGHT_FULL_KM = 3; // 每像素大於這個值時夜晚燈光全亮（低解析燈光圖）
const NIGHT_TILE_GAIN = 0.85; // Black Marble 比低解析燈光圖亮，稍微調暗

const vertexShader = `
  attribute vec2 tuv;
  varying vec2 vUv, vT; varying vec3 vN;
  void main() { vUv = uv; vT = tuv; vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class TaiwanTiles {
  // shadeGlsl：和地球共用的 shade(day, night, normal) 函式，日夜光影才會一致
  constructor({ scene, camera, renderer, geoToVec, earthUniforms, shadeGlsl, config, onCredit }) {
    Object.assign(this, { scene, camera, renderer, geoToVec, config, onCredit, earthUniforms });
    this.tiles = new Map();
    this.loading = 0;
    this.enabled = true;
    this.creditShown = false;
    this.loader = new THREE.TextureLoader();
    this.frustum = new THREE.Frustum();
    this.projView = new THREE.Matrix4();
    const { west, south, size } = config;
    this.center = geoToVec(south + size / 2, west + size / 2, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        nightMap: earthUniforms.nightMap,
        dayMap: earthUniforms.dayMap,
        sunDir: earthUniforms.sunDir,
        bounds: { value: new THREE.Vector4(west, south, west + size, south + size) },
        alpha: { value: 1 },
        nightGain: { value: 1 },
        seaMask: { value: null },
        nightTile: { value: null },   // Black Marble 圖塊（自己或祖先的），還沒有就用地球的低解析燈光圖
        nightRect: { value: new THREE.Vector4(0, 0, 1, 1) }, // 在 nightTile 裡的位置：offset.xy、scale.zw
        nightOn: { value: 0 },
      },
      vertexShader,
      fragmentShader: `
        uniform sampler2D map, dayMap, nightMap, seaMask, nightTile; uniform vec4 nightRect; uniform float nightOn; uniform vec3 sunDir; uniform vec4 bounds; uniform float alpha, nightGain;
        varying vec2 vUv, vT; varying vec3 vN;
        ${shadeGlsl}
        void main() {
          vec2 ll = vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0);
          float edge = min(min(ll.x - bounds.x, bounds.z - ll.x), min(ll.y - bounds.y, bounds.w - ll.y));
          // 外海的白天顏色用底圖的 Blue Marble，只有陸地和沿岸約 1 km 用 Sentinel-2（海面有拍攝條帶的接縫）。
          // 在 shader 裡合成而不是讓外海透明：夜晚燈光整個範圍都要用 Black Marble，
          // 不然底圖的低解析燈光會在海岸外留一圈方塊狀的光暈
          float sea = texture2D(seaMask, (ll - bounds.xy) / (bounds.zw - bounds.xy)).r;
          vec3 day = mix(texture2D(map, vT).rgb, texture2D(dayMap, vUv).rgb, sea);
          float a = smoothstep(0.0, ${EDGE_DEG.toFixed(3)}, edge) * alpha;
          vec3 lights = nightOn > 0.5
            // Black Marble 沒燈的地方是深藍色 (0, 1, 29)，底圖的燈光圖則是 (8, 8, 16)：
            // 換成底圖的底色，範圍邊緣才不會看出方框
            ? max(texture2D(nightTile, nightRect.xy + vT * nightRect.zw).rgb - vec3(0.01, 0.02, 0.13), 0.0) * ${NIGHT_TILE_GAIN.toFixed(2)}
              + vec3(0.031, 0.031, 0.063)
            : texture2D(nightMap, vUv).rgb * nightGain;
          gl_FragColor = vec4(shade(day, lights, normalize(vN)), a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    // 外海遮罩（tools/make-sea-mask.py 產生），載入前不顯示任何圖塊
    this.loader.load(SEA_MASK_URL, (tex) => {
      tex.format = THREE.RedFormat;
      tex.needsUpdate = true;
      this.material.uniforms.seaMask.value = tex;
    }, undefined, () => console.warn('無法載入外海遮罩'));
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) return t;
    const d = this.config.size / 2 ** z;
    const w = this.config.west + x * d, s = this.config.south + y * d;
    const pts = [];
    for (const la of [s, s + d / 2, s + d]) for (const ln of [w, w + d / 2, w + d]) pts.push(this.geoToVec(la, ln, 0));
    const center = pts[4];
    const sphere = new THREE.Sphere(center, Math.max(...pts.map((p) => p.distanceTo(center))));
    t = { key, z, x, y, w, s, d, pts, sphere, texelKm: (d * 111.32) / this.config.px, state: 'none', retryAt: 0, used: 0, mesh: null, shown: 0,
      night: null, nightState: 'none', nightRetryAt: 0 };
    this.tiles.set(key, t);
    return t;
  }

  // 只要有一個角落、邊的中點或中心在地平線上就算看得到
  facing(t, cam) {
    return this.frustum.intersectsSphere(t.sphere) && t.pts.some((p) => p.dot(cam) > 1);
  }

  buildMesh(t, tex) {
    const n = SEG + 1;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), tuv = new Float32Array(n * n * 2);
    const v = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const lat = t.s + (t.d * j) / SEG, lng = t.w + (t.d * i) / SEG;
        this.geoToVec(lat, lng, 0, v).toArray(pos, k * 3);
        uv[k * 2] = (lng + 180) / 360; uv[k * 2 + 1] = (lat + 90) / 180; // 和 SphereGeometry 一樣，夜晚燈光圖用
        tuv[k * 2] = i / SEG; tuv[k * 2 + 1] = j / SEG;
      }
    }
    const index = [];
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        index.push(a, b, d, a, d, c);
      }
    }
    const geo = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.BufferAttribute(pos, 3))
      .setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      .setAttribute('tuv', new THREE.BufferAttribute(tuv, 2))
      .setIndex(index);
    geo.boundingSphere = t.sphere.clone();
    const mat = this.material.clone(); // uniforms 複製後 nightMap、sunDir 要接回共用的物件
    mat.uniforms.nightMap = this.material.uniforms.nightMap;
    mat.uniforms.dayMap = this.material.uniforms.dayMap;
    mat.uniforms.sunDir = this.material.uniforms.sunDir;
    mat.uniforms.nightGain = this.material.uniforms.nightGain;
    mat.uniforms.seaMask = this.material.uniforms.seaMask;
    mat.uniforms.map.value = tex;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -20 + t.z; // 比雲圖、大氣等其他透明物件早畫；細的層後畫
    mesh.visible = false;
    this.scene.add(mesh);
    t.mesh = mesh;
  }

  loadNight(t) {
    t.nightState = 'loading';
    this.loading++;
    this.loader.load(`/api/twtile/night/${t.z}/${t.x}/${t.y}.jpg`, (tex) => {
      this.loading--;
      t.night = tex;
      t.nightState = 'ready';
    }, undefined, () => {
      this.loading--;
      t.nightState = 'none';
      t.nightRetryAt = performance.now() + RETRY_MS;
    });
  }

  // 大部分照得到太陽的圖塊不用下載夜間燈光
  dark(t) {
    return t.sphere.center.dot(this.earthUniforms.sunDir.value) < 0.35;
  }

  // 這塊要用的 Black Marble：自己，或第 nightMaxZ 層的祖先（只取其中一小塊）
  applyNight(t) {
    const u = t.mesh.material.uniforms;
    const nz = Math.min(t.z, this.config.nightMaxZ), shift = t.z - nz;
    const ax = t.x >> shift, ay = t.y >> shift;
    const a = this.tiles.get(`${nz}/${ax}/${ay}`);
    if (!a?.night) { u.nightOn.value = 0; return; }
    const scale = 1 / 2 ** shift;
    u.nightTile.value = a.night;
    u.nightRect.value.set((t.x - (ax << shift)) * scale, (t.y - (ay << shift)) * scale, scale, scale);
    u.nightOn.value = 1;
  }

  load(t) {
    t.state = 'loading';
    this.loading++;
    this.loader.load(`/api/twtile/day/${t.z}/${t.x}/${t.y}.jpg`, (tex) => {
      this.loading--;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.buildMesh(t, tex);
      t.state = 'ready';
      t.shownAt = 0;
    }, undefined, () => {
      this.loading--;
      t.state = 'none';
      t.retryAt = performance.now() + RETRY_MS;
    });
  }

  dispose(t) {
    t.night?.dispose();
    t.night = null;
    t.nightState = 'none';
    t.mesh.geometry.dispose();
    t.mesh.material.uniforms.map.value.dispose();
    t.mesh.material.dispose();
    this.scene.remove(t.mesh);
    t.mesh = null;
    t.state = 'none';
  }

  hideAll() {
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    this.setCredit(false);
  }

  setCredit(on) {
    if (on !== this.creditShown) { this.creditShown = on; this.onCredit?.(on); }
  }

  // 每幀呼叫（太空俯瞰視角）
  update() {
    const cam = this.camera.position;
    if (!this.enabled) { this.hideAll(); return; }
    const pxScale = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.renderer.domElement.clientHeight);
    // 整個範圍的淡入淡出：看範圍中心附近每個螢幕像素有多大
    const nearKm = Math.max(cam.distanceTo(this.center) - 0.05, cam.length() - 1, 1e-4) * EARTH_KM;
    const fade = THREE.MathUtils.smoothstep(FADE_FROM_KM - nearKm * pxScale, 0, FADE_FROM_KM - FADE_FULL_KM);
    if (fade <= 0 || !this.material.uniforms.seaMask.value) { this.hideAll(); return; }
    // 夜晚燈光圖只有 2048 寬（約 20 km／像素），拉近時會變成一大團光暈，所以越近越淡
    this.material.uniforms.nightGain.value = THREE.MathUtils.clamp((nearKm * pxScale) / NIGHT_FULL_KM, 0.15, 1);

    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const now = performance.now();
    const needed = new Set();
    const visit = (z, x, y) => {
      const t = this.tile(z, x, y);
      if (!this.facing(t, cam)) return;
      needed.add(t);
      t.used = now;
      const km = Math.max(cam.distanceTo(t.sphere.center) - t.sphere.radius, cam.length() - 1, 1e-5) * EARTH_KM;
      if (z < this.config.maxZ && t.texelKm > km * pxScale) {
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) visit(z + 1, x * 2 + dx, y * 2 + dy);
      }
    };
    visit(0, 0, 0);

    let anyShown = false;
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const show = needed.has(t);
      t.mesh.visible = show;
      if (!show) continue;
      t.shownAt ||= now;
      t.mesh.material.uniforms.alpha.value = fade * Math.min(1, (now - t.shownAt) / FADE_IN_MS);
      this.applyNight(t);
      anyShown = true;
    }
    this.setCredit(anyShown);

    // 先載粗的，同一層先載離相機近的
    const todo = [...needed].filter((t) => t.state === 'none' && now >= t.retryAt)
      .sort((a, b) => a.z - b.z || cam.distanceTo(a.sphere.center) - cam.distanceTo(b.sphere.center));
    // 夜間圖塊最多 21 塊，先載，不然會被大量的白天圖塊擋住
    const nightTodo = [...needed]
      .filter((t) => t.z <= this.config.nightMaxZ && t.nightState === 'none' && now >= t.nightRetryAt && this.dark(t))
      .sort((a, b) => a.z - b.z);
    for (const t of nightTodo) {
      if (this.loading >= MAX_LOADING) break;
      this.loadNight(t);
    }
    for (const t of todo) {
      if (this.loading >= MAX_LOADING) break;
      this.load(t);
    }

    const ready = [...this.tiles.values()].filter((t) => t.state === 'ready');
    if (ready.length > MAX_TEXTURES) {
      ready.filter((t) => !needed.has(t) && t.z > 1).sort((a, b) => a.used - b.used)
        .slice(0, ready.length - MAX_TEXTURES).forEach((t) => this.dispose(t));
    }
  }
}
