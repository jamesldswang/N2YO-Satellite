---
name: satellite-tracker
description: 修改、測試「台灣上空衛星」網頁（D:\Personal_Git\satellite-tracker，Node 伺服器 + Three.js，N2YO API 的衛星即時位置，以台灣為中心，有加速模擬）。只要使用者要改這個專案的功能或畫面、修 bug、加衛星、調整模擬、更新版號或 README，就先載入這個 skill。
---

# 台灣上空衛星

本機 Node 伺服器（`server.js`，沒有任何 npm 套件）提供 `public/` 的靜態頁面，並代理 N2YO REST API。頁面用 Three.js 畫地球和衛星，用 satellite.js 做 SGP4。使用者用繁體中文溝通，回覆、程式註解、UI 文字也都用繁體中文。

## 檔案

| 檔案 | 內容 |
|------|------|
| `server.js` | 靜態伺服器 + `/api/starlink`（CelesTrak 星鏈 TLE）、`/api/clouds`、`/api/history`、`/api/starlink|clouds/history/<檔名>`（回放用）、`/api/config`、`/api/positions/:id`、`/api/tle/:id`、`/api/passes/radio|visual/:id`（N2YO 過境預報，只給測試工具用，快取 1 小時）。觀測點 `OBSERVER`、快取（`cached()`）、版號從 `package.json` 讀 |
| `public/app.js` | **前端全部邏輯**：場景、地球 shader、觀測點座標系、衛星資料抓取、位置計算、清單、視角切換、加速模擬 |
| `public/models.js` | 衛星 3D 模型（ES module），金屬外皮（`MATERIALS` 的金屬度、程式產生的紋理 `getTextures()` 共用；**要有 `scene.environment`（app.js 的 RoomEnvironment），不然金屬是黑的**）：`makeSatModel(kind)`、`modelKind(id, satrec)`、`setModelLit(g, lit)`、`disposeModel(g)`。模型座標 +X 側向、+Y 天頂、+Z 前進方向，建好後自動縮放到最長邊 = 1 |
| `public/starlink.js` | 星鏈圖層 `StarlinkLayer`（ES module）：`enable()`、`disable()`、每幀 `update(ms, up, fast)`、`updateModels(camera, viewPx, sunDir)`。Points 一個 draw call 畫上萬顆；離鏡頭最近的 `MODEL_MAX` 顆另外畫 3D 模型（`makeSatModel('starlink')`，重複使用），畫面大小 = `MODEL_PX × MODEL_REF_KM ÷ 距離`，小於 `MODEL_MIN_PX` 就不畫 |
| `public/starlink-worker.js` | Web Worker：解析整份星鏈 TLE，`tick` 時算出全部的場景座標位置和速度（Float32Array，用 transfer 傳回） |
| `public/clouds.js` | 衛星雲圖圖層 `CloudLayer`（ES module）：`enable()`、`disable()`、`load()`；`status`、`obsTime`。比地球大一點的球，shader 用靜止衛星公式取樣 |
| `public/planets.js` | 行星日心黃道位置（AU）：JPL「Approximate Positions of the Planets」表 1（1800–2050），`PLANETS`、`planetPosition(p, ms)`、`planetOrbit(p, ms, n)`、`periodDays(p)`。純計算、不依賴 three.js，可以直接用 `node -e "import('./public/planets.js')…"` 驗證（2026-11-26 地球日心黃經約 63°） |
| `public/solar-system.js` | 太陽系示意 `SolarSystem(canvas, earthMapUniform)`：自己的 `scene`、`camera`、`OrbitControls`（同一個 canvas，`setOn()` 切換 enabled），標籤層 `#solar-labels`（插在 `#labels` 後面，才不會蓋到清單）。座標：黃道 x → +X、黃道北 → +Y、黃道 y → −Z；距離 `SCALE × √AU`。地球共用地球畫面的貼圖、依 GMST 和黃赤交角擺方向；月亮用 `sun-moon.js` 的 `moonEcliptic(ms)`，距離 `MOON_DIST ×` 地球放大倍數。`MIN_PX` 讓行星拉遠時不會看不見。app.js：`setSolar(on)`（`body.solar` 隱藏 `#labels`、`#altitude`；`frame()` 在示意模式只畫 solar 場景就 return；`tickSlow()` 跳過 `updatePath`、`updatePasses`、`applyHistory`；`setSimMax()` 換倍速上限，自動開的倍速退出時依「倍速值」還原，不是滑桿位置；指標事件都先檢查 `solarOn()`）。網址 `?solar=1` 直接進入（不記在 localStorage） |
| `public/lunar.js`、`public/lunar-math.js` | 月球視角 `LunarView(canvas, earthMapUniform, texBase)`，結構同 `SolarSystem`（自己的 scene／camera／OrbitControls，標籤層 `#lunar-labels`）。單位 1 = 月球半徑（1737.4 km），黃道座標對應同太陽系。資料：`server.js` 的 `/api/lunar/<UTC 日期>` 代理 JPL Horizons（`CENTER='500@301'`、`REF_PLANE=ECLIPTIC`、`VEC_TABLE=2`、10 分鐘一筆、一次 4 天（`LUNAR_BLOCK_DAYS`，從 1970-01-01 起對齊，前端 `blockOf()` 要一致）；`LUNAR_BODIES`：LRO −85、Danuri −155、Chandrayaan-2 −152、ARTEMIS P1／P2 = THEMIS-B／C −192／−193、地球 399、太陽 10），**Horizons 同 IP 並行請求會 503，所以一個一個抓**、失敗重試一次，快取 6 小時；**星曆在段落中間結束（或開始）時 Horizons 整段都不給**，`horizonsVectors()` 讀錯誤訊息的「No ephemeris … after A.D. 2026-DEC-20 …」縮短 STOP_TIME 再抓（`horizonsTime()` 解析），並在 body 加 `until`／`from`（UTC 毫秒），前端 `bodyError()` 顯示「JPL 星曆只到 某天」、`allPast()` 全部過期時提示回到即時；時間是 TDB，`t0` 已減 69.184 秒換成 UTC。`lunar-math.js`（純計算，可用 node 驗證）：`moonAxes(ms)` IAU 2009 月球自轉模型（已和 Horizons 的 sub-observer 經緯度比對，差 < 0.01°）、`stateAt(body, ms)` Hermite 內插（10 分鐘一筆實測 0.3 km）、`keplerOrbit(state)` 畫軌道橢圓。月球貼圖：先 CDN 的 `moon_1024.jpg`，再依序換 `public/textures/moon_4096.jpg`、`moon_8192.jpg`（`MAX_TEXTURE_SIZE` ≥ 8192 才載，Solar System Scope 8k_moon，CC BY 4.0，提示列有標出處；NASA SVS CGI Moon Kit 的檔案會擋程式下載 403），經度方向和舊圖一致（中央 = 0°）；地球畫面 `sun-moon.js` 換到 4096。繞月衛星 3D 模型：`models.js` 的 `lro`、`danuri`、`chandrayaan2`、`artemis`（`MODEL_KIND` 對應 Horizons id），`LunarView.placeModels()` 每幀擺放（−Y 朝月心、+Z 沿速度，大小 `MODEL_PX` 40／選取 60 像素、上限離月面高度 × 1.6；小於 `DOT_BELOW_PX` 才顯示 Points 圓點；月球圓柱影子 `setModelLit`）；金屬材質要環境反射，app.js 建 LunarView 後設 `lunar.scene.environment = scene.environment`。鏡頭：`controls.zoomToCursor = true`，`focusUnderCursor()`（canvas `wheel` capture 監聽，比 OrbitControls 先跑）在游標指到月面時把 `controls.target` 沿視線移到那點的深度（畫面不動），縮放就往那點靠近、速度依離月面距離；`minDistance` 0.005（離 target），`adjustCamera()` 擋鏡頭離月面至少 5 km；`zoomSpeed` 不再依高度調慢；游標沒指到月面時 `zoomToCursor = false`（往空處放大月球會跑出畫面）；雙擊 `recenter()` target 回原點；`#reset`（重置視角）在月球視角呼叫 `lunar.resetView()`（`placeCamera()`）；`select()` 轉鏡頭時也把 target 歸零。月球球體：+X = 經度 0°、+Y = 北極、−Z = 東經 90°（`makeBasis(x, z, −y)`）。第一次鏡頭擺在太陽那側（月球亮面）。app.js：`setLunar(on)`（和 `setSolar` 互斥；`body.lunar`；自動 60× 加速，退出時倍速沒改過就回即時）、`otherView()` = 太陽系或月球視角（地球畫面相關的指標事件、tickSlow 的軌道線／過境／回放都用它判斷）；`frame()` 在 `otherView()` 時仍呼叫 `updateSat()`，右邊清單才有仰角。追蹤清單：月球視角時藏 `#list`、`#quota`、過境預報分頁，改顯示 `#lunar-list`；`#add` 保留但改成加回被移除的繞月衛星（`addSat()`、`renderAddMenu()`、`setMenuIndex()`、submit 都有 `lunarOn()` 分支，選單來自 `lunarMenuItems()`），× 呼叫 `setLunarHidden(id, hide)` → `lunar.setHidden()`（`lunar.hidden` Set，id 是字串如 '-85'），存 localStorage `lunar-hidden`，第一次進月球視角時 `loadLunarHidden()`；被移除的不畫、不列、不算進 `missing()`／`allPast()`（`renderLunarList()` 由 tickSlow 呼叫，資料來自 `lunar.listInfo(ms)`；點選 `lunar.select(id)`；簡介 `LUNAR_INFO` 用 `showInfoTip()`）。上方 `地球｜月球｜太陽系` 是 `.segmented`（`#earth-view`、`#lunar-toggle`、`#solar-toggle`），`updateSceneButtons()` 設 `.active`。`frame()` 在 `otherView()` 時也呼叫 `updateSun()`、`sunMoon.update()`，上方太陽月亮的仰角才對。「自轉」（`spin`，按鈕原名「地球自轉」）在月球視角也有效：`lunar.spin = spin`；關閉時 `LunarView.update()` 用月球方向的變化量 `dq` 轉鏡頭、`controls.target`、星空（鏡頭跟著月球轉），開啟時太空固定。`setSpin()` 在月球視角時：打開一律 `raiseLunarSpinSpeed()` 拉到 10000×（`LUNAR_SPIN_SPEED` = `SIM_MAX_SPEED`，2000× 使用者還是覺得月球沒轉），關掉回 `lunarSpinPrev`，不走地球的 200× 邏輯；離開月球視角時自轉開著就回 200×。星曆過了半段就先抓下一段（10000× 一段 4 天只要 35 秒，抓一段約 5 秒）。網址 `?lunar=1`。Horizons 沒有星曆時（例如 CAPSTONE 只到 2026-08）該衛星不顯示，`missing()` 的文字接在提示列 |
| `public/sun-moon.js` | 太陽、月亮 `SunMoon`（ES module）：每幀 `update(ms, sunDir, camera, viewPx)`；`sunOn`、`moonOn`、`sunPos`（sunDir × 300，相機 far 400）、`moonPos`（真實距離，約 60 地球半徑）、`moonInfo`（`illum`、`elong` 往東量的距角）。`moonPosition(ms)` 是天文年曆低精度公式（約 0.3°），`phaseName(elong)`。太陽畫在 `sunDrawPos = camera.position + sunDir × camera.far × 0.7`（標籤用它），算仰角方位用真實距離的 `sunPos`（sunDir × AU）。月球軌道線 `orbit`（LineLoop，一個恆星月，用同一個 GMST 換算，`MOON_ORBIT_EVERY_MS` 重算，每幀 `rotation.y = −Δgmst`）。月球貼圖 `${TEX}/moon_1024.jpg`，球的 +X（貼圖中央）朝地球、+Y 朝北；太小時放大：台灣仰望 `MOON_MIN_PX_SKY`（36），太空俯瞰 `MOON_MIN_PX_SPACE`（4，幾乎真實比例，和地球的大小比例才對）；`update(…, sky)` 由 app.js 傳 `view === 'sky'`。太陽、月亮一直顯示（app.js 建好就設 `sunOn = moonOn = true`，沒有按鈕、localStorage、網址參數；設定列 `.body-name` 文字 + `#sun-info`、`#moon-info`）。app.js 的 `lookFromTaiwan(world)`、`renderSunMoonInfo()`（tickSlow）、`placeSunMoonLabels()`（updateLabels） |
| `public/tail.js` | 彗星尾巴：`makeTail(color)`、`setTailPoints(mesh, pts)`（`TAIL_POINTS` 個點，[0] 是頭）、`disposeTail()`、`tailResolution`（resize 時用 `renderer.getDrawingBufferSize` 更新）。頂點 shader 把每點往螢幕法線推開 `widthPx`（畫布實際像素，app.js 乘 `getPixelRatio()`），加法混色。**一定要 `side: DoubleSide`**，帶子在螢幕上的繞向不固定，否則整條被背面剔除、看不到。app.js 的 `updateTail()`（updateSat 每幀呼叫）用 SGP4 算過去 `TAIL_FRACTION`（週期的 10%）的點，整條平移到 `s.pos` 接上頭；週期 > 1300 分鐘不畫 |
| `public/sat-info.js` | 追蹤清單 hover 簡介：`satInfo(s)` → `{ title, kind, text, facts }`。先查 `BY_ID`（NORAD 編號），再比 `BY_NAME`（名稱正規表示式，順序有意義，例如 FORMOSAT-7 要在 FORMOSAT 前面），都沒有就用軌道高度（`orbitText()`）。app.js 的 `showSatTip()`／`hideSatTip()`，`#sat-tip` 是 `position: fixed`，放在 `#panel` 左邊。`CATALOG`（BY_ID 的 id、name、kind）給「加入」下拉選單：app.js 的 `renderAddMenu()`、`setMenuIndex()`、`addSat(id)`；選項 `mousedown` 要 preventDefault，不然輸入框 blur 會先把選單關掉。BY_ID 新增衛星要寫 `en`（英文名稱，選單顯示、`initialName(id)` 給剛加入還沒拿到 N2YO 名稱的衛星用）和 `name`（中文，只用來搜尋）。選單不顯示 NORAD 編號 |
| `public/weather.js` | 溫度／風圖層 `WeatherLayer`（ES module）：`enable()`、`disable()`、每幀 `update(visible)`、`summary()`。資料來自 `server.js` 的 `/api/weather`（氣象署 O-A0003-001，快取 3 分鐘，缺測變 null）。Points 依溫度上色 + LineSegments 箭頭往下風處；固定像素大小，每像素 3→6 km 淡出。app.js 的 `setWeather()`、`renderWeatherInfo()`，localStorage `weather-enabled`、網址 `?weather=1`。回放：`showAt(ms, archive.weather, sim)`（applyHistory 呼叫）載入 `/api/weather/history/<台灣日期>`（server.js `readWeatherDay()` 解析 collector 的 CSV／.csv.gz，整天 gzip JSON：`stations` + `frames: [{ t, v: [溫度, 風向, 風速] × 站數 }]`，過去的天永久快取、今天 5 分鐘），畫 t ≤ ms 的最後一格（當天沒有就看前一天）；即時資料存在 `live`，`display(entry)` 換畫哪一組。回放起點最多 24 小時前（`WEATHER_REPLAY_MS`）。歷史 JSON 的欄位由 server.js `WEATHER_FIELDS` 決定（回傳 `fields`，前端照名稱套用，和 `/api/weather` 的測站欄位同名）。`pick(clientX, clientY)` 找游標下的測站（點半徑 + 4 px）。app.js：按鈕開啟時 `flyTo(up, WEATHER_HOME_KM)`（800 km）；點擊（canvas pointerdown／up 移動 ≤ 5 px）→ 測站或 `earthPointAt()` 的位置 `flyTo(…, min(目前高度, WEATHER_CLICK_KM))`；hover 提示 `#station-tip`（`.map-tip`，和 `#sat-tip` 共用樣式）由 frame() 每幀的 `updateStationTip()` 更新 |
| `public/taiwan-tiles.js` | 台灣高解析影像 `TaiwanTiles`（ES module）：四分樹圖塊 LOD，每幀 `update()`、`hideAll()`。範圍等設定來自 `/api/config` 的 `twTiles` |
| `public/photo-tiles.js` | 台灣航照 `PhotoTiles`（ES module）：內政部國土測繪中心 WMTS `PHOTO2`（`https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}`，**注意是 y 在 x 前面**，256 px JPEG，CORS `*`，瀏覽器直接抓）。麥卡托 z `MIN_Z` 13–`MAX_Z` 19（0.3 m／像素），每像素 < 25 m 淡入；每個頂點用自己的麥卡托 y 算緯度，貼圖座標才線性；頂點相對圖塊中心（`mesh.position`），拉到幾百公尺高 float32 才不抖；`renderOrder` −13 起（在 TaiwanTiles 之後）；外海共用 TaiwanTiles 的 `seaMask` uniform（NLSC 海上是空白圖）。出處 `PHOTO_CREDIT` 由 app.js 加在 `#credit` 第二行。app.js `CLOSE_MIN_KM` = 0.3（原本 15），`camera.near` 下限 5e-6。My Home 標記：`server.js` 的 `HOME` → `/api/config` 的 `home` → `homeLabel`（`.label.home` 水滴圖標，CSS data URI SVG，尖端對準座標） |
| `public/textures/` | `earth_bluemarble_5400.jpg`（日間地球貼圖）、`taiwan-sea-mask.png`（台灣外海遮罩，由 `tools/make-sea-mask.py` 產生） |
| `public/passes.js` | 過境預報演算法 `SatPasses.compute()`。一般 script（不是 module），掛在全域，**Web Worker 和 `tools/check-passes.js` 共用**，所以不能用 DOM、不能用 import |
| `public/passes-worker.js` | Web Worker：`importScripts` 載入 satellite.js 和 passes.js，算完 postMessage 回主執行緒 |
| `public/index.html` | 頁面骨架；importmap 載入 three@0.170.0，`<script>` 載入 satellite.js@5.0.0 |
| `public/style.css` | 樣式，顏色變數在 `:root` |
| `tools/check-sgp4.js` | 測試：比對 SGP4 和 N2YO 的位置（`npm run check`） |
| `tools/check-passes.js` | 測試：比對過境預報和 N2YO 的 radiopasses / visualpasses（`npm run check:passes`） |
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
- **過境預報**：`npm run check:passes`。次數要和 N2YO 一樣，時間差平常約 10 秒。radiopasses、visualpasses 每小時各只有 100 次，伺服器快取 1 小時，不要反覆清快取重跑。
- **畫面自動測試**：用 headless Edge 截圖或用 DevTools Protocol 操作頁面：
  ```bash
  msedge.exe --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=<scratchpad>/edge-profile --window-size=1600,900 --virtual-time-budget=90000 --screenshot=<scratchpad>/x.png "http://localhost:8000/?tab=passes"
  ```
  過境預報在 Worker 裡算，`--virtual-time-budget` 太短會截到「計算中…」。要點擊、讀狀態時，加 `--remote-debugging-port=9333`，用 Node 內建的 `WebSocket` 送 `Runtime.evaluate`。
  **結束 headless Edge 時，只能依 `--user-data-dir` 的路徑找出自己開的那幾個 process 再關**（`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object CommandLine -like '*edge-profile*'`）。不要用 `taskkill /IM msedge.exe` 這種會關到使用者自己瀏覽器的指令。
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
- **過境預報**：
  - 用真實的模擬時鐘 `clockMs()` 當起點；時鐘跑超過起點 1 天或往回跳，`updatePasses()` 會自動重算。新增／移除衛星、TLE 更新時呼叫 `markPassesDirty()`（有 0.8 秒去抖動，因為啟動時 TLE 會一顆一顆到）。
  - `renderPasses()` 每 250 毫秒被呼叫，但只有內容變了（`passKey`）才重建 DOM，不然滑鼠 hover、點擊會被打斷。面板沒打開時不渲染，切換分頁時要清掉 `passKey`。
  - 演算法：30 秒間隔掃描仰角、二分法找升起和落下（1 秒精度）、三分搜尋找最高點。週期超過 1300 分鐘當成同步衛星，不找過境。
  - 肉眼可見 = 衛星被太陽照到（圓柱形地影模型）＋觀測點太陽仰角低於 −6°＋衛星仰角 ≥ 10°。N2YO 日落後 0–6° 也算可見，這是已知差異，不是 bug。
  - N2YO 的過境時間是 5 秒取樣，接近天頂的過境它的最高仰角會偏低 1–2°，比對時不要以為是我們錯。
