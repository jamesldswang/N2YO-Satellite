'use strict';
// Local proxy for the N2YO REST API, plus a static file server for public/.
// N2YO sends no CORS header, so the browser cannot call it directly, and this
// also keeps the API key out of client code.
const http = require('http');
const fs = require('fs');
const path = require('path');
const util = require('util');
const zlib = require('zlib');
const os = require('os');

const ENV_FILE = path.join(__dirname, '.env');
try { process.loadEnvFile(ENV_FILE); } catch { /* .env is optional */ }

// Re-read .env while no key is set, so a key typed in after start-up works
// on the next page refresh without restarting the server. parseEnv rather
// than loadEnvFile: the latter never overwrites a variable that is already
// set, and the .env.example template sets the key to an empty string.
function apiKey() {
  if (!process.env.N2YO_API_KEY) {
    try {
      const key = util.parseEnv(fs.readFileSync(ENV_FILE, 'utf8')).N2YO_API_KEY;
      if (key) process.env.N2YO_API_KEY = key;
    } catch { /* still missing */ }
  }
  return (process.env.N2YO_API_KEY || '').trim();
}
const BASE = process.env.N2YO_BASE || 'https://api.n2yo.com/rest/v1/satellite';
const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;

// Geographic centre of Taiwan; az/el from N2YO are relative to this point.
const OBSERVER = { name: '台灣', lat: 23.6978, lng: 120.9605, alt: 0 };

const POSITIONS_SECONDS = 300; // N2YO maximum per request
const POSITIONS_TTL = 200e3;   // the client refetches once under 90 s of data remains
const TLE_TTL = 6 * 3600e3;
const ERROR_TTL = 30e3;        // stops a bad key or id from burning hourly quota

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cache = new Map();
function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.promise;
  const entry = { expires: Infinity, promise: null }; // shared while in flight
  entry.promise = load().then(
    (value) => { entry.expires = Date.now() + ttl; return value; },
    (err) => { entry.expires = Date.now() + ERROR_TTL; throw err; },
  );
  cache.set(key, entry);
  return entry.promise;
}

async function n2yo(route) {
  const key = apiKey();
  if (!key) throw new ApiError(401, '尚未設定 N2YO API Key');
  let res;
  try {
    res = await fetch(`${BASE}/${route}&apiKey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(502, '無法連線到 N2YO'); // the fetch error could echo the URL and key
  }
  let body;
  try { body = await res.json(); } catch { throw new ApiError(502, 'N2YO 回應格式錯誤'); }
  if (body.error) {
    const invalidKey = /api key/i.test(body.error);
    throw new ApiError(invalidKey ? 401 : 502, invalidKey ? 'N2YO API Key 無效' : `N2YO：${body.error}`);
  }
  return body;
}

function getPositions(id) {
  const { lat, lng, alt } = OBSERVER;
  return cached(`positions:${id}`, POSITIONS_TTL, async () => {
    const body = await n2yo(`positions/${id}/${lat}/${lng}/${alt}/${POSITIONS_SECONDS}/`);
    const positions = (body.positions || [])
      .map((p) => ({
        t: p.timestamp, lat: p.satlatitude, lng: p.satlongitude,
        alt: p.sataltitude, az: p.azimuth, el: p.elevation,
      }))
      .filter((p) => Object.values(p).every(Number.isFinite));
    if (!positions.length) throw new ApiError(404, '查無此衛星的位置資料');
    return {
      satid: body.info?.satid ?? Number(id),
      satname: body.info?.satname || `#${id}`,
      transactions: body.info?.transactionscount ?? null,
      positions,
    };
  });
}

