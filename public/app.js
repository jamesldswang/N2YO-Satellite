import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const sgp4 = window.satellite;

const TEX = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets';
const EARTH_KM = 6371;
const DEG = Math.PI / 180;
const DEFAULT_IDS = [25544, 48274, 20580, 42920, 43013, 41836];
const MAX_SATS = 20; // 20 × ~17 requests/h stays well under N2YO's 1000/h
const PATH_POINTS = 240;
const COLORS = ['#ffd166', '#6ec6ff', '#ff8fab', '#7ae582', '#c8a2ff', '#ffa45c', '#5eead4', '#f9a8d4', '#a3e635', '#93c5fd'];
const STORE_KEY = 'tracked-satellites';

// Scene frame: Earth radius = 1, fixed to the ground (+X = 0°E, +Y = north,
// -Z = 90°E), so API lat/lng map directly and Taiwan never moves.
function geoToVec(lat, lng, altKm, out = new THREE.Vector3()) {
  const r = 1 + altKm / EARTH_KM;
  const phi = lat * DEG, lam = lng * DEG;
  return out.set(r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam));
}

function subsolarPoint(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545;
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / DEG;
  const gmst = 280.46061837 + 360.98564736629 * d;
  return { lat: dec, lng: ra - gmst };
}

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const labelsEl = $('labels');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03050b);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 1.2;
controls.maxDistance = 18;

function placeholder(r, g, b) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}
const earthUniforms = {
  dayMap: { value: placeholder(22, 48, 84) },
  nightMap: { value: placeholder(0, 0, 0) },
  sunDir: { value: new THREE.Vector3(1, 0, 0) },
};
const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');
function loadInto(uniform, file) {
  loader.load(`${TEX}/${file}`, (tex) => {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    uniform.value = tex;
  }, undefined, () => console.warn(`無法載入地球貼圖 ${file}`));
}
loadInto(earthUniforms.dayMap, 'earth_atmos_2048.jpg');
loadInto(earthUniforms.nightMap, 'earth_lights_2048.png');