- **星鏈**：
  - 資料來源是 CelesTrak `gp.php?GROUP=starlink&FORMAT=tle`（約 1 萬顆、1.8 MB），不是 N2YO。**CelesTrak 2 小時內重複下載會回 HTTP 200 加一段文字說明（不是 TLE）**，所以 `server.js` 用 `looksLikeTle()` 判斷，失敗就保留舊資料、30 分鐘後才再試；資料存在資料資料夾的 `starlink.tle`，重啟也不重抓，2.5 小時後才更新。**開發測試不要反覆打 CelesTrak**，會被擋（也可能被封 IP）。
  - 每次成功下載由 `archiveStarlink()` 另存資料資料夾的 `starlink-history/<UTC 時間>Z.tle.gz`，超過 `STARLINK_KEEP_DAYS`（預設 30）天的刪掉。`starlink.tle` 存在後，伺服器每 10 分鐘呼叫一次 `getStarlink()`，到期就在背景更新，所以網頁沒開也會累積備份。測試備份邏輯時把 `server.js` 複製到 scratchpad、mock `global.fetch`，用 `DATA_DIR` 指到 scratchpad，不要碰使用者的資料資料夾。
  - 要測畫面又不想打 CelesTrak：用 `DATA_DIR` 指到 scratchpad 的測試資料夾，在裡面的 `starlink.tle` 放自己產生的假星座 TLE（例如照 Walker 星座改 RAAN、平近點角），**測完把測試伺服器關掉、資料夾刪掉**。
  - Worker 每次算全部約 1 萬顆要 150–200 毫秒；即時模式每秒算一次，加速模擬每 0.4 秒一次，中間每幀用速度外插（10 秒誤差約 0.4 公里）。跳時間超過 5 分鐘先隱藏，等新結果。
  - 位置用 Bowring 公式轉成大地緯度和高度，和其他衛星的 `geoToVec` 一致（直接用地心座標會差 10–20 公里，從地面看約 2°）。
  - 「在台灣地平線上」用 `p·up > 1` 判斷（地球半徑 = 1）。
  - 開關存在 localStorage `starlink-enabled`，網址 `?starlink=1` 也能開。
