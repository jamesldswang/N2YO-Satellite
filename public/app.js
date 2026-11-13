import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeSatModel, modelKind, setModelLit, disposeModel } from './models.js';
import { StarlinkLayer } from './starlink.js';
import { CloudLayer } from './clouds.js';

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

// Simulation clock. null = live: real time, positions from N2YO samples.
// While simulating, positions come from SGP4 on the TLE instead, so running
// at up to 200× costs no extra API requests.
let sim = null;
function clockMs() {
  return sim ? sim.fromSim + (Date.now() - sim.fromReal) * sim.speed : Date.now();
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
let observerGd = null; // satellite.js form of observer (radians, km)
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

// Colour ring around each model, so the list colours still match and a
// satellite stays findable when its model is only a few pixels wide.
const ringTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff';
  g.lineWidth = 4;
  g.beginPath(); g.arc(32, 32, 27, 0, 7); g.stroke();
  return new THREE.CanvasTexture(c);
})();

// Lights for the satellite models only; the Earth uses its own shader.
const sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
scene.add(sunLight, new THREE.AmbientLight(0xffffff, 0.55));

const MODEL_PX = 40, MODEL_PX_SELECTED = 60; // on-screen size of a model (longest side)
const RING_MIN_PX = 16;

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

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTexture, color, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false,
  }));
  sprite.visible = false;
  const model = makeSatModel(modelKind(id, null));
  model.visible = false;

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

  scene.add(sprite, model, path, link);

  const label = makeLabel('', `#${id}`);
  label.addEventListener('click', () => select(id));

  const s = {
    id, colorIndex, color, sprite, model, path, link, label,
    lastPos: new THREE.Vector3(), forward: new THREE.Vector3(),
    name: `#${id}`, samples: [], satrec: null, state: null, error: null,
    busy: false, nextFetch: 0, nextTle: 0, pathAt: -Infinity, row: null,
    pos: new THREE.Vector3(),
  };
  s.row = makeRow(s);
  sats.set(id, s);
  markPassesDirty();
  return s;
}

function removeSat(s) {
  scene.remove(s.sprite, s.model, s.path, s.link);
  s.sprite.material.dispose();
  disposeModel(s.model);
  s.path.geometry.dispose(); s.path.material.dispose();
  s.link.geometry.dispose(); s.link.material.dispose();
  s.label.remove();
  s.row.el.remove();
  sats.delete(s.id);
  markPassesDirty();
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
    s.tle = { line1, line2 };
    const kind = modelKind(s.id, s.satrec);
    if (kind !== s.model.userData.kind) { // e.g. an added satellite turns out to be geostationary
      scene.remove(s.model);
      disposeModel(s.model);
      s.model = makeSatModel(kind);
      s.model.visible = false;
      scene.add(s.model);
    }
    s.nextTle = now + 6 * 3600;
    s.pathAt = -Infinity;
    markPassesDirty();
  } catch { /* the orbit line is optional; the live position still works */ }
}

