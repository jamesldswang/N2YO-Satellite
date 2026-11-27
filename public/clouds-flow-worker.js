// 雲的移動場（Web Worker）：比對兩張全盤面雲圖（相隔約 1 小時），用區塊比對找出每一格的雲往哪裡移動。
// 結果給 clouds.js 的 shader 做短時外推（semi-Lagrangian：t 小時後 x 處的雲 = 現在 x − v·t 處的雲）。
// 輸入：{ id, oldBlob, newBlob, gapHours }；輸出：{ id, grid, flow: Float32Array(grid² × 2), valid }
// flow 是「新圖」上每格的位移，單位是貼圖 uv / 小時，列 0 是圖的最上面（和 cloudMap 的 flipY = false 一致）。

const N = 640;          // 縮到 640 px（星下點約 17 公里一格）再比對，速度夠快、雜訊也少
const STEP = 8;         // 每 8 px 一個向量 → 80 × 80 格
const GRID = N / STEP;
const HALF = 8;         // 比對區塊 17 × 17 px（約 290 公里）
const SEARCH = 10;      // 搜尋 ±10 px（以 1 小時算約 ±170 km/h，涵蓋噴流裡的雲）
const DISK_R = 0.494 * N; // 地球在圖上的半徑（CGMS：asin(6378 / 42164) ≈ 8.7°）
const CLOUD = 97;       // 亮度 0.38 × 255，和 shader 的雲門檻一致；區塊裡沒有雲就不追

async function gray(blob) {
  const bmp = await createImageBitmap(blob, { resizeWidth: N, resizeHeight: N, resizeQuality: 'high' });
  const cv = new OffscreenCanvas(N, N);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, N, N).data;
  const g = new Uint8Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rgba[i * 4];
  return g;
}

// 新圖中心 (cx, cy) 的區塊，在舊圖哪個位移 (dx, dy) 最像：雲從 (cx − dx, cy − dy) 移到 (cx, cy)
function match(A, B, cx, cy) {
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let s = 0;
      for (let y = -HALF; y <= HALF; y++) {
        const rb = (cy + y) * N + cx;
        const ra = (cy + y - dy) * N + cx - dx;
        for (let x = -HALF; x <= HALF; x++) {
          const d = B[rb + x] - A[ra + x];
          s += d * d;
        }
        if (s >= best) break; // 已經比目前最好的差，提早放棄
      }
      if (s < best) { best = s; bx = dx; by = dy; }
    }
  }
  // 落在搜尋範圍邊緣：可能真的更快或比對錯，不採用
  if (Math.abs(bx) === SEARCH || Math.abs(by) === SEARCH) return null;
  const area = (2 * HALF + 1) ** 2;
  if (Math.sqrt(best / area) > 22) return null; // 平均差超過 22 階：雲變形太多，不可靠
  // 拋物線內插到次像素（掃描時有提早放棄，所以最佳點的上下左右重新完整算一次）
  const sub = (m, c, p) => { const den = m - 2 * c + p; return den > 0 ? 0.5 * (m - p) / den : 0; };
  const fx = bx + Math.max(-0.5, Math.min(0.5, sub(full(A, B, cx, cy, bx - 1, by), best, full(A, B, cx, cy, bx + 1, by))));
  const fy = by + Math.max(-0.5, Math.min(0.5, sub(full(A, B, cx, cy, bx, by - 1), best, full(A, B, cx, cy, bx, by + 1))));
  return [fx, fy];
}

function full(A, B, cx, cy, dx, dy) {
  let s = 0;
  for (let y = -HALF; y <= HALF; y++) {
    const rb = (cy + y) * N + cx;
    const ra = (cy + y - dy) * N + cx - dx;
    for (let x = -HALF; x <= HALF; x++) { const d = B[rb + x] - A[ra + x]; s += d * d; }
  }
  return s;
}