- **衛星模型**：
  - 每顆衛星有一個模型（`s.model`）加一個清單顏色的圓圈 sprite（`s.sprite`）。`placeModel()` 每幀設定位置、朝向、大小、明暗，並回傳模型在畫面上的像素大小，圓圈依此調整。
  - 大小：固定約 `MODEL_PX` 像素，但不超過軌道高度的 1.6 倍，避免縮小畫面時低軌衛星模型插進地球。
  - 朝向：用前後兩幀的位置差當前進方向（跳時間時位移太大就忽略）；幾乎不動的同步衛星朝東。
  - 地影：場景沒有投影，`setModelLit()` 依圓柱形地影模型把材質調暗到 30%，所以每個模型要有自己的材質。
  - 光源（`sunLight`、環境光）只影響模型，地球是自己的 shader。
  - 畫面檢查模型外形時，可以暫時在 `public/` 放一個只載入 `models.js` 的測試頁截圖，**用完要刪掉**，不要進 git 和打包。
- **衛星雲圖**：
  - 資料是氣象署 O-B0033-001（向日葵 9 號全盤面 B13 紅外線黑白，5500×5500，無海岸線文字）。opendata API 只是 302 轉到公開 S3（`cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation/O-B0033-001.json` 和 `.jpg`），**不用授權碼**，S3 有 CORS `*`。`server.js` 的 `getClouds()` 每 10 分鐘看一次 json 的 `ObsTime`，換了才下載圖（約 3.4 MB），失敗保留舊圖；`/api/clouds` 回傳圖片，觀測時間放在 `X-Obs-Time` header。
  - 圖是靜止衛星投影（衛星經度 140.7°E），用 CGMS LRIT/HRIT 規範的公式（CFAC = LFAC = 20466275、COFF = LOFF = 2750.5）換算，已用氣象署有畫海岸線的 O-C0042-001 驗證準到 1 像素。shader 裡 `uv = 0.5 + 掃描角(度) × 20466275 / 65536 / 5500`，`flipY = false`（ImageBitmap 不能翻轉）。
  - 前端用 `createImageBitmap` 縮成 2750×2750 再當貼圖（原尺寸 RGBA 要 121 MB GPU 記憶體）。
  - 亮度門檻 `smoothstep(0.38, 0.68)` 是實測調的：晴空海面約 0.24、台灣陸地 0.30、蒙古晴空陸地 0.42、華中雲帶 0.54。
  - 氣象署其他雲圖：O-B0032-001～004 東亞 1200 px（**投影不是經緯度方格，不能直接貼**）、O-B0033-003 東亞 KMZ（經緯度瓦片 102–152°E、0–50°N，可貼但要解壓縮拼接）、O-C0042-001～008 全球／台灣 1200／800 px（有黃色海岸線和文字）。
  - 雲球只畫正面，所以在台灣仰望視角（相機在球裡面）看不到，不會擋住衛星。
  - 雲圖只有即時觀測：`renderCloudInfo()`（tickSlow 每 250 毫秒）比較 `clockMs()` 和 `clouds.obsTime`，差超過 `CLOUDS_STALE_MS`（1 小時）就把 `uniforms.opacity` 設 0.3、資訊改成黃字註明。
  - 開關存在 localStorage `clouds-enabled`，網址 `?clouds=1` 也能開。
  - **短時外推**（`clouds-flow-worker.js`）：新的最新雲圖載入後 `updateFlow()` 自己抓 `/api/history`，找 40–90 分鐘前（最接近 60 分鐘）的一張，Worker 縮到 640 px 做區塊比對（17 px 區塊、搜尋 ±10 px、拋物線次像素、離群值剔除、高斯平滑、往無雲處外填），回傳 80×80 的位移（uv／小時，列 0 = 圖的最上面），存成 RG HalfFloat `flowMap`。shader 用 `fcHours` 沿移動場往回追 `FLOW_STEPS` 段（semi-Lagrangian）。`setForecast(ms, Boolean(sim))` 在 `frame()` 每幀呼叫：只有模擬中、畫面是最新一張、時鐘在觀測之後 `FORECAST_MAX_HOURS`（3）小時內才外推；即時模式不外推。`renderCloudInfo()` 依 `clouds.forecastHours` 顯示藍字並調淡。驗證方式：三張相隔 1 小時的真實雲圖，A→B 算移動場、B 外推 1 小時和 C 比，東亞有雲處平均誤差 12.1 對「不動」17.2。