function getTle(id) {
  return cached(`tle:${id}`, TLE_TTL, async () => {
    const body = await n2yo(`tle/${id}`);
    const lines = String(body.tle || '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new ApiError(404, '查無此衛星的 TLE');
    return { satid: Number(id), line1: lines[0], line2: lines[1] };
  });
}

// N2YO's own pass predictions. The page computes passes itself with SGP4;
// these exist so tools/check-passes.js can compare against N2YO. Both
// endpoints are limited to 100 requests per hour, hence the long cache.
const PASS_DAYS = 3;
const PASS_ARG = { radio: 10, visual: 1 }; // min elevation (°) / min visible seconds
function getPasses(kind, id) {
  const { lat, lng, alt } = OBSERVER;
  return cached(`${kind}passes:${id}`, 3600e3, async () => {
    const fetchedAt = Date.now(); // N2YO predicts from this moment; the response may be served from cache later
    const body = await n2yo(`${kind}passes/${id}/${lat}/${lng}/${alt}/${PASS_DAYS}/${PASS_ARG[kind]}/`);
    return {
      satid: body.info?.satid ?? Number(id),
      satname: body.info?.satname || `#${id}`,
      days: PASS_DAYS,
      fetchedAt,
      passes: body.passes || [],
    };
  });
}

// Starlink: thousands of satellites, far beyond N2YO's quota, so the whole
// constellation's TLEs come from CelesTrak in one file (no key needed).
// CelesTrak updates it every 2 hours and refuses a repeat download before
// then (HTTP 200 with a plain-text notice), so the file is kept on disk and
// survives restarts; a refused or failed download keeps the old copy.
const STARLINK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle';
// 資料（星鏈 TLE、歷史備份、雲圖歷史）放在固定位置，不放在程式資料夾裡：
// 打包版每一版是不同資料夾，放在程式旁邊的話，換新版累積的歷史就不見了。
// DATA_DIR 可以在 .env 改（測試時也用它隔開，不碰使用者的資料）。
const CACHE_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'SatelliteTracker');
// 1.3.x 以前放在程式資料夾的 .cache/：第一次啟動時搬過來（複製，不覆蓋已有的檔案）
(function migrateOldCache() {
  const old = path.join(__dirname, '.cache');
  try {
    if (path.resolve(old) === CACHE_DIR || !fs.existsSync(old)) return;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.cpSync(old, CACHE_DIR, { recursive: true, force: false, errorOnExist: false });
  } catch (err) {
    console.log(`搬移舊的 .cache 失敗：${err.message}`);
  }
})();
const STARLINK_FILE = path.join(CACHE_DIR, 'starlink.tle');
const STARLINK_TTL = 2.5 * 3600e3;
const STARLINK_RETRY = 30 * 60e3;
let starlink = null;           // { text, fetchedAt }
let starlinkError = null;
let starlinkNextTry = 0;
let starlinkLoading = null;

// Every successful download is also kept as a gzipped, timestamped copy in
// .cache/starlink-history/ (UTC, e.g. 2026-11-11T08-41Z.tle.gz, ~0.4 MB),
// for replaying past times later. Copies older than STARLINK_KEEP_DAYS go.
const HISTORY_DIR = path.join(CACHE_DIR, 'starlink-history');
const STARLINK_KEEP_DAYS = Number(process.env.STARLINK_KEEP_DAYS) || 30;