const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1, 128, 96),
  new THREE.ShaderMaterial({
    uniforms: earthUniforms,
    vertexShader: `
      varying vec2 vUv; varying vec3 vN;
      void main() { vUv = uv; vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D dayMap, nightMap; uniform vec3 sunDir;
      varying vec2 vUv; varying vec3 vN;
      void main() {
        float d = dot(normalize(vN), sunDir);
        vec3 day = texture2D(dayMap, vUv).rgb * (0.3 + 0.85 * max(d, 0.0));
        vec3 night = texture2D(dayMap, vUv).rgb * 0.13 + texture2D(nightMap, vUv).rgb;
        gl_FragColor = vec4(mix(night, day, smoothstep(-0.1, 0.12, d)), 1.0);
      }`,
  }),
);
scene.add(earth);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.06, 96, 64),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; void main() { vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vN; void main() { float i = pow(clamp(-vN.z / 0.33, 0.0, 1.0), 2.5); gl_FragColor = vec4(0.35, 0.62, 1.0, i * 0.75); }`,
  }),
);
scene.add(atmosphere);

// Purely decorative backdrop, so it is hidden in the sky view where it could
// be mistaken for the real star field above Taiwan.
const stars = (() => {
  const pts = new Float32Array(6000);
  const v = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += 3) {
    v.randomDirection().multiplyScalar(120).toArray(pts, i);
  }
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaab7cc, size: 1.3, sizeAttenuation: false }));
})();
scene.add(stars);

let observer = { name: '台灣', lat: 23.6978, lng: 120.9605 };
const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3();
const taiwanGroup = new THREE.Group();
const skyGrid = new THREE.Group();
skyGrid.visible = false;
scene.add(taiwanGroup, skyGrid);

function skyDirection(az, el, out = new THREE.Vector3()) {
  const a = az * DEG, e = el * DEG;
  return out.copy(east).multiplyScalar(Math.sin(a) * Math.cos(e))
    .addScaledVector(north, Math.cos(a) * Math.cos(e))
    .addScaledVector(up, Math.sin(e));
}

// Simplified coastline, for orientation only.
const TAIWAN_OUTLINE = [
  [25.30, 121.56], [25.13, 121.92], [24.85, 121.83], [24.55, 121.87], [24.00, 121.62], [23.45, 121.48],
  [22.80, 121.18], [22.35, 120.90], [21.90, 120.85], [22.05, 120.70], [22.48, 120.45], [22.65, 120.26],
  [23.05, 120.08], [23.55, 120.12], [24.15, 120.47], [24.65, 120.75], [25.00, 121.03], [25.20, 121.30], [25.30, 121.56],
];

function line(points, color, opacity = 1) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
}

function buildObserver() {
  geoToVec(observer.lat, observer.lng, 0, up).normalize();
  const lam = observer.lng * DEG;
  east.set(-Math.sin(lam), 0, -Math.cos(lam));
  north.crossVectors(up, east);

  taiwanGroup.add(line(TAIWAN_OUTLINE.map(([la, ln]) => geoToVec(la, ln, 3)), 0xffd166));

  const R = 30;
  const P = up.clone().multiplyScalar(1.0015);
  const at = (az, el) => P.clone().addScaledVector(skyDirection(az, el), R);
  for (const el of [0, 30, 60]) {
    const ring = [];
    for (let az = 0; az <= 360; az += 3) ring.push(at(az, el));
    skyGrid.add(line(ring, el === 0 ? 0xffd166 : 0x8fa6c4, el === 0 ? 0.9 : 0.3));
  }
  for (let az = 0; az < 360; az += 45) {
    const arc = [];
    for (let el = 0; el <= 90; el += 3) arc.push(at(az, el));
    skyGrid.add(line(arc, 0x8fa6c4, 0.22));
  }
}

const dotTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,.28)';
  g.beginPath(); g.arc(32, 32, 31, 0, 7); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(32, 32, 15, 0, 7); g.fill();
  return new THREE.CanvasTexture(c);
})();

const sats = new Map();
let selectedId = null;
let view = 'space';
let polling = false;

function makeLabel(className, text) {
  const el = document.createElement('div');
  el.className = `label ${className}`;
  el.textContent = text;
  el.style.display = 'none';
  labelsEl.append(el);
  return el;
}

function createSat(id) {
  const used = new Set([...sats.values()].map((s) => s.colorIndex));
  let colorIndex = 0;
  while (used.has(colorIndex) && colorIndex < COLORS.length - 1) colorIndex++;
  const color = new THREE.Color(COLORS[colorIndex]);

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture, color, sizeAttenuation: false, transparent: true }));
  sprite.visible = false;

  const pathGeo = new THREE.BufferGeometry();
  pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_POINTS * 3), 3));
  pathGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PATH_POINTS * 3), 3));
  pathGeo.setDrawRange(0, 0);
  const path = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  path.frustumCulled = false;

  const link = line([new THREE.Vector3(), new THREE.Vector3()], color, 0.65);
  link.frustumCulled = false;
  link.visible = false;

  scene.add(sprite, path, link);

  const label = makeLabel('', `#${id}`);
  label.addEventListener('click', () => select(id));

  const s = {
    id, colorIndex, color, sprite, path, link, label,
    name: `#${id}`, samples: [], satrec: null, state: null, error: null,
    busy: false, nextFetch: 0, nextTle: 0, nextPath: 0, row: null,
    pos: new THREE.Vector3(),
  };
  s.row = makeRow(s);
  sats.set(id, s);
  return s;
}

function removeSat(s) {
  scene.remove(s.sprite, s.path, s.link);
  s.sprite.material.dispose();
  s.path.geometry.dispose(); s.path.material.dispose();
  s.link.geometry.dispose(); s.link.material.dispose();
  s.label.remove();
  s.row.el.remove();
  sats.delete(s.id);
  if (selectedId === s.id) select(null);
  saveIds();
  renderCount();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, body.error || `HTTP ${res.status}`);
  return body;
}

async function loadPositions(s, now) {
  s.busy = true;
  try {
    const data = await api(`/api/positions/${s.id}`);
    if (!sats.has(s.id)) return;
    s.samples = data.positions;
    s.error = null;
    s.nextFetch = Math.max(now + 15, data.positions[data.positions.length - 1].t - 90);
    if (s.name !== data.satname) {
      s.name = data.satname;
      s.label.textContent = s.name;
      s.row.name.textContent = s.name;
      s.row.name.title = `${s.name}（NORAD ${s.id}）`;
    }
    if (data.transactions != null) {
      $('quota').textContent = `N2YO 位置查詢：最近 60 分鐘 ${data.transactions} / 1000 次`;
    }
  } catch (err) {
    s.error = err.message;
    s.nextFetch = now + (err.status === 404 ? 600 : 60);
    if (err.status === 401) { polling = false; showKeyNotice(err.message); }
  } finally {
    s.busy = false;
  }
}

async function loadTle(s, now) {
  s.nextTle = now + 600; // retry interval; replaced on success
  try {
    const { line1, line2 } = await api(`/api/tle/${s.id}`);
    if (!sats.has(s.id)) return;
    s.satrec = sgp4.twoline2satrec(line1, line2);
    s.nextTle = now + 6 * 3600;
    s.nextPath = 0;
  } catch { /* the orbit line is optional; the live position still works */ }
}