- **資料資料夾**（1.5.0 起）：`CACHE_DIR` = `.env` 的 `DATA_DIR`，預設 `%LOCALAPPDATA%\SatelliteTracker`。打包版每版是不同資料夾，放程式旁邊的話換版就丟歷史。啟動時 `migrateOldCache()` 把程式資料夾的舊 `.cache/` 複製過去（不覆蓋）。開發伺服器和打包版共用同一個資料夾。**測試一律設 `DATA_DIR` 到 scratchpad**，不要動使用者的資料。
- **回放**：
  - 伺服器：每張新雲圖由 `archiveClouds()` 存成 `clouds-history/<觀測時間 UTC>Z.jpg`，保留 `CLOUDS_KEEP_HOURS`（24）小時，依檔名時間刪。`clouds-history` 存在就每 5 分鐘在背景 `getClouds()`（新圖每 10 分鐘一張，5 分鐘才不會漏）。`/api/history` 回傳 `{ starlink: [{t, file}], clouds: [...] }`；歷史檔用 `/api/starlink/history/<檔名>`（gzip 原檔加 `Content-Encoding: gzip`）、`/api/clouds/history/<檔名>`，檔名一律用 `HISTORY_NAME` 檢查。
  - 前端：`startReplay()` 從有開的圖層最早的歷史時間開始 `setSim(speed, start)`；暫停 = `setSim(0)`；`updateReplay()`（tickSlow）播到現在就 `exitReplay()`。回放中 `body.replaying` 會藏起加速模擬控制和提示。`simulatePass()` 會離開回放。
  - `applyHistory()`（tickSlow）：`clouds.showAt(ms, archive.clouds, Boolean(sim))` 選 t ≤ ms 的最後一張（`CloudLayer` 最多快取 `MAX_CACHED` 張 2048 px，預先載入下一張）；星鏈選 t ≤ ms 的最後一份 TLE，比最新備份還晚就用最新資料，`StarlinkLayer.useDataset(file)` 換資料（Worker 重新 load，顆數不同會重建 Points）。
  - 星鏈 `update(ms, up, speed)`：外插最多 ±90 秒；Worker 結果的時間差超過 `max(5 分鐘, speed × 1.5 秒)` 才隱藏，不然高倍速回放時光點一直消失。
  - 測試回放：用 `DATA_DIR` 放幾張真的雲圖（檔名改成想要的時間）和星鏈備份，另開 port；用 DevTools Protocol 按 `#replay-toggle`、改 `#replay-pos` 的值並觸發 `input`，用 `performance.getEntriesByType('resource')` 看抓了哪些歷史檔。