function trackable(B, cx, cy) {
  let n = 0, sum = 0, sum2 = 0, cloudy = 0;
  for (let y = -HALF; y <= HALF; y += 2) {
    for (let x = -HALF; x <= HALF; x += 2) {
      const v = B[(cy + y) * N + cx + x];
      n++; sum += v; sum2 += v * v;
      if (v >= CLOUD) cloudy++;
    }
  }
  const sd = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
  return cloudy >= n * 0.15 && sd >= 6; // 要有雲、也要有紋理才追得到
}

self.onmessage = async ({ data }) => {
  const { id, oldBlob, newBlob, gapHours } = data;
  try {
    const [A, B] = await Promise.all([gray(oldBlob), gray(newBlob)]);
    const vx = new Float32Array(GRID * GRID), vy = new Float32Array(GRID * GRID);
    const ok = new Uint8Array(GRID * GRID);
    const margin = HALF + SEARCH + 1;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const cx = i * STEP + STEP / 2, cy = j * STEP + STEP / 2;
        if (cx < margin || cy < margin || cx >= N - margin || cy >= N - margin) continue;
        if (Math.hypot(cx - N / 2, cy - N / 2) > DISK_R * 0.93) continue; // 邊緣變形太大
        if (!trackable(B, cx, cy)) continue;
        const m = match(A, B, cx, cy);
        if (!m) continue;
        const k = j * GRID + i;
        vx[k] = m[0]; vy[k] = m[1]; ok[k] = 1;
      }
    }

    // 去掉離群值：和周圍 5 × 5 有效向量的中位數差超過 3 px
    const median = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const keep = new Uint8Array(ok);
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        if (!ok[k]) continue;
        const xs = [], ys = [];
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
          const ii = i + a, jj = j + b;
          if ((a || b) && ii >= 0 && jj >= 0 && ii < GRID && jj < GRID && ok[jj * GRID + ii]) { xs.push(vx[jj * GRID + ii]); ys.push(vy[jj * GRID + ii]); }
        }
        if (xs.length < 3 || Math.hypot(vx[k] - median(xs), vy[k] - median(ys)) > 3) keep[k] = 0;
      }
    }

    // 平滑：有效向量的加權平均（高斯 σ = 1.5 格）
    let fx = new Float32Array(GRID * GRID), fy = new Float32Array(GRID * GRID);
    let have = new Uint8Array(GRID * GRID);
    const R = 3, S2 = 2 * 1.5 * 1.5;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        let w = 0, sx = 0, sy = 0;
        for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue;
          const kk = jj * GRID + ii;
          if (!keep[kk]) continue;
          const g = Math.exp(-(a * a + b * b) / S2);
          w += g; sx += g * vx[kk]; sy += g * vy[kk];
        }
        const k = j * GRID + i;
        if (w > 0.3) { fx[k] = sx / w; fy[k] = sy / w; have[k] = 1; }
      }
    }
    // 沒有雲的地方也要有速度（雲會移進去），從旁邊往外填，最多填 12 格（約 1600 公里），再遠就當成不動
    for (let it = 0; it < 12; it++) {
      const nx = new Float32Array(fx), ny = new Float32Array(fy), nh = new Uint8Array(have);
      let changed = false;
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const k = j * GRID + i;
          if (have[k]) continue;
          let n = 0, sx = 0, sy = 0;
          for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
            const ii = i + a, jj = j + b;
            if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue;
            const kk = jj * GRID + ii;
            if (have[kk]) { n++; sx += fx[kk]; sy += fy[kk]; }
          }
          if (n) { nx[k] = sx / n * 0.97; ny[k] = sy / n * 0.97; nh[k] = 1; changed = true; }
        }
      }
      fx = nx; fy = ny; have = nh;
      if (!changed) break;
    }

    const flow = new Float32Array(GRID * GRID * 2);
    const scale = 1 / N / gapHours; // px（640 張）→ uv / 小時
    for (let k = 0; k < GRID * GRID; k++) { flow[k * 2] = fx[k] * scale; flow[k * 2 + 1] = fy[k] * scale; }
    let valid = 0;
    for (let k = 0; k < keep.length; k++) valid += keep[k];
    self.postMessage({ id, grid: GRID, flow, valid }, [flow.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
