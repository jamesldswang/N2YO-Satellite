---
name: satellite-tracker
description: 修改、測試「台灣上空衛星」網頁（D:\Personal_Git\satellite-tracker，Node 伺服器 + Three.js，N2YO API 的衛星即時位置，以台灣為中心，有加速模擬）。只要使用者要改這個專案的功能或畫面、修 bug、加衛星、調整模擬、更新版號或 README，就先載入這個 skill。
---

# 台灣上空衛星

本機 Node 伺服器（`server.js`，沒有任何 npm 套件）提供 `public/` 的靜態頁面，並代理 N2YO REST API。頁面用 Three.js 畫地球和衛星，用 satellite.js 做 SGP4。使用者用繁體中文溝通，回覆、程式註解、UI 文字也都用繁體中文。

## 檔案

| 檔案 | 內容 |
|------|------|
| `server.js` | 靜態伺服器 + `/api/config`、`/api/positions/:id`、`/api/tle/:id`。觀測點 `OBSERVER`、快取（`cached()`）、版號從 `package.json` 讀 |
| `public/app.js` | **前端全部邏輯**：場景、地球 shader、觀測點座標系、衛星資料抓取、位置計算、清單、視角切換、加速模擬 |
| `public/index.html` | 頁面骨架；importmap 載入 three@0.170.0，`<script>` 載入 satellite.js@5.0.0 |
| `public/style.css` | 樣式，顏色變數在 `:root` |
| `tools/check-sgp4.js` | 測試：比對 SGP4 和 N2YO 的位置（`npm run check`） |
| `start.cmd` / `start.vbs` | 啟動檔（有視窗／背景）。優先用同資料夾的 `node.exe`；沒有 `.env` 就從範本建立並開記事本。**兩個檔案只能用 ASCII 文字**（cmd、WSH 讀中文會亂碼），換行固定 CRLF（`.gitattributes`） |
| `build.js` | 打包（`npm run dist`）→ `dist/SatelliteTracker-<版號>-win-x64/` 和 `.zip` |
| `tools/release.sh`、`tools/release-body.js` | 建立 GitHub Release 並上傳 zip，說明取自 README 版本紀錄 |
| `.env` | `N2YO_API_KEY`（**不在 git 裡，絕對不要 commit 或印出金鑰**）、可選 `PORT` |
| `README.md` | 給使用者看的說明，最後有「版本紀錄」 |

## 每次修改後的流程

1. **改程式**：畫面和功能改 `public/`；API、快取、觀測點改 `server.js`。
2. **測試**（見下一節）。改 `server.js`、`.env`、`package.json` 要重新啟動伺服器；改 `public/` 只要重新整理頁面。
3. **更新 `README.md`**：功能表格、自訂表格、專案結構，以及「版本紀錄」。解決了「已知限制」裡的某一條，就把那一條刪掉。
4. 版號在 `package.json` 的 `version`，頁面標題旁會自動顯示。使用者沒說要改就不要動，但 README 開頭的「版本」和版本紀錄要跟它一致。
5. 使用者要求時才 commit / push。遠端是 `https://github.com/jamesldswang/N2YO-Satellite.git`，分支 `main`。
6. 使用者要 release 時：確認 README 版本紀錄有該版段落、已 push → `npm run dist` → 解壓到 scratchpad，用裡面的 `node.exe` 換個 `PORT` 實際跑一次（測完刪掉，因為測試時會放 `.env`）→ `bash tools/release.sh`。Release 的 tag 指向 `main`，所以一定要先 push。沒有 `gh` CLI，release.sh 用 `git credential fill` 取 token 打 GitHub API。

## 測試

- **API**：`curl -s localhost:8000/api/config`、`/api/positions/25544`、`/api/tle/25544`。
- **SGP4 和 N2YO 一致性**：`npm run check`（要先啟動伺服器）。每顆都要 `OK`，平常誤差約 0.1°。
- **語法**：`node --check public/app.js`、`node --check server.js`。
- **畫面**：請使用者重新整理 http://localhost:8000 看；或用瀏覽器工具截圖。
- 每次查 `positions`、`tle` 都會用掉 N2YO 額度（每小時各 1000 次），伺服器有快取（positions 200 秒、TLE 6 小時、錯誤 30 秒）。測試不要寫成迴圈狂打 API。

## 一定要知道的限制與踩過的坑

