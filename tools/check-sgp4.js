'use strict';
// 比對「加速模擬」用的 SGP4 推算和 N2YO 的即時位置，確認兩者一致。
// 用法：先執行 node server.js，再執行
//   node tools/check-sgp4.js [NORAD 編號 ...]
// 沒給編號就用預設的 6 顆。每顆會用掉 1 次 positions 和 1 次 tle 額度（有快取時不會）。
const vm = require('vm');

const SATJS = 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js'; // 和 index.html 同版本
const BASE = process.env.TRACKER_URL || 'http://localhost:8000';
const DEFAULT_IDS = [25544, 48274, 20580, 42920, 43013, 41836];
const DEG = Math.PI / 180;
const LIMIT = 0.5; // 仰角、方位角、經緯度允許的誤差（度）

async function json(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

(async () => {
  // satellite.js 是給瀏覽器的 UMD 檔，在獨立的 vm context 裡執行。
  // 注意：傳進去的 Date 也要用這個 context 的 Date，不然 instanceof 判斷失敗，結果會變成 NaN。
  const ctx = vm.createContext({});
  ctx.self = ctx.window = ctx;
  vm.runInContext(await (await fetch(SATJS)).text(), ctx);
  const sat = ctx.satellite;
  const CtxDate = vm.runInContext('Date', ctx);

  const { observer } = await json(`${BASE}/api/config`);
  const obs = { latitude: observer.lat * DEG, longitude: observer.lng * DEG, height: (observer.alt || 0) / 1000 };
  const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);

  let failed = 0;
  for (const id of ids.length ? ids : DEFAULT_IDS) {
    try {
      const [tle, pos] = await Promise.all([json(`${BASE}/api/tle/${id}`), json(`${BASE}/api/positions/${id}`)]);
      const p = pos.positions[Math.floor(pos.positions.length / 2)];
      const date = new CtxDate(p.t * 1000);
      const rec = sat.twoline2satrec(tle.line1, tle.line2);
      const pv = sat.propagate(rec, date);
      if (!pv.position) throw new Error('SGP4 推算失敗（衛星可能已墜落）');
      const gmst = sat.gstime(date);
      const geo = sat.eciToGeodetic(pv.position, gmst);
      const look = sat.ecfToLookAngles(obs, sat.eciToEcf(pv.position, gmst));
      const mine = {
        el: look.elevation / DEG, az: ((look.azimuth / DEG) + 360) % 360,
        lat: geo.latitude / DEG, lng: geo.longitude / DEG,
      };
      const diff = (a, b, wrap) => { const d = Math.abs(a - b); return wrap ? Math.min(d, 360 - d) : d; };
      const worst = Math.max(diff(mine.el, p.el), diff(mine.az, p.az, true), diff(mine.lat, p.lat), diff(mine.lng, p.lng, true));
      const ok = worst <= LIMIT;
      if (!ok) failed++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} ${pos.satname.padEnd(18)} 最大差 ${worst.toFixed(2)}°  `
        + `N2YO 仰角 ${p.el.toFixed(2)} 方位 ${p.az.toFixed(1)} ｜ SGP4 仰角 ${mine.el.toFixed(2)} 方位 ${mine.az.toFixed(1)}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${id} ${err.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
