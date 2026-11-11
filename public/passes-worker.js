// 在背景執行緒計算過境預報，避免主畫面卡頓。
// satellite.js 版本要和 index.html 一致。
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js', 'passes.js');

self.onmessage = (e) => {
  const { job, sats, observer, fromMs, toMs, minEl } = e.data;
  const results = sats.map(({ id, line1, line2 }) => {
    try {
      const satrec = self.satellite.twoline2satrec(line1, line2);
      return { id, ...self.SatPasses.compute(satrec, observer, fromMs, toMs, { minEl }) };
    } catch (err) {
      return { id, error: err.message, passes: [] };
    }
  });
  self.postMessage({ job, fromMs, results });
};
