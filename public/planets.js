// 行星日心位置：NASA JPL「Approximate Positions of the Planets」（E. M. Standish）表 1 的克卜勒軌道根數，
// 適用 1800–2050 年，誤差約幾角分到 1°（示意畫面夠用）。純計算，不依賴 three.js，Node 也能跑（測試用）。
// 座標：日心黃道座標（J2000），單位 AU；x 指向春分點，z 指向黃道北極。

const DEG = Math.PI / 180;

// [a (AU), e, I, L, ϖ（近日點經度）, Ω（升交點經度）]（度），以及每世紀的變化率
export const PLANETS = [
  { id: 'mercury', name: '水星', el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
  { id: 'venus', name: '金星', el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
  { id: 'earth', name: '地球', el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0] },
  { id: 'mars', name: '火星', el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  { id: 'jupiter', name: '木星', el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
  { id: 'saturn', name: '土星', el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
  { id: 'uranus', name: '天王星', el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
  { id: 'neptune', name: '海王星', el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
];

const centuries = (ms) => (ms / 86400000 + 2440587.5 - 2451545) / 36525;

// 某時刻的軌道根數（a、e 不變單位；角度轉成弧度）
function elements(p, ms) {
  const T = centuries(ms);
  const [a, e, I, L, w, O] = p.el.map((v, i) => v + p.rate[i] * T);
  return { a, e, I: I * DEG, L: L * DEG, peri: w * DEG, node: O * DEG };
}

// 軌道平面上的點（偏近點角 E）轉成黃道座標
function toEcliptic({ a, e, I, peri, node }, E) {
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = peri - node; // 近日點幅角
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(node), sO = Math.sin(node), cI = Math.cos(I), sI = Math.sin(I);
  return {
    x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    z: (sw * sI) * xp + (cw * sI) * yp,
  };
}

// 行星在 ms 時的日心黃道位置（AU）
export function planetPosition(p, ms) {
  const el = elements(p, ms);
  let M = (el.L - el.peri) % (2 * Math.PI);
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;
  let E = M + el.e * Math.sin(M);
  for (let i = 0; i < 8; i++) E -= (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
  return toEcliptic(el, E);
}

// 整條軌道（n 個點，用 ms 當時的根數）
export function planetOrbit(p, ms, n) {
  const el = elements(p, ms);
  return Array.from({ length: n }, (_, i) => toEcliptic(el, (i / n) * 2 * Math.PI));
}

// 公轉週期（天）
export const periodDays = (p) => 36525 * 360 / p.rate[3];
