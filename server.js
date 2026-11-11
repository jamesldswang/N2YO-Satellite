'use strict';
// Local proxy for the N2YO REST API, plus a static file server for public/.
// N2YO sends no CORS header, so the browser cannot call it directly, and this
// also keeps the API key out of client code.
const http = require('http');
const fs = require('fs');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env is optional */ }

const API_KEY = (process.env.N2YO_API_KEY || '').trim();
const BASE = process.env.N2YO_BASE || 'https://api.n2yo.com/rest/v1/satellite';
const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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
  if (!API_KEY) throw new ApiError(401, '尚未設定 N2YO API Key');
  let res;
  try {
    res = await fetch(`${BASE}/${route}&apiKey=${encodeURIComponent(API_KEY)}`, {
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
    sendJson(res, 200, { observer: OBSERVER, hasKey: Boolean(API_KEY) });
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
  console.log(`衛星追蹤：http://localhost:${PORT}`);
  if (!API_KEY) console.log('尚未設定 N2YO_API_KEY，請見 README.md');
});