function archiveStarlink(text, fetchedAt) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(path.join(HISTORY_DIR, `${stampOf(fetchedAt)}Z.tle.gz`), zlib.gzipSync(text));
    const cutoff = Date.now() - STARLINK_KEEP_DAYS * 86400e3;
    for (const name of fs.readdirSync(HISTORY_DIR)) {
      const file = path.join(HISTORY_DIR, name);
      if (name.endsWith('.tle.gz') && fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch (err) {
    console.log(`星鏈歷史備份失敗：${err.message}`);
  }
}

const looksLikeTle = (text) => /^1 [0-9 ]{5}/m.test(text) && /^2 [0-9 ]{5}/m.test(text);

async function refreshStarlink() {
  try {
    let res;
    try {
      res = await fetch(STARLINK_URL, { signal: AbortSignal.timeout(60000) });
    } catch {
      throw new Error('無法連線到 CelesTrak');
    }
    const text = await res.text();
    if (!res.ok || !looksLikeTle(text)) {
      throw new Error(/not updated/i.test(text)
        ? 'CelesTrak 每 2 小時才更新一次，剛下載過，請稍後再試'
        : `CelesTrak 回應錯誤（HTTP ${res.status}）`);
    }
    starlink = { text, fetchedAt: Date.now() };
    starlinkError = null;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(`${STARLINK_FILE}.tmp`, text);
    fs.renameSync(`${STARLINK_FILE}.tmp`, STARLINK_FILE);
    archiveStarlink(text, starlink.fetchedAt);
  } catch (err) {
    starlinkError = err.message;
    starlinkNextTry = Date.now() + STARLINK_RETRY;
  }
}

async function getStarlink() {
  if (!starlink) {
    try {
      const text = fs.readFileSync(STARLINK_FILE, 'utf8');
      if (looksLikeTle(text)) starlink = { text, fetchedAt: fs.statSync(STARLINK_FILE).mtimeMs };
    } catch { /* no saved copy yet */ }
  }
  if ((!starlink || Date.now() - starlink.fetchedAt > STARLINK_TTL) && Date.now() >= starlinkNextTry) {
    starlinkLoading ??= refreshStarlink().finally(() => { starlinkLoading = null; });
    if (!starlink) await starlinkLoading; // first time: wait; otherwise refresh in the background
  }
  if (!starlink) throw new ApiError(503, starlinkError || '星鏈資料下載中');
  return starlink;
}

// Once Starlink has been used (a saved copy exists), keep downloading in the
// background while the server runs, so the history keeps growing even with
// the page closed. getStarlink() itself respects the 2.5 h TTL and retry delay.
setInterval(() => {
  if (starlink || fs.existsSync(STARLINK_FILE)) getStarlink().catch(() => {});
}, 10 * 60e3);

// Cloud imagery: CWA open data O-B0033-001, the Himawari-9 full-disk infrared
// (B13) image, 5500×5500 in the satellite's own geostationary projection
// (140.7°E), with no coastlines or text drawn on it. The opendata API only
// redirects to this public S3 bucket, so no CWA key is needed. A new image
// arrives every 10 minutes; a failed check keeps the previous image.
const CLOUDS_META = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation/O-B0033-001.json';
const CLOUDS_HOST = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/';
const CLOUDS_CHECK = 5 * 60e3; // 新圖每 10 分鐘一張；5 分鐘看一次才不會因為上架時間飄移而漏掉
// 每張新雲圖另存一份到 clouds-history/（檔名是觀測時間，UTC），給回放用；每張約 3.4 MB，保留 CLOUDS_KEEP_HOURS 小時
const CLOUDS_HISTORY_DIR = path.join(CACHE_DIR, 'clouds-history');
const CLOUDS_KEEP_HOURS = Number(process.env.CLOUDS_KEEP_HOURS) || 24;
let clouds = null;             // { image: Buffer, obsTime: ISO string, checkedAt }
let cloudsError = null;
let cloudsLoading = null;

async function refreshClouds() {
  try {
    let meta;
    try {
      meta = await (await fetch(CLOUDS_META, { signal: AbortSignal.timeout(15000) })).json();
    } catch {
      throw new Error('無法取得氣象署雲圖資訊');
    }
    const ds = meta?.cwaopendata?.dataset;
    const obsTime = ds?.ObsTime?.Datetime;
    const url = ds?.Resource?.ProductURL;
    if (!obsTime || typeof url !== 'string' || !url.startsWith(CLOUDS_HOST)) throw new Error('氣象署雲圖資訊格式不符');
    if (!clouds || clouds.obsTime !== obsTime) {
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      } catch {
        throw new Error('無法下載氣象署雲圖');
      }
      const image = Buffer.from(await res.arrayBuffer());
      if (!res.ok || image[0] !== 0xff || image[1] !== 0xd8) throw new Error(`氣象署雲圖下載失敗（HTTP ${res.status}）`);
      clouds = { image, obsTime, checkedAt: Date.now() };
      archiveClouds(image, obsTime);
    } else {
      clouds.checkedAt = Date.now();
    }
    cloudsError = null;
  } catch (err) {
    cloudsError = err.message;
    if (clouds) clouds.checkedAt = Date.now(); // keep the old image; try again next period
  }
}

// 歷史檔名：UTC 時間到分鐘，例如 2026-11-11T22-20Z.jpg、2026-11-11T21-39Z.tle.gz
const stampOf = (ms) => new Date(ms).toISOString().slice(0, 16).replace(':', '-');
const HISTORY_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})Z\.(?:jpg|tle\.gz)$/;
const timeOfName = (name) => {
  const m = name.match(HISTORY_NAME);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) : NaN;
};

