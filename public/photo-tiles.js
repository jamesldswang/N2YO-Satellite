import * as THREE from 'three';

// 台灣航照（內政部國土測繪中心 NLSC 正射影像 PHOTO2，WMTS GoogleMapsCompatible，256 px JPEG）。
// 拉近到每個螢幕像素小於約 20 m（比 Sentinel-2 細）時才出現，畫在 TaiwanTiles 上面，
// z MIN_Z（約 19 m／像素）到 MAX_Z（約 0.3 m／像素，看得到房子）。
// 伺服器有 CORS *，瀏覽器直接抓，不經過 server.js。
// 外海用 TaiwanTiles 的外海遮罩擋掉（NLSC 海上是空白圖塊）。

const EARTH_KM = 6371;
const URL = (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`;
export const PHOTO_CREDIT = '航照：內政部國土測繪中心（政府資料開放授權條款第 1 版）';
export const PHOTO_CREDIT_URL = 'https://maps.nlsc.gov.tw/';
const MIN_Z = 13, MAX_Z = 19, PX = 256;
const SEG = 8;
const MAX_TEXTURES = 300;  // 256² 含 mipmap 約 350 KB
const MAX_LOADING = 6;
const RETRY_MS = 30e3;
const FADE_IN_MS = 300;
// 每螢幕像素幾公里時淡入（z13 約 0.019 km／像素）
const FADE_FROM_KM = 0.025, FADE_FULL_KM = 0.015;
const PHOTO_MIN_LIGHT = 0.85; // 航照最暗只到原本亮度的幾成（不跟著日夜變得太暗）

const tileLng = (x, n) => (x / n) * 360 - 180;
const tileLat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180 / Math.PI;

export class PhotoTiles {
  // bounds：{ west, south, size }（和 TaiwanTiles 同一個範圍，外海遮罩也對應它）；seaMask：TaiwanTiles 的 uniform
  constructor({ scene, camera, renderer, geoToVec, earthUniforms, shadeGlsl, bounds, seaMask, onCredit }) {
    Object.assign(this, { scene, camera, renderer, geoToVec, bounds, onCredit });
    this.tiles = new Map();
    this.loading = 0;
    this.creditShown = false;
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
    this.frustum = new THREE.Frustum();
    this.projView = new THREE.Matrix4();
    const { west, south, size } = bounds;
    this.center = geoToVec(south + size / 2, west + size / 2, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        nightMap: earthUniforms.nightMap,
        sunDir: earthUniforms.sunDir,
        seaMask,
        bounds: { value: new THREE.Vector4(west, south, west + size, south + size) },
        alpha: { value: 1 },
      },
      // 頂點座標相對於圖塊中心（mesh.position），拉到幾百公尺高時 float32 才不會抖
      vertexShader: `
        attribute vec2 ll; varying vec2 vUv, vLL; varying vec3 vN;
        void main() {
          vUv = uv; vLL = ll;
          vN = normalize((modelMatrix * vec4(position, 1.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D map, nightMap, seaMask; uniform vec3 sunDir; uniform vec4 bounds; uniform float alpha;
        varying vec2 vUv, vLL; varying vec3 vN;
        ${shadeGlsl}
        void main() {
          float sea = texture2D(seaMask, (vLL - bounds.xy) / (bounds.zw - bounds.xy)).r;
          vec2 euv = vec2((vLL.x + 180.0) / 360.0, (vLL.y + 90.0) / 180.0);
          vec3 lights = texture2D(nightMap, euv).rgb * 0.15 + vec3(0.031, 0.031, 0.063);
          // 拉這麼近是要看房子：晚上、太陽很低時也至少保留航照原本亮度的 PHOTO_MIN_LIGHT
          vec3 photo = texture2D(map, vUv).rgb;
          vec3 col = max(shade(photo, lights, normalize(vN)), photo * ${PHOTO_MIN_LIGHT.toFixed(2)});
          gl_FragColor = vec4(col, alpha * (1.0 - sea));
        }`,
      transparent: true,
      depthWrite: false,
    });
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) return t;
    const n = 2 ** z;
    const w = tileLng(x, n), e = tileLng(x + 1, n), north = tileLat(y, n), s = tileLat(y + 1, n);
    const pts = [];
    for (const la of [s, (s + north) / 2, north]) for (const ln of [w, (w + e) / 2, e]) pts.push(this.geoToVec(la, ln, 0));
    const center = pts[4];
    const sphere = new THREE.Sphere(center, Math.max(...pts.map((p) => p.distanceTo(center))));
    const widthKm = (e - w) * 111.32 * Math.cos(((s + north) / 2) * Math.PI / 180);
    t = { key, z, x, y, w, e, s, n: north, pts, sphere, texelKm: widthKm / PX, state: 'none', retryAt: 0, used: 0, mesh: null, shownAt: 0 };
    this.tiles.set(key, t);
    return t;
  }

  inBounds(t) {
    const { west, south, size } = this.bounds;
    return t.e > west && t.w < west + size && t.n > south && t.s < south + size;
  }

  // 大圖塊（z < MIN_Z，只用來往下找）只看視錐；能載入的圖塊再看是否有點在地平線上
  facing(t, cam) {
    if (!this.frustum.intersectsSphere(t.sphere)) return false;
    return t.z < MIN_Z || t.pts.some((p) => p.dot(cam) > 1);
  }

  buildMesh(t, tex) {
    const k1 = SEG + 1;
    const pos = new Float32Array(k1 * k1 * 3), uv = new Float32Array(k1 * k1 * 2), ll = new Float32Array(k1 * k1 * 2);
    const v = new THREE.Vector3(), c = t.sphere.center, n = 2 ** t.z;
    for (let j = 0; j < k1; j++) {
      for (let i = 0; i < k1; i++) {
        const k = j * k1 + i;
        // 麥卡托：圖塊內 y 是等距的，緯度不是，所以每個頂點用自己的 y 算緯度，貼圖座標才是線性的
        const lat = tileLat(t.y + 1 - j / SEG, n), lng = t.w + ((t.e - t.w) * i) / SEG;
        this.geoToVec(lat, lng, 0, v).sub(c).toArray(pos, k * 3);
        uv[k * 2] = i / SEG; uv[k * 2 + 1] = j / SEG;
        ll[k * 2] = lng; ll[k * 2 + 1] = lat;
      }
    }
    const index = [];
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * k1 + i, b = a + 1, cc = a + k1, d = cc + 1;
        index.push(a, b, d, a, d, cc);
      }
    }
    const geo = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.BufferAttribute(pos, 3))
      .setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      .setAttribute('ll', new THREE.BufferAttribute(ll, 2))
      .setIndex(index);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.sphere.radius);
    const mat = this.material.clone();
    for (const name of ['nightMap', 'sunDir', 'seaMask', 'bounds']) mat.uniforms[name] = this.material.uniforms[name];
    mat.uniforms.map.value = tex;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(c);
    mesh.renderOrder = -13 + (t.z - MIN_Z); // 在 TaiwanTiles（-20～-14）之後、太陽（-5）之前；細的後畫
    mesh.visible = false;
    this.scene.add(mesh);
    t.mesh = mesh;
  }

  load(t) {
    t.state = 'loading';
    this.loading++;
    this.loader.load(URL(t.z, t.x, t.y), (tex) => {
      this.loading--;
      tex.colorSpace = THREE.NoColorSpace; // 和 TaiwanTiles 一樣直接取原始顏色
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
    if (!this.material.uniforms.seaMask.value) { this.hideAll(); return; }
    const pxScale = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.renderer.domElement.clientHeight);
    // 鏡頭正下方的地面每像素多大（大致在範圍內才有意義，範圍外 inBounds 會擋掉）
    const altKm = Math.max(cam.length() - 1, 1e-6) * EARTH_KM;
    const fade = THREE.MathUtils.smoothstep(FADE_FROM_KM - altKm * pxScale, 0, FADE_FROM_KM - FADE_FULL_KM);
    if (fade <= 0) { this.hideAll(); return; }

    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const now = performance.now();
    const needed = new Set();
    const visit = (z, x, y) => {
      const t = this.tile(z, x, y);
      if (!this.inBounds(t) || !this.facing(t, cam)) return;
      const km = Math.max(cam.distanceTo(t.sphere.center) - t.sphere.radius, cam.length() - 1, 1e-6) * EARTH_KM;
      if (z >= MIN_Z) {
        // 太遠、一個貼圖像素比螢幕像素小很多的圖塊不載（只在畫面邊緣斜看時發生）
        if (t.texelKm * 4 < km * pxScale) return;
        needed.add(t);
        t.used = now;
      }
      if (z < MIN_Z || (z < MAX_Z && t.texelKm > km * pxScale)) {
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
      anyShown = true;
    }
    this.setCredit(anyShown);

    // 先載粗的（很快就有東西看），同一層先載離相機近的
    const todo = [...needed].filter((t) => t.state === 'none' && now >= t.retryAt)
      .sort((a, b) => a.z - b.z || cam.distanceTo(a.sphere.center) - cam.distanceTo(b.sphere.center));
    for (const t of todo) {
      if (this.loading >= MAX_LOADING) break;
      this.load(t);
    }

    const ready = [...this.tiles.values()].filter((t) => t.state === 'ready');
    if (ready.length > MAX_TEXTURES) {
      ready.filter((t) => !needed.has(t)).sort((a, b) => a.used - b.used)
        .slice(0, ready.length - MAX_TEXTURES).forEach((t) => this.dispose(t));
    }
  }
}