- **長期資料收集**（1.7.0，`collector.js`）：
  - `server.listen` 成功後才 `startCollector(CACHE_DIR)`（重複啟動時第二個會 EADDRINUSE 結束，不會兩個一起寫檔）。每 5 分鐘一次，不管網頁有沒有開。
  - 測站：氣象署 S3 `O-A0003-001.json`（約 360 站、每 10 分鐘，**不用授權碼**；O-A0001-001 自動站 876 站也在 S3）。寫 `weather-history/<台灣日期>.csv`（UTF-8 BOM），用 `站號|觀測時間` 去重（啟動時讀當天檔），過午夜 1 小時後把前一天壓成 `.csv.gz`。缺測值 -99 寫成空白。
  - 東亞雲圖：`O-B0032-003`（1200 px 紅外線黑白，約 380 KB），觀測時間是 `CLOUDS_ARCHIVE_EVERY_MIN`（預設 60）的倍數才存，`clouds-eastasia/<UTC 年-月>/<stamp>Z.jpg`。Node 沒有 JPEG 解碼器，所以存原檔、不在伺服器上算雲量。
  - 東亞雲圖氣象署延遲 15–25 分鐘、偶爾跳過整點，所以每個間隔存「前半段裡最早拿到的一張」（`cloudSlotSaved()` 掃目錄判斷），檔名是真正的觀測時間，不一定是整點。
  - 預設永久保留；`WEATHER_KEEP_DAYS`、`CLOUDS_ARCHIVE_KEEP_DAYS`、`COLLECT=0`。
  - 測試：`DATA_DIR` 指到 scratchpad、另開 `PORT`，啟動兩次確認不會重複寫；注意 `migrateOldCache()` 會把專案的 `.cache/` 複製進測試資料夾，測完整個刪掉。
  - 開機自動啟動：`autostart.cmd on|off`（在 Startup 資料夾建 `SatelliteTracker.lnk` → `wscript start.vbs /background`）。**Claude 不能自己執行 `on`**（會被權限擋，屬於常駐），要請使用者自己跑；測試時把腳本複製到 scratchpad、把 LNK 改成 scratchpad 路徑。