function archiveClouds(image, obsTime) {
  try {
    fs.mkdirSync(CLOUDS_HISTORY_DIR, { recursive: true });
    const file = path.join(CLOUDS_HISTORY_DIR, `${stampOf(Date.parse(obsTime))}Z.jpg`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, image);
    const cutoff = Date.now() - CLOUDS_KEEP_HOURS * 3600e3;
    for (const name of fs.readdirSync(CLOUDS_HISTORY_DIR)) {
      if (name.endsWith('.jpg') && timeOfName(name) < cutoff) fs.unlinkSync(path.join(CLOUDS_HISTORY_DIR, name));
    }
  } catch (err) {
    console.log(`雲圖歷史備份失敗：${err.message}`);
  }
}

// 回放用：列出有哪些歷史資料（時間由舊到新）
function listHistory(dir, ext) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(ext) && Number.isFinite(timeOfName(name)))
      .map((name) => ({ t: timeOfName(name), file: name }))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

// 開過一次雲圖之後（有歷史資料夾），伺服器開著就在背景持續存，網頁關掉也一樣
setInterval(() => {
  if (clouds || fs.existsSync(CLOUDS_HISTORY_DIR)) getClouds().catch(() => {});
}, CLOUDS_CHECK);

async function getClouds() {
  if (!clouds || Date.now() - clouds.checkedAt > CLOUDS_CHECK) {
    cloudsLoading ??= refreshClouds().finally(() => { cloudsLoading = null; });
    if (!clouds) await cloudsLoading; // first time: wait; otherwise refresh in the background
  }
  if (!clouds) throw new ApiError(503, cloudsError || '雲圖下載中');
  return clouds;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(pathname, res) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(PUBLIC_DIR, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }

  if (pathname === '/api/config') {
    sendJson(res, 200, { observer: OBSERVER, hasKey: Boolean(apiKey()), version: VERSION });
    return;
  }
  if (pathname === '/api/starlink') {
    try {
      const { text, fetchedAt } = await getStarlink();
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Fetched-At': String(Math.round(fetchedAt)),
      });
      res.end(text);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.status ? err.message : '伺服器錯誤' });
    }
    return;
  }
  if (pathname === '/api/clouds') {
    try {
      const { image, obsTime } = await getClouds();
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Obs-Time': obsTime });
      res.end(image);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.status ? err.message : '伺服器錯誤' });
    }
    return;
  }
  if (pathname === '/api/history') {
    sendJson(res, 200, {
      starlink: listHistory(HISTORY_DIR, '.tle.gz'),
      clouds: listHistory(CLOUDS_HISTORY_DIR, '.jpg'),
    });
    return;
  }
  const histMatch = pathname.match(/^\/api\/(starlink|clouds)\/history\/([^/]+)$/);
  if (histMatch) {
    const [, kind, name] = histMatch;
    const ok = HISTORY_NAME.test(name) && name.endsWith(kind === 'starlink' ? '.tle.gz' : '.jpg');
    if (!ok) { sendJson(res, 400, { error: '檔名不對' }); return; }
    fs.readFile(path.join(kind === 'starlink' ? HISTORY_DIR : CLOUDS_HISTORY_DIR, name), (err, data) => {
      if (err) { sendJson(res, 404, { error: '找不到這份歷史資料' }); return; }
      res.writeHead(200, kind === 'starlink'
        ? { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'max-age=86400' }
        : { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400', 'X-Obs-Time': new Date(timeOfName(name)).toISOString() });
      res.end(data);
    });
    return;
  }
  const passMatch = pathname.match(/^\/api\/passes\/(radio|visual)\/(\d{1,6})$/);
  if (passMatch) {
    try {
      sendJson(res, 200, await getPasses(passMatch[1], passMatch[2]));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.status ? err.message : '伺服器錯誤' });
    }
    return;
  }
  const match = pathname.match(/^\/api\/(positions|tle)\/(\d{1,6})$/);
  if (match) {
    try {
      sendJson(res, 200, await (match[1] === 'positions' ? getPositions(match[2]) : getTle(match[2])));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.status ? err.message : '伺服器錯誤' });
    }
    return;
  }
  if (pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'Not found' }); return; }
  serveStatic(pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`台灣上空衛星 ${VERSION}：http://localhost:${PORT}`);
  if (!apiKey()) console.log('尚未設定 N2YO_API_KEY，請見 README.md');
});
