# 台灣上空衛星

以 Three.js 顯示地球與衛星的即時位置，地球固定、視角以台灣為中心。資料來自 [N2YO REST API](https://www.n2yo.com/api/)。

## 執行

需要 Node.js 20.12 以上，沒有其他套件要安裝。

1. 到 n2yo.com 註冊，在個人資料頁產生 API Key。
2. 把 `.env.example` 複製成 `.env`，填入金鑰：

   ```
   N2YO_API_KEY=你的金鑰
   ```

   `.env` 已列在 `.gitignore`，不會被 commit。

3. 執行 `node server.js`，開啟 <http://localhost:8000>。

頁面的 Three.js、satellite.js 和地球貼圖由 CDN 載入，需要網路連線。

## 預設衛星

| NORAD ID | 衛星 |
| --- | --- |
| 25544 | 國際太空站（ISS） |
| 48274 | 中國太空站（天和號） |
| 20580 | 哈伯太空望遠鏡 |
| 42920 | 福衛五號 |
| 43013 | NOAA 20 |
| 41836 | 向日葵 9 號 |

可以在頁面上以 NORAD ID 增減衛星，清單會存在瀏覽器裡。

## 檔案結構

| 檔案 | 說明 |
| --- | --- |
| `server.js` | 靜態檔案伺服器，並代理 N2YO API（N2YO 不支援 CORS，也讓金鑰不出現在前端） |
| `public/index.html` | 頁面 |
| `public/app.js` | Three.js 場景、衛星位置內插、SGP4 軌道線 |
| `public/style.css` | 樣式 |
| `.env.example` | 環境變數範本 |

## 資料來源與額度

| 用途 | N2YO 端點 | 更新頻率 | 每小時上限 |
| --- | --- | --- | --- |
| 衛星即時位置、對台灣的方位角與仰角 | `positions`（一次取 300 秒） | 每顆約每 3.5 分鐘 | 1000 |
| 軌道線（由 satellite.js 以 SGP4 推算） | `tle` | 每顆每 6 小時 | 1000 |

清單上限 20 顆，全開時約使用每小時 340 次 `positions`。

觀測點定義在 `server.js` 的 `OBSERVER`（預設為台灣地理中心），改成你的所在位置後，方位角與仰角就會以該點計算。
