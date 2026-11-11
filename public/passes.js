// 過境預報：用 satellite.js（SGP4）從 TLE 推算衛星何時經過觀測點上空。
// 瀏覽器的 Web Worker（passes-worker.js）和 Node 測試工具（tools/check-passes.js）共用這個檔案，
// 所以寫成一般 script，掛在全域的 SatPasses 上，並使用全域的 satellite。
(function (root) {
  'use strict';
  const DEG = Math.PI / 180;
  const AU = 149597870.7; // km
  const EARTH_R = 6378.137; // km
  const STEP = 30e3;      // 掃描間隔：最高仰角 10° 以上的過境都會持續好幾分鐘，30 秒不會漏
  const LEAD = 30 * 60e3; // 從開始時間往前多掃 30 分鐘，才抓得到正在進行中的過境
  const VIS_STEP = 10e3;  // 判斷肉眼可見時的取樣間隔

  // 太陽在 ECI 座標的位置（km），精度約 0.01°，判斷日照和天色夠用了。
  function sunEci(ms) {
    const d = ms / 86400000 + 2440587.5 - 2451545;
    const g = (357.529 + 0.98560028 * d) * DEG;
    const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
    const e = (23.439 - 0.00000036 * d) * DEG;
    return { x: AU * Math.cos(L), y: AU * Math.cos(e) * Math.sin(L), z: AU * Math.sin(e) * Math.sin(L) };
  }

  // 圓柱形地影模型：衛星在地球背對太陽的那一側，且離日地連線不到一個地球半徑，就在影子裡。
  function sunlit(p, sun) {
    const n = Math.hypot(sun.x, sun.y, sun.z);
    const ux = sun.x / n, uy = sun.y / n, uz = sun.z / n;
    const dot = p.x * ux + p.y * uy + p.z * uz;
    if (dot > 0) return true;
    return Math.hypot(p.x - dot * ux, p.y - dot * uy, p.z - dot * uz) > EARTH_R;
  }

  function compassName(az) {
    return ['北', '東北', '東', '東南', '南', '西南', '西', '西北'][Math.round(az / 45) % 8];
  }

  // observer: { lat, lng, alt }（度、度、公尺）
  function compute(satrec, observer, fromMs, toMs, opts = {}) {
    const sat = root.satellite;
    const minEl = opts.minEl ?? 10;
    const gd = { latitude: observer.lat * DEG, longitude: observer.lng * DEG, height: (observer.alt || 0) / 1000 };

    function look(ms) {
      const date = new Date(ms);
      const pv = sat.propagate(satrec, date);
      if (!pv || !pv.position) return null;
      const gmst = sat.gstime(date);
      const la = sat.ecfToLookAngles(gd, sat.eciToEcf(pv.position, gmst));
      return { el: la.elevation / DEG, az: ((la.azimuth / DEG) + 360) % 360, eci: pv.position, gmst };
    }
    const elAt = (ms) => { const l = look(ms); return l ? l.el : -90; };

    // 同步衛星（週期接近一天）幾乎不動，不會有升起、落下。
    const periodMin = (2 * Math.PI) / satrec.no;
    if (periodMin > 1300) {
      const l = look(fromMs);
      return { geo: true, el: l ? l.el : null, az: l ? l.az : null, passes: [] };
    }

    // 在 lo（地平線下）和 hi（地平線上）之間二分，找出跨過地平線的時刻，精度 1 秒。
    function edge(lo, hi) {
      const rising = elAt(lo) <= 0;
      while (hi - lo > 1000) {
        const mid = (lo + hi) / 2;
        if ((elAt(mid) > 0) === rising) hi = mid; else lo = mid;
      }
      return Math.round((lo + hi) / 2);
    }

    const windows = [];
    let t = fromMs - LEAD;
    let prev = elAt(t);
    let rise = prev > 0 ? t : null; // 一開始就在天上：從掃描起點算
    const hardEnd = toMs + 2 * 3600e3; // 最後一次過境要掃到落下為止
    while (t < hardEnd) {
      const next = t + STEP;
      const l = look(next);
      if (!l) break; // SGP4 失敗（例如衛星已墜落）
      if (prev <= 0 && l.el > 0) {
        if (next > toMs) break;
        rise = edge(t, next);
      } else if (prev > 0 && l.el <= 0 && rise !== null) {
        windows.push([rise, edge(t, next)]);
        rise = null;
      }
      prev = l.el;
      t = next;
    }

    const passes = [];
    for (const [start, end] of windows) {
      if (end <= fromMs) continue;
      // 三分搜尋找最高點（一次過境的仰角只有一個高峰）。
      let a = start, b = end;
      while (b - a > 1000) {
        const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
        if (elAt(m1) < elAt(m2)) a = m1; else b = m2;
      }
      const maxTime = Math.round((a + b) / 2);
      const top = look(maxTime), s = look(start), e = look(end);
      if (!top || top.el < minEl) continue;

      // 肉眼可見：衛星被太陽照到、觀測點天色夠暗（太陽在地平線下 6° 以上）、仰角 10° 以上。
      let visStart = null, visEnd = null, visMaxEl = -90;
      for (let ms = start; ms <= end; ms += VIS_STEP) {
        const l = look(ms);
        if (!l || l.el < 10) continue;
        const sun = sunEci(ms);
        const sunLook = sat.ecfToLookAngles(gd, sat.eciToEcf(sun, l.gmst));
        if (sunLook.elevation / DEG < -6 && sunlit(l.eci, sun)) {
          if (visStart === null) visStart = ms;
          visEnd = ms;
          visMaxEl = Math.max(visMaxEl, l.el);
        }
      }

      passes.push({
        start, end, maxTime,
        maxEl: top.el,
        startAz: s ? s.az : null, maxAz: top.az, endAz: e ? e.az : null,
        visible: visStart !== null,
        visStart, visEnd, visMaxEl: visStart !== null ? visMaxEl : null,
      });
    }
    return { geo: false, passes };
  }

  root.SatPasses = { compute, compassName, sunEci, sunlit };
})(typeof self !== 'undefined' ? self : globalThis);