function poll() {
  if (!polling) return;
  const now = Date.now() / 1000;
  for (const s of sats.values()) {
    if (!sim && !s.busy && now >= s.nextFetch) loadPositions(s, now);
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
function stateFromSamples(s, now) {
  const found = sampleAt(s.samples, now);
  if (!found) return null;
  const [a, b] = Array.isArray(found) ? found : [found, found];
  const f = b.t > a.t ? (now - a.t) / (b.t - a.t) : 0;
  // Interpolate in 3D so the ±180° longitude seam needs no special case.
  geoToVec(a.lat, a.lng, a.alt, va);
  geoToVec(b.lat, b.lng, b.alt, vb);
  s.pos.copy(va).lerp(vb, f);
  const dAz = ((b.az - a.az + 540) % 360) - 180;
  return {
    alt: a.alt + (b.alt - a.alt) * f, lat: a.lat, lng: a.lng,
    az: (a.az + dAz * f + 360) % 360,
    el: a.el + (b.el - a.el) * f,
  };
}

function stateFromTle(s, ms) {
  if (!s.satrec || !observerGd) return null;
  const date = new Date(ms);
  const pv = sgp4.propagate(s.satrec, date);
  if (!pv || !pv.position) return null;
  const gmst = sgp4.gstime(date);
  const g = sgp4.eciToGeodetic(pv.position, gmst);
  const look = sgp4.ecfToLookAngles(observerGd, sgp4.eciToEcf(pv.position, gmst));
  const lat = g.latitude / DEG, lng = g.longitude / DEG;
  geoToVec(lat, lng, g.height, s.pos);
  return { alt: g.height, lat, lng, az: ((look.azimuth / DEG) + 360) % 360, el: look.elevation / DEG };
}

function updateSat(s, ms) {
  s.state = sim ? stateFromTle(s, ms) : stateFromSamples(s, ms / 1000);
  if (!s.state) {
    s.sprite.visible = s.model.visible = s.link.visible = false;
    return;
  }

  const selected = s.id === selectedId;
  const modelPx = placeModel(s, selected);
  s.sprite.position.copy(s.pos);
  // sizeAttenuation:false sprites are scaled in fractions of the viewport height.
  s.sprite.scale.setScalar((Math.max(modelPx * 1.25, RING_MIN_PX)) / canvas.clientHeight);
  s.sprite.material.opacity = selected ? 1 : 0.6;
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

// Orient the model like a real satellite (bottom toward Earth, nose along its
// motion) and size it to a fixed number of pixels, since at true scale even
// the ISS would be far smaller than a pixel.
const mUp = new THREE.Vector3(), mRight = new THREE.Vector3(), mFwd = new THREE.Vector3(), mBasis = new THREE.Matrix4();
function placeModel(s, selected) {
  const m = s.model;
  m.position.copy(s.pos);
  mUp.copy(s.pos).normalize();
  mFwd.copy(s.pos).sub(s.lastPos);
  if (mFwd.lengthSq() > 1e-11 && mFwd.lengthSq() < 0.01) s.forward.copy(mFwd); // ignore jumps (sim seek)
  s.lastPos.copy(s.pos);
  mFwd.copy(s.forward).addScaledVector(mUp, -s.forward.dot(mUp));
  if (mFwd.lengthSq() < 1e-14) {
    // Not moving relative to the ground (geostationary) or no history yet: face east.
    const lam = Math.atan2(-s.pos.z, s.pos.x);
    mFwd.set(-Math.sin(lam), 0, -Math.cos(lam));
  }
  mFwd.normalize();
  mRight.crossVectors(mUp, mFwd);
  m.quaternion.setFromRotationMatrix(mBasis.makeBasis(mRight, mUp, mFwd));

  const worldPerPx = (2 * camera.position.distanceTo(s.pos) * Math.tan((camera.fov * DEG) / 2)) / canvas.clientHeight;
  // Cap at the orbit height so low-orbit models never sink into the Earth when zoomed out.
  const altUnits = s.pos.length() - 1;
  const scale = Math.min(worldPerPx * (selected ? MODEL_PX_SELECTED : MODEL_PX), Math.max(altUnits * 1.6, 0.004));
  m.scale.setScalar(scale);

  // Earth's shadow (cylinder model): dark when behind the Earth relative to the Sun.
  const sun = earthUniforms.sunDir.value;
  const d = s.pos.dot(sun);
  setModelLit(m, d > 0 || mFwd.copy(s.pos).addScaledVector(sun, -d).lengthSq() > 1);
  m.visible = true;
  return scale / worldPerPx; // size on screen in pixels
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
      sub.textContent = sim ? '沒有軌道資料（TLE），無法模擬'
        : s.error ? s.error : s.samples.length ? '資料已過期，等待更新' : '載入中…';
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
  placeGridLabel();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// Simulation controls
const simToggle = $('sim-toggle'), simSpeed = $('sim-speed'), simRate = $('sim-rate');
// speed null = back to live; atMs = simulated time to start from (default: carry on from now).
function setSim(speed, atMs) {
  sim = speed == null ? null : { fromSim: atMs ?? clockMs(), fromReal: Date.now(), speed };
  const on = Boolean(sim);
  simToggle.textContent = on ? '回到即時' : '加速模擬';
  simToggle.setAttribute('aria-pressed', String(on));
  simSpeed.hidden = simRate.hidden = !on;
  simRate.textContent = `${simSpeed.value}×`;
  $('clock').classList.toggle('sim', on);
  for (const s of sats.values()) s.pathAt = -Infinity;
  tickSlow();
}
simToggle.addEventListener('click', () => setSim(sim ? null : Number(simSpeed.value)));
simSpeed.addEventListener('input', () => { if (sim) setSim(Number(simSpeed.value)); });

// Pass predictions: computed by SGP4 in a Web Worker (passes-worker.js +
// passes.js, shared with tools/check-passes.js), so no N2YO quota is used.
const PASS_DAYS = 3;
const PASS_MIN_EL = 10;
const passWorker = new Worker('passes-worker.js');
let passJob = 0, passBusy = false, passDirtyAt = 0, passFrom = null;
let passResults = [], passError = null, passKey = '', passTab = false;

function markPassesDirty() { if (!passDirtyAt) passDirtyAt = Date.now(); }

passWorker.onmessage = (e) => {
  passBusy = false;
  if (e.data.job !== passJob) return;
  passFrom = e.data.fromMs;
  passResults = e.data.results;
  passError = null;
  passKey = '';
  renderPasses();
};
passWorker.onerror = (e) => {
  e.preventDefault();
  passBusy = false;
  passError = '過境預報計算失敗（需要網路載入 satellite.js）';
  passKey = '';
  renderPasses();
};

function updatePasses() {
  const now = clockMs();
  // Keep at least two days ahead, and recompute after the clock jumps backwards.
  if (passFrom !== null && (now > passFrom + 864e5 || now < passFrom - 60e3)) markPassesDirty();
  // Short debounce: TLEs for several satellites arrive one after another at start-up.
  if (passDirtyAt && !passBusy && Date.now() - passDirtyAt > 800) {
    passDirtyAt = 0;
    passBusy = true;
    passWorker.postMessage({
      job: ++passJob,
      sats: [...sats.values()].filter((s) => s.tle).map((s) => ({ id: s.id, ...s.tle })),
      observer, fromMs: now, toMs: now + PASS_DAYS * 864e5, minEl: PASS_MIN_EL,
    });
  }
  renderPasses();
}

const passDate = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
const passWeekday = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', weekday: 'short' });
const taipeiDay = (ms) => Math.floor((ms + 8 * 3600e3) / 864e5); // Taiwan has no DST
function dayHeading(ms, now) {
  const rel = ['今天', '明天', '後天'][taipeiDay(ms) - taipeiDay(now)] || '';
  return `${rel} ${passDate.format(ms)} ${passWeekday.format(ms)}`.trim();
}
const passTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function passRow(s, cls, maxText) {
  const el = document.createElement('li');
  el.className = `pass ${cls}`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = COLORS[s.colorIndex];
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  const max = document.createElement('span');
  max.className = 'max';
  max.textContent = maxText;
  const sub = document.createElement('span');
  sub.className = 'sub';
  const badges = document.createElement('span');
  badges.className = 'sub badges';
  el.append(dot, name, max, sub, badges);
  return { el, sub, badges, max };
}
function badge(cls, text) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

function renderPasses() {
  if (!passTab) return;
  const now = clockMs();
  const visibleOnly = $('visible-only').checked;
  const geo = [], items = [];
  for (const r of passResults) {
    const s = sats.get(r.id);
    if (!s) continue;
    if (r.geo) { if (r.el > 0) geo.push({ s, r }); continue; }
    for (const p of r.passes) {
      if (p.end > now && (!visibleOnly || p.visible)) items.push({ s, p, live: p.start <= now });
    }
  }
  items.sort((a, b) => a.p.start - b.p.start);
  const noTle = [...sats.values()].filter((s) => !s.tle).length;

  // Rebuild only when something visible changed, so hover and clicks are not disturbed.
  const key = [taipeiDay(now), visibleOnly, passBusy, passError, noTle, ...geo.map(({ s }) => s.id + s.name),
    ...items.map(({ s, p, live }) => `${s.id}:${s.name}:${p.start}:${live}`)].join('|');
  if (key === passKey) return;
  passKey = key;

  $('pass-status').textContent = passError
    || (passBusy && !passResults.length ? '計算中…'
      : `共 ${items.length} 次${visibleOnly ? '肉眼可見的' : ''}過境${noTle ? `（${noTle} 顆還沒有軌道資料）` : ''}`);

  const list = $('passes');
  list.replaceChildren();
  for (const { s, r } of geo) {
    const row = passRow(s, 'geo', `仰角 ${r.el.toFixed(0)}°`);
    row.sub.textContent = `同步衛星，一直在天上 · 方位 ${r.az.toFixed(0)}° ${compassName(r.az)}`;
    list.append(row.el);
  }
  let day = null;
  for (const { s, p, live } of items) {
    const heading = dayHeading(p.start, now);
    if (heading !== day) {
      day = heading;
      const h = document.createElement('li');
      h.className = 'day';
      h.textContent = heading;
      list.append(h);
    }
    const row = passRow(s, live ? 'now' : '', `最高 ${p.maxEl.toFixed(0)}°`);
    row.sub.textContent = `${passTime.format(p.start)}–${passTime.format(p.end)} · `
      + `${compassName(p.startAz)} → ${compassName(p.endAz)} · ${Math.max(1, Math.round((p.end - p.start) / 60e3))} 分鐘`;
    if (live) row.badges.append(badge('live', '過境中'));
    if (p.visible) {
      row.badges.append(badge('vis', `肉眼可見 ${passTime.format(p.visStart)}–${passTime.format(p.visEnd)}`));
    }
    row.el.tabIndex = 0;
    row.el.title = '從過境前 1 分鐘開始模擬';
    const go = () => simulatePass(s.id, p.start);
    row.el.addEventListener('click', go);
    row.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    list.append(row.el);
  }
}

function simulatePass(id, startMs) {
  replay = null; // 點過境預報就離開回放，改成一般的加速模擬
  showReplayBar(false);
  setSim(Number(simSpeed.value), startMs - 60e3);
  const ms = clockMs();
  for (const s of sats.values()) updateSat(s, ms); // so select() frames the new position
  if (selectedId !== id) select(id);
}

function setTab(name) {
  passTab = name === 'passes';
  $('tab-list').hidden = passTab;
  $('tab-passes').hidden = !passTab;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  passKey = '';
  renderPasses();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('visible-only').addEventListener('change', () => { passKey = ''; renderPasses(); });

function tickSlow() {
  const nowMs = clockMs();
  const sun = subsolarPoint(nowMs);
  geoToVec(sun.lat, sun.lng, 0, earthUniforms.sunDir.value).normalize();
  sunLight.position.copy(earthUniforms.sunDir.value).multiplyScalar(50);
  $('clock').textContent = new Date(nowMs).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const s of sats.values()) {
    if (Math.abs(nowMs - s.pathAt) >= 30000) { updatePath(s, nowMs); s.pathAt = nowMs; }
  }
  refreshList();
  updateHint();
  poll();
  updatePasses();
  updateReplay();
  applyHistory();
  renderStarlinkInfo();
  renderCloudInfo();
}

// Starlink layer: off by default; the choice is remembered in this browser.
const starlink = new StarlinkLayer(scene);
const STARLINK_KEY = 'starlink-enabled';
function setStarlink(on) {
  if (on) starlink.enable(); else starlink.disable();
  starlinkWant = undefined; // 重新決定要用哪一份資料
  $('starlink-toggle').setAttribute('aria-pressed', String(on));
  updateReplayButton();
  $('starlink-info').hidden = !on;
  try { localStorage.setItem(STARLINK_KEY, on ? '1' : '0'); } catch { /* optional */ }
  renderStarlinkInfo();
}
function renderStarlinkInfo() {
  if (!starlink.enabled) return;
  const text = starlink.status
    || `${starlink.count.toLocaleString()} 顆 · 台灣地平線上 ${starlink.above.toLocaleString()} 顆`;
  if ($('starlink-info').textContent !== text) $('starlink-info').textContent = text;
}
$('starlink-toggle').addEventListener('click', () => setStarlink(!starlink.enabled));

// 氣象署衛星雲圖：預設關閉，開關記在這個瀏覽器。雲圖是即時觀測，加速模擬時不會跟著時間變。
const clouds = new CloudLayer(scene, earthUniforms.sunDir);
const CLOUDS_KEY = 'clouds-enabled';
function setClouds(on) {
  if (on) clouds.enable(); else clouds.disable();
  $('clouds-toggle').setAttribute('aria-pressed', String(on));
  updateReplayButton();
  $('clouds-info').hidden = !on;
  try { localStorage.setItem(CLOUDS_KEY, on ? '1' : '0'); } catch { /* optional */ }
  renderCloudInfo();
}
// 模擬時間和雲圖觀測時間差超過這麼多，雲就調淡並註明，避免被當成那個時刻的天氣
const CLOUDS_STALE_MS = 3600e3;
function renderCloudInfo() {
  if (!clouds.enabled) return;
  let text = clouds.status;
  let stale = false;
  if (!text && clouds.obsTime) {
    const hm = clouds.obsTime.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' });
    stale = Math.abs(clockMs() - clouds.obsTime.getTime()) > CLOUDS_STALE_MS;
    if (stale) {
      text = `雲圖為 ${hm} 的觀測，不隨模擬變化`;
    } else if (sim) {
      text = `雲圖 ${hm}`;
    } else {
      const ago = Math.max(0, Math.round((Date.now() - clouds.obsTime.getTime()) / 60000));
      text = `觀測 ${hm}（${ago} 分鐘前）`;
    }
  }
  clouds.uniforms.opacity.value = stale ? 0.3 : 1;
  $('clouds-info').classList.toggle('stale', stale);
  if ($('clouds-info').textContent !== text) $('clouds-info').textContent = text;
}
$('clouds-toggle').addEventListener('click', () => setClouds(!clouds.enabled));

// 經緯線：每 15° 一條虛線，赤道和本初子午線較亮。半徑比雲球（1.006）高一點，開雲圖時也看得到；
// 有深度測試，地球背面的線會被擋住。預設關閉，開關記在這個瀏覽器。
const GRID_KEY = 'graticule-enabled';
const GRID_STEP = 15;
const graticule = (() => {
  const g = new THREE.Group();
  const R_KM = 0.008 * EARTH_KM;
  const dashed = (points, strong) => {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({
        color: strong ? 0xd6e4f5 : 0x8fa6c4, transparent: true, opacity: strong ? 0.75 : 0.45,
        dashSize: 0.025, gapSize: 0.018, depthWrite: false,
      }),
    );
    l.computeLineDistances();
    l.renderOrder = 2;
    l.userData.baseColor = l.material.color.getHex();
    l.userData.baseOpacity = l.material.opacity;
    return l;
  };
  for (let lat = -90 + GRID_STEP; lat < 90; lat += GRID_STEP) {
    const ring = [];
    for (let lng = -180; lng <= 180; lng += 2) ring.push(geoToVec(lat, lng, R_KM));
    const l = dashed(ring, lat === 0);
    l.userData.lat = lat;
    g.add(l);
  }
  for (let lng = -180; lng < 180; lng += GRID_STEP) {
    const arc = [];
    for (let lat = -90; lat <= 90; lat += 2) arc.push(geoToVec(lat, lng, R_KM));
    const l = dashed(arc, lng === 0);
    l.userData.lng = lng;
    g.add(l);
  }
  g.userData.radius = 1 + R_KM / EARTH_KM;
  g.visible = false;
  scene.add(g);
  return g;
})();
// 點到經緯線時，在點的位置顯示它的度數，並把那條線標亮（再點空白處或關掉經緯線就消失）
const GRID_PICK_PX = 12; // 點的位置離線多近（像素）才算點到
const gridLabel = makeLabel('grid', '');
let gridPick = null; // { line, world }

function gridName(line) {
  const { lat, lng } = line.userData;
  if (lat !== undefined) return lat === 0 ? '赤道 0°' : `${lat > 0 ? '北緯' : '南緯'} ${Math.abs(lat)}°`;
  if (lng === 0) return '本初子午線 0°';
  if (Math.abs(lng) === 180) return '經度 180°';
  return `${lng > 0 ? '東經' : '西經'} ${Math.abs(lng)}°`;
}

function setGridPick(pick) {
  if (gridPick) {
    const m = gridPick.line.material;
    m.color.setHex(gridPick.line.userData.baseColor);
    m.opacity = gridPick.line.userData.baseOpacity;
  }
  gridPick = pick;
  if (pick) {
    pick.line.material.color.set(0xf5c451);
    pick.line.material.opacity = 1;
    gridLabel.textContent = gridName(pick.line);
  } else gridLabel.style.display = 'none';
}

const gridRay = new THREE.Raycaster();
const gridSphere = new THREE.Sphere(new THREE.Vector3(), 1);
const pickNdc = new THREE.Vector2();
function toScreen(world) {
  const p = world.clone().project(camera);
  return { x: ((p.x + 1) / 2) * canvas.clientWidth, y: ((1 - p.y) / 2) * canvas.clientHeight };
}

function pickGrid(clientX, clientY) {
  if (!graticule.visible) return null;
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  pickNdc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
  gridRay.setFromCamera(pickNdc, camera);
  gridSphere.radius = graticule.userData.radius;
  const hit = gridRay.ray.intersectSphere(gridSphere, new THREE.Vector3());
  if (!hit) return null;
  const lat = Math.asin(THREE.MathUtils.clamp(hit.y / hit.length(), -1, 1)) / DEG;
  const lng = Math.atan2(-hit.z, hit.x) / DEG;
  const altKm = (gridSphere.radius - 1) * EARTH_KM;
  // 最近的緯線和經線各取一個點，看哪個在畫面上離點的位置最近
  const candidates = [];
  const latLine = Math.round(lat / GRID_STEP) * GRID_STEP;
  if (Math.abs(latLine) < 90) candidates.push({ key: 'lat', v: latLine, world: geoToVec(latLine, lng, altKm) });
  let lngLine = Math.round(lng / GRID_STEP) * GRID_STEP;
  if (lngLine === 180) lngLine = -180;
  candidates.push({ key: 'lng', v: lngLine, world: geoToVec(lat, lngLine, altKm) });
  let best = null;
  for (const c of candidates) {
    const s = toScreen(c.world);
    const d = Math.hypot(s.x - px, s.y - py);
    if (d <= GRID_PICK_PX && (!best || d < best.d)) best = { ...c, d };
  }
  if (!best) return null;
  const line = graticule.children.find((l) => l.userData[best.key] === best.v);
  return line ? { line, world: best.world } : null;
}

// 拖曳旋轉不算點擊：按下到放開移動不超過 5 像素才算
let gridDown = null;
canvas.addEventListener('pointerdown', (e) => { gridDown = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!gridDown || Math.hypot(e.clientX - gridDown.x, e.clientY - gridDown.y) > 5) return;
  gridDown = null;
  if (graticule.visible) setGridPick(pickGrid(e.clientX, e.clientY));
});

// updateLabels 每幀呼叫
function placeGridLabel() {
  if (!gridPick) return;
  const hidden = view === 'space' && hiddenByEarth(gridPick.world);
  placeLabel(gridLabel, gridPick.world, graticule.visible && !hidden);
}

function setGraticule(on) {
  graticule.visible = on;
  if (!on) setGridPick(null);
  $('grid-toggle').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(GRID_KEY, on ? '1' : '0'); } catch { /* optional */ }
}
$('grid-toggle').addEventListener('click', () => setGraticule(!graticule.visible));

// ---------- 回放 ----------
// 用伺服器記錄的歷史資料（雲圖每 10 分鐘一張、保留 24 小時；星鏈 TLE 每 2.5 小時一份、保留 30 天），
// 把時鐘撥回過去播放。只回放有開啟的圖層；追蹤清單的衛星用 SGP4 往回推算。
let archive = { starlink: [], clouds: [] }; // [{ t, file }]，舊到新
let historyAt = 0;
async function loadHistory() {
  try {
    archive = await api('/api/history');
    historyAt = Date.now();
  } catch (err) {
    console.warn('讀取歷史資料清單失敗', err);
  }
}

// 模擬到過去時，星鏈改用那時候的 TLE（t ≤ 時鐘的最後一份）；即時或比最新備份還晚就用最新資料。
let starlinkWant;
function applyHistory() {
  const ms = clockMs();
  clouds.showAt(ms, archive.clouds, Boolean(sim));
  if (!starlink.enabled || !starlink.worker) return;
  const list = archive.starlink;
  let want = null;
  if (sim && list.length && ms < list[list.length - 1].t) {
    want = list[0].file;
    for (const h of list) { if (h.t <= ms) want = h.file; else break; }
  }
  if (want !== starlinkWant) { starlinkWant = want; starlink.useDataset(want); }
}

let replay = null; // { speed, playing }
let replayDragging = false;
const replayPos = $('replay-pos'), replayPlay = $('replay-play'), replaySpeed = $('replay-speed');

function updateReplayButton() {
  const any = clouds.enabled || starlink.enabled;
  $('replay-toggle').disabled = !any;
  $('replay-toggle').title = any ? '用伺服器記錄的歷史資料，回放有開啟的圖層（衛星雲圖、星鏈）' : '先開啟衛星雲圖或星鏈';
}

function fmtTaipei(ms) {
  return new Date(ms).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function showReplayBar(on) {
  $('replay-bar').hidden = !on;
  document.body.classList.toggle('replaying', on);
}

async function startReplay() {
  await loadHistory();
  const starts = [];
  if (clouds.enabled && archive.clouds.length) starts.push(archive.clouds[0].t);
  if (starlink.enabled && archive.starlink.length) starts.push(archive.starlink[0].t);
  showReplayBar(true);
  if (!starts.length) {
    replay = null;
    replayPos.disabled = replayPlay.disabled = true;
    $('replay-time').textContent = '還沒有歷史資料。伺服器開著時會自動累積：雲圖每 10 分鐘一張，星鏈每 2.5 小時一份。';
    return;
  }
  // 從「每個有開的圖層都有歷史資料」的時刻開始：星鏈備份通常比雲圖早一天以上，
  // 用最早的會先播很久不會動、調淡的第一張雲圖。
  const start = Math.max(...starts);
  replay = { speed: Number(replaySpeed.value), playing: true };
  replayPos.disabled = replayPlay.disabled = false;
  replayPos.min = String(start);
  replayPos.max = String(Date.now());
  replayPos.step = '60000';
  setSim(replay.speed, start);
  renderReplay();
}

function exitReplay() {
  const was = Boolean(replay);
  replay = null;
  showReplayBar(false);
  if (was) setSim(null);
}

function setReplayPlaying(on) {
  if (!replay) return;
  replay.playing = on;
  setSim(on ? replay.speed : 0);
  renderReplay();
}

function renderReplay() {
  if (!replay) return;
  const ms = clockMs();
  if (!replayDragging) replayPos.value = String(ms);
  replayPlay.textContent = replay.playing ? '⏸ 暫停' : '▶ 播放';
  const text = `${fmtTaipei(ms)}（${Math.round((Date.now() - ms) / 3600e3 * 10) / 10} 小時前）`;
  if ($('replay-time').textContent !== text) $('replay-time').textContent = text;
}

// tickSlow 每 250 毫秒呼叫
function updateReplay() {
  if (!replay) return;
  replayPos.max = String(Date.now());
  if (clockMs() >= Date.now()) { exitReplay(); return; } // 播到現在了，回到即時
  if (Date.now() - historyAt > 5 * 60e3) loadHistory(); // 回放中也有新的雲圖進來
  renderReplay();
}

$('replay-toggle').addEventListener('click', () => ($('replay-bar').hidden ? startReplay() : exitReplay()));
$('replay-exit').addEventListener('click', exitReplay);
replayPlay.addEventListener('click', () => setReplayPlaying(!replay?.playing));
replaySpeed.addEventListener('change', () => {
  if (!replay) return;
  replay.speed = Number(replaySpeed.value);
  if (replay.playing) setSim(replay.speed);
});
replayPos.addEventListener('pointerdown', () => { replayDragging = true; });
window.addEventListener('pointerup', () => { replayDragging = false; });
replayPos.addEventListener('input', () => {
  if (replay) setSim(replay.playing ? replay.speed : 0, Number(replayPos.value));
});

function frame() {
  const ms = clockMs();
  for (const s of sats.values()) updateSat(s, ms);
  starlink.update(ms, up, sim ? Math.max(1, sim.speed) : 1);
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
  p1.append(a, ' 註冊，在個人資料頁產生 API Key，填進程式資料夾裡的 .env 檔（沒有的話把 .env.example 複製成 .env）：');
  const code = document.createElement('code');
  code.textContent = 'N2YO_API_KEY=你的金鑰';
  const p2 = document.createElement('p');
  p2.textContent = '存檔後重新整理此頁即可，不用重新啟動。';
  n.append(h, p1, code, p2);
}

async function start() {
  const config = await api('/api/config');
  observer = config.observer;
  if (config.version) $('version').textContent = `v${config.version}`;
  observerGd = { latitude: observer.lat * DEG, longitude: observer.lng * DEG, height: (observer.alt || 0) / 1000 };
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
  const params = new URLSearchParams(location.search);
  setView(params.get('view') === 'sky' ? 'sky' : 'space');
  if (params.get('tab') === 'passes') setTab('passes');
  let starlinkOn = params.get('starlink') === '1';
  try { starlinkOn ||= localStorage.getItem(STARLINK_KEY) === '1'; } catch { /* optional */ }
  if (starlinkOn) setStarlink(true);
  let cloudsOn = params.get('clouds') === '1';
  try { cloudsOn ||= localStorage.getItem(CLOUDS_KEY) === '1'; } catch { /* optional */ }
  if (cloudsOn) setClouds(true);
  let gridOn = params.get('grid') === '1';
  try { gridOn ||= localStorage.getItem(GRID_KEY) === '1'; } catch { /* optional */ }
  if (gridOn) setGraticule(true);
  updateReplayButton();

  loadIds().forEach(createSat);
  renderCount();
  polling = config.hasKey;
  if (!config.hasKey) showKeyNotice('尚未設定 N2YO API Key');
  tickSlow();
  setInterval(tickSlow, 250); // 4 Hz so the clock and list keep up at 200×
  frame();
}

start().catch((err) => {
  console.error(err);
  const n = $('notice');
  n.hidden = false;
  n.textContent = `啟動失敗：${err.message}`;
});
