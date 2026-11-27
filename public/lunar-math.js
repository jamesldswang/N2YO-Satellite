// 月球視角用的純計算（不依賴 three.js，可以用 node 直接驗證）。
// 座標：J2000 黃道（和 Horizons 的 REF_PLANE=ECLIPTIC 一致），單位 km、km/s。

const DEG = Math.PI / 180;
const OBLIQUITY = 84381.448 / 3600 * DEG; // J2000 黃赤交角
export const MOON_GM = 4902.800066;       // km³/s²
export const MOON_KM = 1737.4;

// 赤道座標（ICRF）→ J2000 黃道座標
function eqToEcl([x, y, z]) {
  const c = Math.cos(OBLIQUITY), s = Math.sin(OBLIQUITY);
  return [x, c * y + s * z, -s * y + c * z];
}

// 月球的自轉方向：IAU WGCCRE 2009 的月球模型（北極赤經赤緯 α0、δ0，本初子午線角 W）。
// 回傳月球本體座標軸在 J2000 黃道座標裡的單位向量：
//   x = 經度 0°（正面中央，大致朝地球）、y = 東經 90°、z = 北極
export function moonAxes(ms) {
  const d = (ms + 69184) / 864e5 + 2440587.5 - 2451545; // TDB 從 J2000 起的天數
  const T = d / 36525;
  const E = [0,
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.0649930 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d,
  ].map((v) => v * DEG);
  const sn = (i) => Math.sin(E[i]), cs = (i) => Math.cos(E[i]);
  const a0 = (269.9949 + 0.0031 * T - 3.8787 * sn(1) - 0.1204 * sn(2) + 0.0700 * sn(3) - 0.0172 * sn(4)
    + 0.0072 * sn(6) - 0.0052 * sn(10) + 0.0043 * sn(13)) * DEG;
  const d0 = (66.5392 + 0.0130 * T + 1.5419 * cs(1) + 0.0239 * cs(2) - 0.0278 * cs(3) + 0.0068 * cs(4)
    - 0.0029 * cs(6) + 0.0009 * cs(7) + 0.0008 * cs(10) - 0.0009 * cs(13)) * DEG;
  const W = (38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * sn(1) + 0.1208 * sn(2) - 0.0642 * sn(3)
    + 0.0158 * sn(4) + 0.0252 * sn(5) - 0.0066 * sn(6) - 0.0047 * sn(7) - 0.0046 * sn(8) + 0.0028 * sn(9)
    + 0.0052 * sn(10) + 0.0040 * sn(11) + 0.0019 * sn(12) - 0.0044 * sn(13)) * DEG;
  const P = [Math.cos(d0) * Math.cos(a0), Math.cos(d0) * Math.sin(a0), Math.sin(d0)]; // 北極
  const Q = [-Math.sin(a0), Math.cos(a0), 0];                                         // 月球赤道和地球赤道的升交點
  const B = [P[1] * Q[2] - P[2] * Q[1], P[2] * Q[0] - P[0] * Q[2], P[0] * Q[1] - P[1] * Q[0]];
  const cW = Math.cos(W), sW = Math.sin(W);
  const x = Q.map((q, i) => cW * q + sW * B[i]);
  const y = Q.map((q, i) => -sW * q + cW * B[i]);
  return { x: eqToEcl(x), y: eqToEcl(y), z: eqToEcl(P) };
}

// 一天的星曆（server.js 的 /api/lunar/<日期> 的一個 body）在 ms 的位置（Hermite 內插，用位置和速度）
// 回傳 [x, y, z, vx, vy, vz] 或 null（不在範圍內）
export function stateAt(body, ms) {
  if (!body || body.error) return null;
  const n = body.data.length / 6;
  const f = (ms - body.t0) / body.step;
  if (f < 0 || f > n - 1) return null;
  const i = Math.min(n - 2, Math.floor(f));
  const s = f - i, h = body.step / 1000; // 秒
  const D = body.data, a = i * 6, b = a + 6;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
  const out = new Array(6);
  for (let k = 0; k < 3; k++) {
    const p0 = D[a + k], p1 = D[b + k], v0 = D[a + 3 + k], v1 = D[b + 3 + k];
    out[k] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
    out[k + 3] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
  }
  return out;
}

// 由位置速度算克卜勒軌道（月球重力），取 n 個點畫軌道線；不是橢圓（逃逸）就回傳 null。
// 也回傳週期（秒）、近月點和遠月點高度（km）
export function keplerOrbit(st, n = 256) {
  const r = st.slice(0, 3), v = st.slice(3);
  const rn = Math.hypot(...r), v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
  const a = 1 / (2 / rn - v2 / MOON_GM);
  if (!(a > 0)) return null;
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hn = Math.hypot(...h);
  // 離心率向量 e = (v × h) / μ − r / |r|
  const vxh = [v[1] * h[2] - v[2] * h[1], v[2] * h[0] - v[0] * h[2], v[0] * h[1] - v[1] * h[0]];
  const ev = vxh.map((c, i) => c / MOON_GM - r[i] / rn);
  const e = Math.hypot(...ev);
  // 軌道平面的基底：P 指向近月點，Qv = ĥ × P
  const P = e > 1e-8 ? ev.map((c) => c / e) : r.map((c) => c / rn);
  const hu = h.map((c) => c / hn);
  const Qv = [hu[1] * P[2] - hu[2] * P[1], hu[2] * P[0] - hu[0] * P[2], hu[0] * P[1] - hu[1] * P[0]];
  const b = a * Math.sqrt(1 - e * e);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const E = (i / n) * 2 * Math.PI;
    const px = a * (Math.cos(E) - e), qy = b * Math.sin(E);
    pts.push([px * P[0] + qy * Qv[0], px * P[1] + qy * Qv[1], px * P[2] + qy * Qv[2]]);
  }
  return {
    pts, period: 2 * Math.PI * Math.sqrt(a ** 3 / MOON_GM),
    periAlt: a * (1 - e) - MOON_KM, apoAlt: a * (1 + e) - MOON_KM,
  };
}