function poll() {
  if (!polling) return;
  const now = Date.now() / 1000;
  for (const s of sats.values()) {
    if (!s.busy && now >= s.nextFetch) loadPositions(s, now);
    if (now >= s.nextTle) loadTle(s, now);
  }
}

function sampleAt(samples, now) {
  if (!samples.length) return null;
  const first = samples[0], last = samples[samples.length - 1];
  if (now < first.t) return now > first.t - 10 ? first : null;
  if (now > last.t) return null;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= now) lo = mid; else hi = mid;
  }
  return [samples[lo], samples[hi]];
}

const va = new THREE.Vector3(), vb = new THREE.Vector3();
function updateSat(s, now) {
  const found = sampleAt(s.samples, now);
  if (!found) {
    s.state = null;
    s.sprite.visible = s.link.visible = false;
    return;
  }
  const [a, b] = Array.isArray(found) ? found : [found, found];
  const f = b.t > a.t ? (now - a.t) / (b.t - a.t) : 0;
  const alt = a.alt + (b.alt - a.alt) * f;
  // Interpolate in 3D so the ±180° longitude seam needs no special case.
  geoToVec(a.lat, a.lng, a.alt, va);
  geoToVec(b.lat, b.lng, b.alt, vb);
  s.pos.copy(va).lerp(vb, f);
  const dAz = ((b.az - a.az + 540) % 360) - 180;
  s.state = {
    alt, lat: a.lat, lng: a.lng,
    az: (a.az + dAz * f + 360) % 360,
    el: a.el + (b.el - a.el) * f,
  };

  s.sprite.position.copy(s.pos);
  s.sprite.scale.setScalar(s.id === selectedId ? 0.036 : 0.022);
  s.sprite.visible = true;

  const showLink = view === 'space' && s.state.el > 0;
  s.link.visible = showLink;
  if (showLink) {
    const p = s.link.geometry.attributes.position;
    p.setXYZ(0, up.x, up.y, up.z);
    p.setXYZ(1, s.pos.x, s.pos.y, s.pos.z);
    p.needsUpdate = true;
  }
}

const pathPoint = new THREE.Vector3();
function updatePath(s, nowMs) {
  if (!s.satrec) return;
  const period = (2 * Math.PI) / s.satrec.no; // minutes
  const start = -0.15 * period, span = 1.15 * period;
  const pos = s.path.geometry.attributes.position;
  const col = s.path.geometry.attributes.color;
  let n = 0;
  for (let i = 0; i < PATH_POINTS; i++) {
    const offset = start + (span * i) / (PATH_POINTS - 1);
    const date = new Date(nowMs + offset * 60000);
    const pv = sgp4.propagate(s.satrec, date);
    if (!pv || !pv.position) continue;
    const g = sgp4.eciToGeodetic(pv.position, sgp4.gstime(date));
    geoToVec(g.latitude / DEG, g.longitude / DEG, g.height, pathPoint);
    pos.setXYZ(n, pathPoint.x, pathPoint.y, pathPoint.z);
    const fade = offset < 0 ? 0.55 * (1 + offset / (0.15 * period)) + 0.1 : 0.75 - 0.55 * (offset / period);
    col.setXYZ(n, s.color.r * fade, s.color.g * fade, s.color.b * fade);
    n++;
  }
  s.path.geometry.setDrawRange(0, n);
  pos.needsUpdate = col.needsUpdate = true;
}

const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
const compassName = (az) => COMPASS[Math.round(az / 45) % 8];

function makeRow(s) {
  const el = document.createElement('li');
  el.className = 'row';
  el.tabIndex = 0;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = COLORS[s.colorIndex];
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  const elev = document.createElement('span');
  elev.className = 'elev';
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.type = 'button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', '移除');
  remove.addEventListener('click', (e) => { e.stopPropagation(); removeSat(s); });
  const sub = document.createElement('span');
  sub.className = 'sub';
  el.append(dot, name, elev, remove, sub);
  el.addEventListener('click', () => select(s.id));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(s.id); });
  $('list').append(el);
  return { el, name, elev, sub };
}

