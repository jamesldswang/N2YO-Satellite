// 在背景執行緒用 SGP4 計算整個星鏈星座（上萬顆）的位置。
// 回傳場景座標的位置和速度，主執行緒每一幀用「位置 + 速度 × 經過時間」外插，
// 不用每一幀都重算上萬顆。satellite.js 版本要和 index.html 一致。
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const EARTH_KM = 6371;         // 和 app.js 的場景比例一致：地球半徑 = 1
const OMEGA = 7.2921159e-5;    // 地球自轉角速度（rad/s）
// WGS84 橢球，用來把地固座標轉成大地緯度、高度，和其他衛星（app.js 的 geoToVec）用同一套換算。
const A = 6378.137, F = 1 / 298.257223563, B = A * (1 - F), E2 = F * (2 - F), EP2 = E2 / (1 - E2);
let recs = [];

function load(text) {
  const lines = text.split(/\r?\n/);
  recs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('1 ') || !lines[i + 1]?.startsWith('2 ')) continue;
    try {
      recs.push(self.satellite.twoline2satrec(lines[i], lines[i + 1]));
    } catch { /* 格式錯誤的那一筆跳過 */ }
    i++;
  }
}

// 位置：ECI 轉成地固座標（ECEF），用 Bowring 公式求大地緯度、高度，再照 geoToVec 換成場景座標
//（地球半徑 = 1，x = 0°E、y = 北、z = −90°E）。
// 速度：地固座標的速度 = 旋轉後的 ECI 速度 − ω × r，單位換成「場景單位 / 毫秒」（只用來外插短時間，不需要同樣精確）。
function tick(ms) {
  const n = recs.length;
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const date = new Date(ms);
  const g = self.satellite.gstime(date);
  const c = Math.cos(g), s = Math.sin(g);
  for (let i = 0; i < n; i++) {
    const pv = self.satellite.propagate(recs[i], date);
    if (!pv || !pv.position) continue; // 推算失敗（例如已墜落）：留在原點，被地球擋住看不到
    const p = pv.position, v = pv.velocity;
    const X = c * p.x + s * p.y, Y = -s * p.x + c * p.y, Z = p.z;
    const VX = c * v.x + s * v.y + OMEGA * Y, VY = -s * v.x + c * v.y - OMEGA * X, VZ = v.z;
    const pxy = Math.hypot(X, Y);
    const th = Math.atan2(Z * A, pxy * B);
    const st = Math.sin(th), ct = Math.cos(th);
    const lat = Math.atan2(Z + EP2 * B * st * st * st, pxy - E2 * A * ct * ct * ct);
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const h = pxy * cl + Z * sl - A * Math.sqrt(1 - E2 * sl * sl); // = p·cosφ + z·sinφ − a²/N
    const r = 1 + h / EARTH_KM;
    const lng = Math.atan2(Y, X);
    const k = i * 3;
    pos[k] = r * cl * Math.cos(lng); pos[k + 1] = r * sl; pos[k + 2] = -r * cl * Math.sin(lng);
    vel[k] = VX / EARTH_KM / 1000; vel[k + 1] = VZ / EARTH_KM / 1000; vel[k + 2] = -VY / EARTH_KM / 1000;
  }
  return { pos, vel };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg.text);
    self.postMessage({ type: 'loaded', count: recs.length });
  } else if (msg.type === 'tick') {
    const { pos, vel } = tick(msg.ms);
    self.postMessage({ type: 'tick', ms: msg.ms, count: recs.length, pos, vel }, [pos.buffer, vel.buffer]);
  }
};
