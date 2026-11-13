// 長期資料收集（給之後做預測用）：伺服器開著就在背景跑，不用開網頁。
//
// 1. 氣象測站：氣象署 O-A0003-001（署屬＋主要測站約 360 站，每 10 分鐘更新），
//    存成 weather-history/<台灣日期>.csv（UTF-8 加 BOM，Excel 直接開），
//    前幾天的檔案自動壓成 .csv.gz。一天約 5 MB，壓縮後約 1 MB。
// 2. 東亞雲圖：氣象署 O-B0032-003（向日葵東亞紅外線黑白，1200 px，每張約 380 KB），
//    每 CLOUDS_ARCHIVE_EVERY_MIN 分鐘（預設 60）存一張到 clouds-eastasia/<UTC 年-月>/。
//    完整的全盤面雲圖太大（每張 3.6 MB），只留 24 小時給回放（見 server.js）。
//
// 兩者都在氣象署公開的 S3 上，不用授權碼。預設永久保留；.env 可設
// WEATHER_KEEP_DAYS、CLOUDS_ARCHIVE_KEEP_DAYS（天數，0 = 永久）、COLLECT=0（整個關掉）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S3 = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation/';
const CHECK_MS = 5 * 60e3; // 資料每 10 分鐘一筆；5 分鐘看一次才不會漏
const num = (v, d) => Number(v) || d;

const COLUMNS = [
  'obs_time', 'station_id', 'station_name', 'county', 'lat', 'lon', 'alt_m',
  'temp_c', 'humidity_pct', 'pressure_hpa', 'wind_dir_deg', 'wind_speed_ms',
  'gust_ms', 'precip_mm', 'sunshine_h', 'uv_index', 'weather',
];

// 氣象署缺測是 -99、-999 之類；一律寫成空白
const val = (v) => {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return /^-9{2,}(\.0+)?$/.test(s) ? '' : s;
};
const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// 台灣日期（UTC+8），檔名用：2026-11-13
const taipeiDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

function stationRow(st) {
  const w = st.WeatherElement || {};
  const geo = st.GeoInfo || {};
  const wgs = (geo.Coordinates || []).find((c) => c.CoordinateName === 'WGS84') || {};
  return [
    st.ObsTime?.DateTime, st.StationId, st.StationName, geo.CountyName,
    wgs.StationLatitude, wgs.StationLongitude, geo.StationAltitude,
    w.AirTemperature, w.RelativeHumidity, w.AirPressure, w.WindDirection, w.WindSpeed,
    w.GustInfo?.PeakGustSpeed, w.Now?.Precipitation, w.SunshineDuration, w.UVIndex, w.Weather,
  ].map((v) => csvCell(val(v)));
}