- **台灣高解析影像**（`taiwan-tiles.js`、`server.js` 的 `TW_TILES`）：
  - 資料是 EOX WMS：白天 `s2cloudless-2025`（**CC BY-NC-SA 4.0，一定要顯示出處**）、夜晚 `blackmarble`（NASA，標示出處），EPSG:4326、JPEG。`#credit` 在有圖塊顯示時出現。`/api/twtile/<day|night>/<z>/<x>/<y>.jpg`：範圍 5° 見方的四分樹，`y` 從南邊數，白天 z 0–6、夜晚 z 0–2（`nightMaxZ`，原始約 500 m），每塊 512²；第一次由伺服器下載（同時最多 4 個，in-flight 去重），存 `DATA_DIR/tw-tiles/<layer>/<z>/<x>_<y>.jpg`。**圖塊不進 git、不進打包**。
  - 每塊是自己的球面網格（16×16），`depthWrite: false`、`renderOrder = -20 + z`：比雲圖、大氣早畫，細的蓋粗的。子圖塊沒到之前看得到父圖塊；選圖塊條件是「圖塊每像素 > 螢幕每像素」就往下一層。
  - shader 和地球共用 `EARTH_SHADE`（日夜光影）。白天顏色在 shader 裡合成：外海遮罩（白 = 外海，`RedFormat`，載入前不顯示圖塊）的地方取地球的 Blue Marble（`dayMap`），其他取 Sentinel-2；**不要改回讓外海透明**，不然晚上底圖的低解析燈光會在海岸外留方塊光暈。圖塊只有範圍邊緣 0.3° 淡出。
  - 夜晚燈光：`applyNight()` 每幀找自己或第 `nightMaxZ` 層祖先的 Black Marble，用 `nightRect` 取其中一小塊。Black Marble 底色 (0, 1, 29) 要扣掉、再補上底圖燈光圖的底色 (8, 8, 16)，範圍邊緣才不會出現藍色或黑色方框。夜間圖塊先於白天圖塊下載，`dark()`（太陽照得到的）不下載。還沒載入時用地球的燈光圖，拉近時用 `nightGain` 調暗。
  - 整體依「範圍中心附近每螢幕像素幾公里」淡入（8 km → 3 km），太遠時不顯示也不下載。
  - 拉近：`adjustSpaceCamera()` 每幀依相機離台灣幾度設定 `controls.minDistance`（4° 內 15 km，12° 外 1274 km，中間漸變），`zoomSpeed`、`rotateSpeed` 依高度變慢，`camera.near` 跟著高度（不然低空會切到地面）。離地 400 km 以內隱藏 `taiwanGroup`（海岸線，Natural Earth 1:10m，`public/taiwan-coast.json`，`tools/make-coastline.py` 產生；用 Line2 + `LineMaterial` 才能畫 2 像素寬，`resize()` 要更新 `coastMaterial.resolution`）。
  - 改範圍：`server.js` 的 `TW_TILES` 和 `tools/make-sea-mask.py` 的 `WEST/SOUTH/SIZE` 要一致，重新產生遮罩，刪掉 `tw-tiles/`。
  - 測試：`DATA_DIR` 指到 scratchpad、另開 `PORT`；用 DevTools Protocol 送 `Input.dispatchMouseEvent` 的 `mouseWheel`（約 35 格到最低）拉近再截圖。台灣是晚上時畫面很暗，可以用 `Page.addScriptToEvaluateOnNewDocument` 把 `Date.now` 往後調幾小時再測。