- **N2YO 沒有 CORS header**，瀏覽器不能直接呼叫，所以一定要經過 `server.js` 代理。這也讓金鑰留在伺服器端。
- **N2YO 文件裡的範例金鑰是無效的**，要用使用者自己在 n2yo.com 個人資料頁產生的金鑰。
- **`process.loadEnvFile` 需要 Node 20.12 以上**，所以不需要 dotenv。
- **`loadEnvFile` 不會覆蓋已存在的變數**：`.env.example` 的 `N2YO_API_KEY=` 會先把它設成空字串，之後再讀也蓋不掉。所以 `apiKey()` 在沒金鑰時用 `util.parseEnv` 自己讀 `.env`，讓使用者第一次填金鑰後重新整理頁面就生效。
- **不能打包成單一 .exe**：Node SEA 要把程式注入 `node.exe`，簽章失效，會被 Windows 11 智慧型應用程式控制擋。`build.js` 直接複製原版 `node.exe`（hash 不變）。壓 zip 用 `C:\Windows\System32\tar.exe`（bsdtar），Git Bash 的 GNU tar 不支援 zip。
- **打包版絕對不能含 `.env`**：`build.js` 只複製白名單檔案，改的時候不要改成整個資料夾複製。
- **fetch 失敗的錯誤訊息可能含網址（也就含金鑰）**，`n2yo()` 刻意把錯誤換成固定文字，改的時候不要把原始錯誤丟回前端。
- **`positions` 一次最多 300 秒**。即時模式用這 300 個點做內插，剩不到 90 秒時再抓。
- **加速模擬不能用 `positions`**：200 倍時 300 秒的資料 1.5 秒就用完，額度會爆。所以模擬時 `updateSat()` 走 `stateFromTle()`（SGP4），`poll()` 也會跳過 positions；只有即時模式走 `stateFromSamples()`。
- **satellite.js 的 `propagate()` 失敗時 `position` 是 `false`**（例如衛星已墜落），要先檢查。
- **在 Node 的 `vm` context 裡跑 satellite.js 時，傳進去的 `Date` 要用那個 context 的 `Date`**，否則 `instanceof Date` 失敗、結果全是 NaN（`tools/check-sgp4.js` 已處理）。
- **觀測點高度**：`OBSERVER.alt` 是公尺（N2YO 的單位），給 satellite.js 時要換成公里。
- **場景座標**：地球半徑 = 1，固定不轉，+X = 0°E、+Y = 北、−Z = 90°E，用 `geoToVec(lat, lng, altKm)` 轉換。台灣永遠在同一個位置，太陽方向（`subsolarPoint`）會動。
- **兩段內插的經度跨 ±180°** 問題：在 3D 向量上內插（`lerp`），不要直接內插經度；方位角內插要處理 0/360 的環繞。
- **模擬時鐘**：所有和「現在幾點」有關的計算都要用 `clockMs()`，不要直接用 `Date.now()`；只有 API 抓取排程（`poll()`、`nextFetch`、`nextTle`）用真實時間。改倍速時 `setSim()` 會從目前的模擬時刻接續。
- **軌道線**依模擬時間重算：`pathAt` 記錄上次計算的時刻，差超過 30 秒（模擬時間）就重畫。
- **使用者輸入**：NORAD 編號只接受整數；衛星名稱來自 N2YO，一律用 `textContent`，不要用 `innerHTML`。
- **瀏覽器記住的清單**（localStorage `tracked-satellites`）會蓋過 `DEFAULT_IDS`。
- 這台電腦是 Windows，git 會出現 LF → CRLF 的警告，不影響。

## 功能清單（改之前先看有沒有現成的函式可以用）

- **衛星生命週期**：`createSat(id)`、`removeSat(s)`、`saveIds()`、`loadIds()`。
- **資料抓取**：`api(path)`、`loadPositions(s, now)`、`loadTle(s, now)`、`poll()`（每 250 毫秒由 `tickSlow()` 呼叫）。
- **位置**：`sampleAt()`、`stateFromSamples(s, sec)`（即時）、`stateFromTle(s, ms)`（模擬）、`updateSat(s, ms)`（每幀）。`s.state = { alt, lat, lng, az, el }`，`s.pos` 是場景座標。
- **軌道線**：`updatePath(s, ms)`。
- **清單**：`makeRow(s)`、`refreshList()`（依仰角排序）、`select(id)`、`renderCount()`。
- **視角**：`setView('space' | 'sky')`、`homeSpace()`、`aimSky()`、`skyDirection(az, el)`、`updateHint()`。
- **標籤**：`makeLabel()`、`placeLabel()`、`hiddenByEarth()`、`updateLabels()`。
- **模擬**：`sim`（`null` 或 `{ fromSim, fromReal, speed }`）、`clockMs()`、`setSim(speed | null)`。
- **主迴圈**：`frame()`（requestAnimationFrame）、`tickSlow()`（每 250 毫秒：時鐘、太陽、軌道線、清單、poll）。