function startCollector(dataDir, log = console.log) {
  if (process.env.COLLECT === '0') return;
  const weatherDir = path.join(dataDir, 'weather-history');
  const cloudDir = path.join(dataDir, 'clouds-eastasia');
  const weatherKeep = num(process.env.WEATHER_KEEP_DAYS, 0);
  const cloudKeep = num(process.env.CLOUDS_ARCHIVE_KEEP_DAYS, 0);
  const cloudEvery = Math.max(10, num(process.env.CLOUDS_ARCHIVE_EVERY_MIN, 60));

  // ---------- 氣象測站 ----------
  const seen = new Map(); // 檔名 -> Set(`${站號}|${觀測時間}`)，避免同一筆重複寫
  function seenFor(file) {
    if (!seen.has(file)) {
      const set = new Set();
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
          const [t, id] = line.split(',');
          if (id) set.add(`${id}|${t}`);
        }
      } catch { /* 新檔案 */ }
      seen.clear(); // 只留今天（和跨日那一刻）的
      seen.set(file, set);
    }
    return seen.get(file);
  }

  // 前幾天的 .csv 壓成 .csv.gz；超過保留天數的刪掉
  function tidyWeather() {
    const today = taipeiDate(Date.now() - 3600e3); // 過午夜一小時才壓縮前一天，晚到的 23:50 那筆還寫得進去
    for (const name of fs.readdirSync(weatherDir)) {
      const m = name.match(/^(\d{4}-\d{2}-\d{2})\.csv(\.gz)?$/);
      if (!m) continue;
      const file = path.join(weatherDir, name);
      if (weatherKeep && Date.parse(m[1]) < Date.now() - (weatherKeep + 1) * 86400e3) { fs.unlinkSync(file); continue; }
      if (!m[2] && m[1] < today) {
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
        fs.unlinkSync(file);
      }
    }
  }

  async function collectWeather() {
    const res = await fetch(`${S3}O-A0003-001.json`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stations = (await res.json())?.cwaopendata?.dataset?.Station;
    if (!Array.isArray(stations)) throw new Error('格式不符');
    fs.mkdirSync(weatherDir, { recursive: true });
    const byFile = new Map();
    for (const st of stations) {
      const t = st.ObsTime?.DateTime;
      const ms = Date.parse(t);
      if (!st.StationId || !Number.isFinite(ms)) continue;
      const file = path.join(weatherDir, `${taipeiDate(ms)}.csv`);
      if (fs.existsSync(`${file}.gz`)) continue; // 那天已經收完、壓縮了
      const set = seenFor(file);
      const key = `${st.StationId}|${t}`;
      if (set.has(key)) continue;
      set.add(key);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(stationRow(st).join(','));
    }
    for (const [file, rows] of byFile) {
      const head = fs.existsSync(file) ? '' : `﻿${COLUMNS.join(',')}\n`;
      fs.appendFileSync(file, `${head}${rows.join('\n')}\n`);
    }
    tidyWeather();
  }

  // ---------- 東亞雲圖 ----------
  async function collectClouds() {
    const meta = await (await fetch(`${S3}O-B0032-003.json`, { signal: AbortSignal.timeout(15000) })).json();
    const ds = meta?.cwaopendata?.dataset;
    const ms = Date.parse(ds?.ObsTime?.Datetime);
    const url = ds?.Resource?.ProductURL;
    if (!Number.isFinite(ms) || typeof url !== 'string' || !url.startsWith(S3)) throw new Error('格式不符');
    if (Math.round(ms / 60e3) % cloudEvery !== 0) return; // 只存整點（或設定的間隔）
    const stamp = new Date(ms).toISOString().slice(0, 16).replace(':', '-');
    const dir = path.join(cloudDir, stamp.slice(0, 7));
    const file = path.join(dir, `${stamp}Z.jpg`);
    if (fs.existsSync(file)) return;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const image = Buffer.from(await res.arrayBuffer());
    if (!res.ok || image[0] !== 0xff || image[1] !== 0xd8) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, image);
    fs.renameSync(`${file}.tmp`, file);
    if (cloudKeep) {
      const cutoff = Date.now() - cloudKeep * 86400e3;
      for (const month of fs.readdirSync(cloudDir)) {
        const mdir = path.join(cloudDir, month);
        for (const name of fs.readdirSync(mdir)) {
          const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})Z\.jpg$/);
          if (m && Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) < cutoff) fs.unlinkSync(path.join(mdir, name));
        }
        if (!fs.readdirSync(mdir).length) fs.rmdirSync(mdir);
      }
    }
  }

  // 失敗只記一次，恢復時再記一次，不要每 5 分鐘洗版
  const failing = new Set();
  const run = (name, job) => job().then(() => {
    if (failing.delete(name)) log(`${name}收集恢復正常`);
  }, (err) => {
    if (!failing.has(name)) log(`${name}收集失敗（之後會自動重試）：${err.message}`);
    failing.add(name);
  });
  const tick = () => { run('氣象測站', collectWeather); run('東亞雲圖', collectClouds); };
  tick();
  setInterval(tick, CHECK_MS);
}

module.exports = { startCollector, stationRow, COLUMNS };