- **瀏覽器記住的清單**（localStorage `tracked-satellites`）會蓋過 `DEFAULT_IDS`。
- 這台電腦是 Windows，git 會出現 LF → CRLF 的警告，不影響。

## 功能清單（改之前先看有沒有現成的函式可以用）

- **衛星生命週期**：`createSat(id)`、`removeSat(s)`、`saveIds()`、`loadIds()`。
- **資料抓取**：`api(path)`、`loadPositions(s, now)`、`loadTle(s, now)`、`poll()`（每 250 毫秒由 `tickSlow()` 呼叫）。
- **位置**：`sampleAt()`、`stateFromSamples(s, sec)`（即時）、`stateFromTle(s, ms)`（模擬）、`updateSat(s, ms)`（每幀）。`s.state = { alt, lat, lng, az, el }`，`s.pos` 是場景座標。
- **軌道線**：`updatePath(s, ms)`。
- **清單**：`makeRow(s)`、`refreshList()`（依仰角排序）、`select(id)`、`renderCount()`。
- **地球自轉**（`spin`、`setSpin(on)`、`applySpin(ms)`，localStorage `spin-enabled`、`?spin=1`）：場景仍然是地球固定座標，只是 frame() 每幀依 GMST 的變化 d，把太空俯瞰的鏡頭和 `stars` 繞 +Y 轉 −d（不是轉地球，所以台灣、圖塊、雲、測站等全部不用改）。一幀時間跳超過 `SPIN_JUMP_MS`（10 分鐘）就不轉鏡頭。開自轉時若 `!sim && !replay` 就自動 `setSim(SPIN_SIM_SPEED)`（200），記 `spinStartedSim`、`spinPrevSpeed`；關自轉時若還是那個倍速就 `setSim(null)` 並還原滑桿。加速模擬滑桿是**對數刻度**：`#sim-speed` 是位置 0–1000，倍速用 `speedFromSlider()`（1–`SIM_MAX_SPEED` 10000，取 2 位有效數字），反過來用 `sliderFor(speed)`；不要再用 `Number(simSpeed.value)` 當倍速。地球自轉的 `spinJumpMs()` 門檻跟著倍速放大。軌道線重算間隔 `pathEvery = max(30 秒, speed × 150 ms)`（tickSlow）。軌道線在 spin 時全部點用 `gmstNow` 換算（閉合橢圓），記在 `s.pathGmst`，之後每幀 `s.path.rotation.y = −(gmst − pathGmst)`；尾巴的 `sgp4Point(…, gmst)` 也用現在的 GMST。`let spin` 宣告在檔案前面（`let view` 旁邊），因為 updatePath／updateTail 比 setSpin 早定義。
- **鏡頭飛行**：`flyTo(dir, altKm)`（太空俯瞰，方向 slerp、高度取對數內插，1.2 秒；會關太陽系、切回太空俯瞰、把 tilt/heading 歸零；飛行中關掉 `controls.enableDamping` 清掉慣性）、`applyFly()`（frame() 在 `adjustSpaceCamera()` 前呼叫）、`endFly()`（canvas pointerdown／wheel、`homeSpace()` 會中斷）。距離台灣超過 12° 的地方 `minDistance` 是 1274 km，飛不到更低。
- **視角**：`setView('space' | 'sky')`、`homeSpace()`、`aimSky()`、`skyDirection(az, el)`、`updateHint()`。
- **中鍵平移（太空俯瞰）**：`controls.mouseButtons.MIDDLE = null`（OrbitControls 不處理中鍵；以前是 ROTATE，使用者覺得拉遠時沒有「移動」效果），自己處理中鍵拖曳改 `panX`／`panY`（像素，限制在畫面 ±45%），`applyPan()` 用 `camera.setViewOffset` 平移投影——鏡頭仍然對著地心，其他依 target = 原點的邏輯都不受影響。`let panX` 宣告在檔案前面（`resize()` 啟動時就會呼叫 `applyPan()`）。`homeSpace()`、切到台灣仰望時歸零。月球、太陽系視角的 OrbitControls 設 `MIDDLE = PAN`（和右鍵一樣）。
- **斜看（太空俯瞰）**：`tilt`、`heading`（弧度），右鍵或 Shift＋左鍵拖曳時改（拖曳中 `controls.enabled = false`）。`frame()` 在 `controls.update()` 之後呼叫 `applyTilt()`（OrbitControls 每次 update 都會 lookAt 地心，所以每幀重轉；`rotateZ(heading)` 再 `rotateX(tilt)`），`maxTilt(altKm)` 在 3000–8000 km 漸漸變 0。左下角 `#altitude` 由 `renderAltitude()` 每幀更新。
- **模型**：`placeModel(s, selected)`、`modelKind()`、`makeSatModel()`；TLE 載入後若判斷出的種類不同（例如新加的是同步衛星）會換模型。
- **標籤**：`makeLabel()`、`placeLabel()`、`hiddenByEarth()`、`updateLabels()`。
- **模擬**：`sim`（`null` 或 `{ fromSim, fromReal, speed }`）、`clockMs()`、`setSim(speed | null, atMs?)`（`atMs` 指定從哪個時刻開始）。
- **過境預報**：`markPassesDirty()`、`updatePasses()`（排程計算）、`renderPasses()`、`passRow()`、`dayHeading()`、`simulatePass(id, startMs)`、`setTab('list' | 'passes')`。結果在 `passResults`（`[{ id, geo, el, az, passes: [{ start, end, maxTime, maxEl, startAz, maxAz, endAz, visible, visStart, visEnd, visMaxEl }] }]`，時間都是毫秒）。
- **星鏈**：`starlink`（`StarlinkLayer`）、`setStarlink(on)`、`renderStarlinkInfo()`。
- **拉遠**：`controls.maxDistance = 170`（約 108 萬公里，看整個月球軌道）。`adjustSpaceCamera()` 的 `camera.far = max(400, dist × 2.5 + 100)`；`stars` 每幀跟著鏡頭、縮放到 far × 0.8（只是裝飾）。`farView()`（鏡頭離地心 > `FAR_VIEW_DIST` 40）時隱藏衛星圓圈 sprite 和名稱。
- **主迴圈**：`frame()`（requestAnimationFrame）、`tickSlow()`（每 250 毫秒：時鐘、軌道線、清單、poll）。太陽方向 `updateSun(ms)` 在 frame() 開頭**每幀**呼叫（tickSlow 也呼叫一次）；只在 tickSlow 更新的話，高倍速和地球自轉時太陽會抖。和畫面位置有關的東西都要每幀更新。