function refreshList() {
  const elOf = (s) => (s.state ? s.state.el : -999);
  const ordered = [...sats.values()].sort((a, b) => elOf(b) - elOf(a));
  ordered.forEach((s, i) => {
    const { el, elev, sub } = s.row;
    if ($('list').children[i] !== el) $('list').insertBefore(el, $('list').children[i]);
    if (s.state) {
      const { el: e, az, alt, lat, lng } = s.state;
      elev.textContent = `${e >= 0 ? '+' : '−'}${Math.abs(e).toFixed(1)}°`;
      elev.classList.toggle('up', e > 0);
      const detail = s.id === selectedId ? ` · ${lat.toFixed(2)}°, ${lng.toFixed(2)}°` : '';
      sub.textContent = `高度 ${Math.round(alt).toLocaleString()} km · 方位 ${az.toFixed(0)}° ${compassName(az)}${detail}`;
    } else {
      elev.textContent = '';
      elev.classList.remove('up');
      sub.textContent = s.error ? s.error : s.samples.length ? '資料已過期，等待更新' : '載入中…';
    }
    sub.classList.toggle('err', !s.state && Boolean(s.error));
  });
}

function renderCount() {
  $('count').textContent = `${sats.size} / ${MAX_SATS}，依仰角排序`;
}

function select(id) {
  selectedId = selectedId === id ? null : id;
  for (const s of sats.values()) {
    const on = s.id === selectedId;
    s.label.classList.toggle('selected', on);
    s.row.el.classList.toggle('selected', on);
    s.path.material.opacity = selectedId === null || on ? 1 : 0.3;
  }
  const s = sats.get(selectedId);
  if (s?.state) {
    if (view === 'sky') {
      lookAz = s.state.az;
      lookEl = THREE.MathUtils.clamp(s.state.el, -5, 85);
    } else {
      // High orbits can sit behind or beside the home camera; frame Taiwan and the satellite together.
      ndc.copy(s.pos).project(camera);
      if (ndc.z >= 1 || Math.abs(ndc.x) > 0.9 || Math.abs(ndc.y) > 0.9) {
        const r = s.pos.length();
        camera.position.copy(up).add(va.copy(s.pos).normalize()).setLength(Math.min(r * 2.6, controls.maxDistance));
      }
    }
  }
  refreshList();
}

function saveIds() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...sats.keys()])); } catch { /* optional */ }
}
function loadIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(ids) && ids.every(Number.isInteger)) return ids.slice(0, MAX_SATS);
  } catch { /* use defaults */ }
  return DEFAULT_IDS;
}

$('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('add-id');
  const id = Number(input.value);
  if (!Number.isInteger(id) || id <= 0 || sats.has(id) || sats.size >= MAX_SATS) {
    input.setCustomValidity(sats.has(id) ? '已在清單中' : sats.size >= MAX_SATS ? `最多 ${MAX_SATS} 顆` : '請輸入 NORAD 編號');
    input.reportValidity();
    return;
  }
  createSat(id);
  input.value = '';
  saveIds();
  renderCount();
  poll();
});
$('add-id').addEventListener('input', (e) => e.target.setCustomValidity(''));

// Views
const HOME_LOOK_EL = 28;
let lookAz = 180, lookEl = HOME_LOOK_EL;
let savedSpacePos = null;
const compassLabels = [];
let taiwanLabel;

function homeSpace() {
  camera.position.copy(up).multiplyScalar(3.4);
  controls.target.set(0, 0, 0);
  controls.update();
}

function setView(next) {
  if (view === 'space' && next === 'sky') savedSpacePos = camera.position.clone();
  view = next;
  const space = view === 'space';
  controls.enabled = space;
  atmosphere.visible = stars.visible = taiwanGroup.visible = space;
  skyGrid.visible = !space;
  camera.near = space ? 0.05 : 0.0005;
  camera.fov = space ? 45 : 70;
  camera.updateProjectionMatrix();
  if (space) {
    camera.up.set(0, 1, 0);
    camera.position.copy(savedSpacePos ?? up.clone().multiplyScalar(3.4));
    controls.update();
  } else {
    camera.up.copy(up);
    camera.position.copy(up).multiplyScalar(1.0015);
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  updateHint();
}

function updateHint() {
  let text = '拖曳旋轉・滾輪縮放・彩色直線連接台灣與地平線上的衛星・點選清單可標示軌道';
  if (view === 'sky') {
    const known = [...sats.values()].filter((s) => s.state);
    text = known.length && !known.some((s) => s.state.el > 0)
      ? '目前清單中沒有衛星在台灣的地平線上'
      : '拖曳轉動視線・滾輪縮放・黃色圓為地平線，淺色圓為仰角 30°、60°・點選清單可對準衛星';
  }
  if ($('hint').textContent !== text) $('hint').textContent = text;
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view !== view) setView(b.dataset.view);
}));
$('reset').addEventListener('click', () => {
  if (view === 'space') homeSpace();
  else { lookAz = 180; lookEl = HOME_LOOK_EL; camera.fov = 70; camera.updateProjectionMatrix(); }
});

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (view !== 'sky') return;
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const k = camera.fov / canvas.clientHeight;
  lookAz = (lookAz - (e.clientX - drag.x) * k + 360) % 360;
  lookEl = THREE.MathUtils.clamp(lookEl + (e.clientY - drag.y) * k, -5, 85);
  drag = { x: e.clientX, y: e.clientY };
});
const endDrag = () => { drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  if (view !== 'sky') return;
  e.preventDefault();
  camera.fov = THREE.MathUtils.clamp(camera.fov * (e.deltaY > 0 ? 1.08 : 0.92), 20, 100);
  camera.updateProjectionMatrix();
}, { passive: false });

