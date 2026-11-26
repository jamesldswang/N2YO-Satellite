// 太陽和月亮。場景座標同 app.js：地球半徑 = 1、固定不轉、+X = 0°E、+Y = 北、−Z = 90°E。
// - 太陽：方向由 app.js 算（earthUniforms.sunDir），畫成發光 sprite，放在「鏡頭往太陽方向、接近遠裁切面」的地方：
//   真實距離（約 23,500 個地球半徑）超出遠裁切面；放在固定距離的話，拉遠時視差會讓方向偏掉。
//   算從台灣看的仰角、方位用真實距離的 sunPos，畫圖和標籤用 sunDrawPos。
// - 月亮：用天文年曆的低精度公式（誤差約 0.3°）算地心位置，放在真實距離（約 60 個地球半徑），
//   所以從台灣仰望看到的方向含視差，是真的。球面貼 three.js 範例的月球貼圖，亮面依太陽方向算，看得出月相。
//   太空俯瞰用真實比例（跟著拉遠縮小，最小 MOON_MIN_PX_SPACE 像素免得消失）；
//   台灣仰望時真實大小只有約 10 像素，放大到 MOON_MIN_PX_SKY 比較好找。
import * as THREE from 'three';

const DEG = Math.PI / 180;
const EARTH_KM = 6371;
const MOON_KM = 1737.4;
const AU = 149597870.7 / EARTH_KM; // 地日距離（地球半徑）
const MOON_ORBIT_POINTS = 360;
const SIDEREAL_MONTH_MS = 27.321661 * 86400e3;
const MOON_ORBIT_EVERY_MS = 6 * 3600e3; // 軌道線多久重算一次（軌道面會慢慢轉，月亮的距離也在變）
const SUN_PX = 110;      // 太陽光暈在畫面上的大小
const MOON_MIN_PX_SKY = 36;
const MOON_MIN_PX_SPACE = 4;

// 月亮地心位置：回傳 { lat, lng, dist }（dist 是地球半徑倍數）。
// 公式：The Astronomical Almanac 的 low-precision lunar coordinates。
// gmst（度）：給的話用這個地球角度換算經度（畫太空中固定的軌道線用），不給就用 ms 當時的
const gmstDeg = (ms) => 280.46061837 + 360.98564736629 * (ms / 86400000 + 2440587.5 - 2451545);
// 地心黃道經緯度（弧度）和距離（地球半徑）
export function moonEcliptic(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545; // 從 J2000 起的天數
  const T = d / 36525;
  const s = (a, b) => Math.sin((a + b * T) * DEG);
  const c = (a, b) => Math.cos((a + b * T) * DEG);
  const lon = (218.32 + 481267.881 * T
    + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) + 0.66 * s(235.7, 890534.22)
    + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03)) * DEG;
  const lat = (5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89)
    - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21)) * DEG;
  const parallax = (0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36)
    + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74)) * DEG;
  return { lon, lat, dist: 1 / Math.sin(parallax), d };
}

export function moonPosition(ms, gmst = gmstDeg(ms)) {
  const { lon, lat, dist, d } = moonEcliptic(ms);
  // 黃道 → 赤道
  const eps = (23.439 - 0.00000036 * d) * DEG;
  const x = Math.cos(lat) * Math.cos(lon);
  const y = Math.cos(eps) * Math.cos(lat) * Math.sin(lon) - Math.sin(eps) * Math.sin(lat);
  const z = Math.sin(eps) * Math.cos(lat) * Math.sin(lon) + Math.cos(eps) * Math.sin(lat);
  const ra = Math.atan2(y, x) / DEG;
  const dec = Math.asin(z) / DEG;
  return { lat: dec, lng: ra - gmst, dist };
}

function sphereVec(lat, lng, r, out) {
  const p = lat * DEG, l = lng * DEG;
  return out.set(r * Math.cos(p) * Math.cos(l), r * Math.sin(p), -r * Math.cos(p) * Math.sin(l));
}

