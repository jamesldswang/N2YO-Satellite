'use strict';
// 比對頁面的過境預報（public/passes.js，SGP4）和 N2YO 的過境預報。
// 用法：先執行 node server.js，再執行
//   node tools/check-passes.js [NORAD 編號 ...]
// 沒給編號就用預設的 6 顆。每顆用掉 1 次 radiopasses、1 次 visualpasses（每小時上限各 100 次，伺服器快取 1 小時）。
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SATJS = 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js'; // 和 index.html 同版本
const BASE = process.env.TRACKER_URL || 'http://localhost:8000';
const DEFAULT_IDS = [25544, 48274, 20580, 42920, 43013, 41836];
const MIN_EL = 10;
const TIME_LIMIT = 60; // 起訖、最高點時間允許誤差（秒）
const EL_LIMIT = 1;    // 最高仰角允許誤差（度）
// N2YO 每 5 秒取樣一次，接近天頂的過境（80° 以上）仰角變化很快，它抓到的最高點會偏低 1–2°。
const EL_LIMIT_ZENITH = 2.5;

async function json(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const fmt = (sec) => new Date(sec * 1000).toLocaleString('zh-TW', {
  timeZone: 'Asia/Taipei', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

(async () => {
  // satellite.js 和 passes.js 都是給瀏覽器的 script，放在同一個 vm context 執行。
  const ctx = vm.createContext({});
  ctx.self = ctx.window = ctx;
  vm.runInContext(await (await fetch(SATJS)).text(), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'passes.js'), 'utf8'), ctx);

  const { observer } = await json(`${BASE}/api/config`);
  const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
  let failed = 0;

  for (const id of ids.length ? ids : DEFAULT_IDS) {
    try {
      const [tle, radio, visual] = await Promise.all([
        json(`${BASE}/api/tle/${id}`), json(`${BASE}/api/passes/radio/${id}`), json(`${BASE}/api/passes/visual/${id}`),
      ]);
      const satrec = ctx.satellite.twoline2satrec(tle.line1, tle.line2);
      // 從 N2YO 預報的起點算起。伺服器會快取 1 小時，所以用它實際向 N2YO 查詢的時間，不是現在。
      const from = radio.fetchedAt ?? Date.now();
      const mine = ctx.SatPasses.compute(satrec, observer, from, from + radio.days * 864e5, { minEl: MIN_EL });
      if (mine.geo) {
        console.log(`OK   ${id} ${radio.satname.padEnd(18)} 同步衛星，仰角 ${mine.el.toFixed(1)}°，N2YO ${radio.passes.length} 次過境`);
        continue;
      }
      const ours = mine.passes.map((p) => ({ ...p, start: p.start / 1000, end: p.end / 1000, maxTime: p.maxTime / 1000 }));

      // 每一筆 N2YO 過境，找最高點時間最接近的那一筆比對。
      let worstT = 0, worstEl = 0, missing = 0, badEl = false;
      for (const n of radio.passes) {
        const m = ours.find((p) => Math.abs(p.maxTime - n.maxUTC) < 300);
        if (!m) { missing++; console.log(`     缺少：N2YO ${fmt(n.maxUTC)} 最高 ${n.maxEl}°`); continue; }
        // 查詢當下已經升起的過境，N2YO 會把升起時間截在查詢時刻附近，所以不比對升起時間。
        const clipped = n.startUTC * 1000 <= from + 120e3;
        worstT = Math.max(worstT, clipped ? 0 : Math.abs(m.start - n.startUTC),
          Math.abs(m.end - n.endUTC), Math.abs(m.maxTime - n.maxUTC));
        const elDiff = Math.abs(m.maxEl - n.maxEl);
        if (elDiff > (n.maxEl > 80 ? EL_LIMIT_ZENITH : EL_LIMIT)) badEl = true;
        worstEl = Math.max(worstEl, elDiff);
      }
      // N2YO 從「現在」才開始列，已經在進行中的過境它不會列出，所以不算多出來。
      const extra = ours.filter((p) => p.start * 1000 > from + 60e3
        && !radio.passes.some((n) => Math.abs(p.maxTime - n.maxUTC) < 300));
      for (const p of extra) console.log(`     多出：我們 ${fmt(p.maxTime)} 最高 ${p.maxEl.toFixed(1)}°`);

      // 肉眼可見：只列出差異，不算失敗。N2YO 的可見判斷細節未公開，日落後不久（太陽在地平線下 0–6°）
      // 的過境 N2YO 會算可見，我們要求太陽在地平線下 6° 以上，所以這類邊界情況會不同。
      const visOurs = ours.filter((p) => p.visible);
      const visBoth = visual.passes.filter((n) => visOurs.some((p) => n.startUTC <= p.end && n.endUTC >= p.start)).length;

      const ok = !missing && !extra.length && worstT <= TIME_LIMIT && !badEl;
      if (!ok) failed++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} ${radio.satname.padEnd(18)} 過境 N2YO ${radio.passes.length} / 我們 ${ours.length}`
        + `，時間最大差 ${worstT.toFixed(0)} 秒，仰角最大差 ${worstEl.toFixed(2)}°`
        + `｜肉眼可見 N2YO ${visual.passes.length} / 我們 ${visOurs.length}（重疊 ${visBoth}）`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${id} ${err.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