const lookDir = new THREE.Vector3(), lookTarget = new THREE.Vector3();
function aimSky() {
  skyDirection(lookAz, lookEl, lookDir);
  camera.lookAt(lookTarget.copy(camera.position).add(lookDir));
}

// HTML labels
const ndc = new THREE.Vector3();
function placeLabel(el, world, visible) {
  if (visible) {
    ndc.copy(world).project(camera);
    visible = ndc.z < 1 && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05;
  }
  el.style.display = visible ? '' : 'none';
  if (visible) {
    const x = ((ndc.x + 1) / 2) * canvas.clientWidth;
    const y = ((1 - ndc.y) / 2) * canvas.clientHeight;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

const ray = new THREE.Vector3();
function hiddenByEarth(point) {
  const C = camera.position;
  ray.copy(point).sub(C);
  const dist = ray.length();
  ray.divideScalar(dist);
  const b = C.dot(ray);
  const disc = b * b - (C.lengthSq() - 1);
  if (disc <= 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < dist;
}

function updateLabels() {
  for (const s of sats.values()) {
    const shown = s.state && (view === 'space' ? !hiddenByEarth(s.pos) : s.state.el > 0);
    placeLabel(s.label, s.pos, Boolean(shown));
  }
  for (const { el, world } of compassLabels) placeLabel(el, world, view === 'sky');
  placeLabel(taiwanLabel, up, view === 'space' && !hiddenByEarth(up.clone().multiplyScalar(1.001)));
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function tickSlow() {
  const nowMs = Date.now();
  const sun = subsolarPoint(nowMs);
  geoToVec(sun.lat, sun.lng, 0, earthUniforms.sunDir.value).normalize();
  $('clock').textContent = new Date(nowMs).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const s of sats.values()) {
    if (nowMs >= s.nextPath) { updatePath(s, nowMs); s.nextPath = nowMs + 30000; }
  }
  refreshList();
  updateHint();
  poll();
}

function frame() {
  const now = Date.now() / 1000;
  for (const s of sats.values()) updateSat(s, now);
  if (view === 'space') controls.update(); else aimSky();
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function showKeyNotice(reason) {
  const n = $('notice');
  n.hidden = false;
  n.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = reason;
  const p1 = document.createElement('p');
  p1.append('到 ');
  const a = document.createElement('a');
  a.href = 'https://www.n2yo.com/api/';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'n2yo.com/api';
  p1.append(a, ' 註冊並取得 API Key，在 satellite-tracker 資料夾建立 .env 檔：');
  const code = document.createElement('code');
  code.textContent = 'N2YO_API_KEY=你的金鑰';
  const p2 = document.createElement('p');
  p2.textContent = '然後重新執行 node server.js，再重新整理此頁。';
  n.append(h, p1, code, p2);
}

async function start() {
  const config = await api('/api/config');
  observer = config.observer;
  buildObserver();
  taiwanLabel = makeLabel('place', observer.name);
  for (const [text, az] of [['北', 0], ['東', 90], ['南', 180], ['西', 270]]) {
    compassLabels.push({
      el: makeLabel('compass', text),
      world: up.clone().multiplyScalar(1.0015).addScaledVector(skyDirection(az, 3), 30),
    });
  }
  resize();
  homeSpace();
  savedSpacePos = camera.position.clone();
  setView(new URLSearchParams(location.search).get('view') === 'sky' ? 'sky' : 'space');

  loadIds().forEach(createSat);
  renderCount();
  polling = config.hasKey;
  if (!config.hasKey) showKeyNotice('尚未設定 N2YO API Key');
  tickSlow();
  setInterval(tickSlow, 1000);
  frame();
}

start().catch((err) => {
  console.error(err);
  const n = $('notice');
  n.hidden = false;
  n.textContent = `啟動失敗：${err.message}`;
});