// 月相名稱。elong：月亮在太陽東邊幾度（0–360，往東量）
export function phaseName(elong) {
  if (elong < 12 || elong > 348) return '新月';
  if (elong < 80) return '眉月';
  if (elong < 100) return '上弦月';
  if (elong < 168) return '盈凸月';
  if (elong < 192) return '滿月';
  if (elong < 260) return '虧凸月';
  if (elong < 280) return '下弦月';
  return '殘月';
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, 'rgba(255,250,225,1)');
  grad.addColorStop(0.2, 'rgba(255,225,140,0.55)');
  grad.addColorStop(0.45, 'rgba(255,190,80,0.15)');
  grad.addColorStop(1, 'rgba(255,160,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SunMoon {
  constructor(scene, texBase) {
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), sizeAttenuation: false, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.sun.visible = false;
    this.sun.renderOrder = -5;

    this.moonUniforms = {
      map: { value: null }, sunDir: { value: new THREE.Vector3(1, 0, 0) }, ready: { value: 0 },
    };
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(MOON_KM / EARTH_KM, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: this.moonUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv; varying vec3 vN;
          void main() {
            vUv = uv;
            vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map; uniform vec3 sunDir; uniform float ready;
          varying vec2 vUv; varying vec3 vN;
          void main() {
            vec3 albedo = ready > 0.5 ? texture2D(map, vUv).rgb : vec3(0.6);
            float lit = smoothstep(-0.03, 0.12, dot(normalize(vN), sunDir));
            // 暗面留一點地照，看得出月亮的輪廓
            gl_FragColor = vec4(min(albedo * (0.06 + 1.9 * lit), vec3(1.0)), 1.0);
          }`,
      }),
    );
    this.moon.visible = false;
    new THREE.TextureLoader().load(`${texBase}/moon_1024.jpg`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      this.moonUniforms.map.value = t;
      this.moonUniforms.ready.value = 1;
    });

    // 月球軌道線：一個恆星月（27.3 天）的位置，用同一個地球角度換算，畫出來是太空中閉合的軌道；
    // 之後每幀依地球多轉的角度旋轉（地球固定座標裡，軌道面一天繞地球轉一圈）
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOON_ORBIT_POINTS * 3), 3));
    this.orbit = new THREE.LineLoop(og, new THREE.LineBasicMaterial({
      color: 0x9fb4d0, transparent: true, opacity: 0.45, depthWrite: false,
    }));
    this.orbit.frustumCulled = false;
    this.orbit.visible = false;
    this.orbitAt = -Infinity;
    this.orbitGmst = 0;

    scene.add(this.sun, this.moon, this.orbit);
    this.sunOn = false;
    this.moonOn = false;
    this.sunPos = new THREE.Vector3();     // 真實距離，算仰角、方位用
    this.sunDrawPos = new THREE.Vector3(); // 實際畫的位置，標籤用
    this.moonPos = new THREE.Vector3();
    this.moonInfo = null; // { dist, illum, elong }
    this._x = new THREE.Vector3(); this._y = new THREE.Vector3(); this._z = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  // 每幀呼叫。sunDir：地心看太陽的單位向量；sky：是否台灣仰望視角
  update(ms, sunDir, camera, viewPx, sky = false) {
    const pxScale = (2 * Math.tan((camera.fov * DEG) / 2)) / Math.max(1, viewPx);
    this.sunPos.copy(sunDir).multiplyScalar(AU);
    this.sunDrawPos.copy(camera.position).addScaledVector(sunDir, camera.far * 0.7);
    this.sun.visible = this.sunOn;
    if (this.sunOn) {
      this.sun.position.copy(this.sunDrawPos);
      this.sun.scale.setScalar(SUN_PX / Math.max(1, viewPx));
    }

    const m = moonPosition(ms);
    sphereVec(m.lat, m.lng, m.dist, this.moonPos);
    const dir = this._x.copy(this.moonPos).normalize();
    const cos = THREE.MathUtils.clamp(dir.dot(sunDir), -1, 1);
    // 往東量的距角：太陽繞 +Y 轉正角度是往東（經度增加），所以叉積的 Y 分量 > 0 = 月亮在太陽東邊（盈）
    const east = this._y.crossVectors(sunDir, dir).y > 0;
    const angle = Math.acos(cos) / DEG;
    this.moonInfo = { dist: m.dist * EARTH_KM, illum: (1 - cos) / 2, elong: east ? angle : 360 - angle };

    this.moon.visible = this.orbit.visible = this.moonOn;
    if (!this.moonOn) return;
    this.updateOrbit(ms);
    this.moon.position.copy(this.moonPos);
    this.moonUniforms.sunDir.value.copy(sunDir);
    // 月球正面（貼圖中央，球的 +X）朝地球，北極大致朝 +Y
    const x = this._x.copy(this.moonPos).negate().normalize();
    const y = this._y.set(0, 1, 0).addScaledVector(x, -x.y).normalize();
    const z = this._z.crossVectors(x, y);
    this.moon.quaternion.setFromRotationMatrix(this._m.makeBasis(x, y, z));
    // 太小時放大到最小像素數（太空俯瞰幾乎是真實比例，和地球的大小比例才對）
    const dist = camera.position.distanceTo(this.moonPos);
    const px = (2 * MOON_KM) / EARTH_KM / dist / pxScale;
    this.moon.scale.setScalar(Math.max(1, (sky ? MOON_MIN_PX_SKY : MOON_MIN_PX_SPACE) / px));
  }

  updateOrbit(ms) {
    const g = gmstDeg(ms);
    if (Math.abs(ms - this.orbitAt) > MOON_ORBIT_EVERY_MS) {
      // 以現在為中心，前後各半個恆星月
      const pos = this.orbit.geometry.attributes.position;
      const v = this._x;
      for (let i = 0; i < MOON_ORBIT_POINTS; i++) {
        const t = ms + (i / MOON_ORBIT_POINTS - 0.5) * SIDEREAL_MONTH_MS;
        const m = moonPosition(t, g);
        sphereVec(m.lat, m.lng, m.dist, v);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true;
      this.orbitAt = ms;
      this.orbitGmst = g;
    }
    // 地球往東轉了 Δ → 太空中固定的軌道在地球座標裡往西轉 Δ（繞 +Y 轉負角度）
    this.orbit.rotation.y = -(g - this.orbitGmst) * DEG;
  }
}
