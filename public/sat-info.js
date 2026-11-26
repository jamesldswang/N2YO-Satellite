// 追蹤清單 hover 時顯示的衛星簡介。
// 1. 常見衛星依 NORAD 編號寫好介紹；2. 沒有的依名稱判斷是哪一類（星鏈、GPS…）；
// 3. 都不符合就只依軌道高度說明是哪種軌道。

// { kind: 類別, text: 介紹, facts: [短資訊] }
const BY_ID = {
  25544: {
    en: 'ISS (Space Station)',
    name: 'ISS 國際太空站',
    kind: '太空站',
    text: '國際太空站（ISS），由美國、俄羅斯、歐洲、日本、加拿大合作建造，2000 年起一直有太空人常駐。在微重力環境下做生物、材料、醫學等實驗，也是長期太空生活的試驗場。很亮，日落後或日出前常常肉眼就看得到。',
    facts: ['1998 年開始組裝', '約 400–420 km', '約 92 分鐘繞地球一圈'],
  },
  48274: {
    en: 'CSS Tianhe',
    name: '天和核心艙（天宮）',
    kind: '太空站',
    text: '中國天宮太空站的天和核心艙，是太空站的控制中心和太空人主要的生活空間。2022 年問天、夢天兩個實驗艙接上後完成 T 字形組裝，平常有 3 名太空人輪流駐留。',
    facts: ['2021 年發射', '約 380–400 km', '中國載人航天'],
  },
  20580: {
    en: 'Hubble Space Telescope',
    name: '哈伯太空望遠鏡',
    kind: '太空望遠鏡',
    text: '哈伯太空望遠鏡（HST），NASA 和歐洲太空總署合作。主鏡 2.4 公尺，在大氣層外觀測可見光、紫外線和近紅外線，拍下深空影像、幫忙量出宇宙膨脹速率，是史上最有名的科學儀器之一。',
    facts: ['1990 年發射', '約 500 km（慢慢下降中）', '太空人曾 5 次上去維修'],
  },
  42920: {
    en: 'FORMOSAT-5',
    name: '福衛五號',
    kind: '地球觀測',
    text: '福爾摩沙衛星五號（福衛五號），台灣國家太空中心第一顆自主研製的光學遙測衛星。在太陽同步軌道上每天固定時間經過台灣，拍攝國土、災害、農業和環境變化的影像。',
    facts: ['2017 年發射', '約 720 km 太陽同步軌道', '黑白 2 m、彩色 4 m 解析度'],
  },
  43013: {
    en: 'NOAA-20 (JPSS-1)',
    name: 'NOAA-20',
    kind: '氣象',
    text: 'NOAA-20（JPSS-1），美國海洋暨大氣總署的繞極氣象衛星。一天繞地球約 14 圈，每天兩次掃過全球，量測溫度、濕度、雲、海冰、火災等，是全球數值天氣預報的重要資料來源。',
    facts: ['2017 年發射', '約 825 km 太陽同步軌道', '主要儀器 VIIRS、ATMS'],
  },
  54234: {
    en: 'NOAA-21 (JPSS-2)',
    name: 'NOAA-21',
    kind: '氣象',
    text: 'NOAA-21（JPSS-2），NOAA-20 的後繼機，同樣是繞極氣象衛星，和 NOAA-20 在同一軌道上相隔半圈，讓全球觀測更密集。',
    facts: ['2022 年發射', '約 825 km 太陽同步軌道'],
  },
  41836: {
    en: 'Himawari-9',
    name: '向日葵 9 號',
    kind: '氣象（同步）',
    text: '向日葵 9 號（Himawari-9），日本氣象廳的靜止氣象衛星，固定在東經 140.7° 赤道上空，每 10 分鐘拍一次整個東亞到澳洲的半個地球。這個網頁的「衛星雲圖」就是它拍的紅外線影像。',
    facts: ['2016 年發射，2022 年起接替 8 號', '約 35,786 km 地球同步軌道'],
  },
  40267: {
    en: 'Himawari-8',
    name: '向日葵 8 號',
    kind: '氣象（同步）',
    text: '向日葵 8 號（Himawari-8），日本氣象廳的靜止氣象衛星，2015–2022 年負責東亞的雲圖觀測，現在是 9 號的備援。',
    facts: ['2014 年發射', '東經 140.7° 附近'],
  },
  25994: {
    en: 'Terra',
    name: 'Terra',
    kind: '地球觀測',
    text: 'Terra，NASA 地球觀測系統的旗艦衛星，上午經過赤道。MODIS 等儀器長期記錄地表、雲、氣膠、植被和火災，資料從 2000 年累積至今。',
    facts: ['1999 年發射', '約 700 km 太陽同步軌道'],
  },
  27424: {
    en: 'Aqua',
    name: 'Aqua',
    kind: '地球觀測',
    text: 'Aqua，NASA 地球觀測衛星，和 Terra 搭配在下午經過赤道，專門研究地球的水循環：海溫、水氣、雲、降雨和冰雪。',
    facts: ['2002 年發射', '約 700 km 太陽同步軌道'],
  },
  39084: {
    en: 'Landsat 8',
    name: 'Landsat 8',
    kind: '地球觀測',
    text: 'Landsat 8，美國地質調查所和 NASA 的陸地衛星，延續 1972 年開始的 Landsat 系列，記錄土地利用、森林、農業和城市的長期變化。',
    facts: ['2013 年發射', '約 705 km 太陽同步軌道', '30 m 解析度'],
  },
  49260: {
    en: 'Landsat 9',
    name: 'Landsat 9',
    kind: '地球觀測',
    text: 'Landsat 9，和 Landsat 8 搭配，兩顆一起每 8 天就能拍遍全球陸地。',
    facts: ['2021 年發射', '約 705 km 太陽同步軌道'],
  },
  40697: {
    en: 'Sentinel-2A',
    name: '哨兵 2A 號',
    kind: '地球觀測',
    text: '哨兵 2A 號（Sentinel-2A），歐盟哥白尼計畫的多光譜光學衛星，拍攝陸地和沿海，監測植被、農作物和災害。這個網頁拉近台灣時的高解析影像就是用哨兵 2 號的資料拼成的。',
    facts: ['2015 年發射', '約 786 km 太陽同步軌道', '10 m 解析度'],
  },
  42063: {
    en: 'Sentinel-2B',
    name: '哨兵 2B 號',
    kind: '地球觀測',
    text: '哨兵 2B 號（Sentinel-2B），和 2A 號在同一軌道相隔半圈，兩顆一起每 5 天拍遍全球陸地。這個網頁拉近台灣時的高解析影像就是用哨兵 2 號的資料拼成的。',
    facts: ['2017 年發射', '約 786 km 太陽同步軌道', '10 m 解析度'],
  },
  33591: {
    en: 'NOAA-19',
    name: 'NOAA-19',
    kind: '氣象',
    text: 'NOAA-19，美國最後一顆 POES 系列的繞極氣象衛星，已經超過設計壽命很多年，現在由 JPSS 系列（NOAA-20、21）接手。',
    facts: ['2009 年發射', '約 850 km 太陽同步軌道'],
  },
  40069: {
    en: 'Meteor-M 2',
    name: '流星 M2',
    kind: '氣象',
    text: '流星 M2（Meteor-M 2），俄羅斯的繞極氣象衛星，觀測雲、海面溫度和冰雪。',
    facts: ['2014 年發射', '約 830 km 太陽同步軌道'],
  },
  37849: {
    en: 'Suomi NPP',
    name: 'Suomi NPP',
    kind: '氣象',
    text: 'Suomi NPP，NASA 和 NOAA 的繞極衛星，原本是 JPSS 系列的先導機，現在和 NOAA-20、21 一起提供全球天氣和氣候觀測，夜間燈光影像也常用它的 VIIRS。',
    facts: ['2011 年發射', '約 830 km 太陽同步軌道'],
  },
  38771: {
    en: 'MetOp-B',
    name: 'MetOp-B',
    kind: '氣象',
    text: 'MetOp-B，歐洲氣象衛星組織（EUMETSAT）的繞極氣象衛星，上午經過赤道，和美國的下午星互補，量測大氣溫度、濕度和海面風。',
    facts: ['2012 年發射', '約 820 km 太陽同步軌道'],
  },
  43689: {
    en: 'MetOp-C',
    name: 'MetOp-C',
    kind: '氣象',
    text: 'MetOp-C，MetOp 系列第三顆，和 MetOp-B 在同一軌道上，讓歐洲的繞極觀測更密集。',
    facts: ['2018 年發射', '約 820 km 太陽同步軌道'],
  },
  39634: {
    en: 'Sentinel-1A',
    name: '哨兵 1A 號',
    kind: '地球觀測',
    text: '哨兵 1A 號（Sentinel-1A），歐盟哥白尼計畫的合成孔徑雷達衛星。雷達不怕雲和黑夜，用來監測地層下陷、地震變形、洪水、海冰和船隻。',
    facts: ['2014 年發射', '約 693 km 太陽同步軌道', 'C 波段雷達'],
  },
  41240: {
    en: 'Jason-3',
    name: 'Jason-3',
    kind: '海洋觀測',
    text: 'Jason-3，美歐合作的海洋測高衛星，用雷達量海面高度到公分等級，追蹤海平面上升、聖嬰現象和洋流。',
    facts: ['2016 年發射', '約 1,336 km 高'],
  },
  36508: {
    en: 'CryoSat-2',
    name: 'CryoSat-2',
    kind: '地球觀測',
    text: 'CryoSat-2，歐洲太空總署的冰層觀測衛星，用雷達量測極地冰帽和海冰的厚度變化。',
    facts: ['2010 年發射', '約 720 km，接近兩極的軌道'],
  },
  39766: {
    en: 'ALOS-2',
    name: 'ALOS-2（大地 2 號）',
    kind: '地球觀測',
    text: '大地 2 號（ALOS-2），日本 JAXA 的 L 波段雷達衛星，能穿透雲層和植被，用於災害監測、地殼變形和森林調查。',
    facts: ['2014 年發射', '約 628 km 太陽同步軌道'],
  },
  28376: {
    en: 'Aura',
    name: 'Aura',
    kind: '地球觀測',
    text: 'Aura，NASA 地球觀測系統的大氣化學衛星，量測臭氧層、空氣污染和溫室氣體。',
    facts: ['2004 年發射', '約 705 km 太陽同步軌道'],
  },
  38337: {
    en: 'GCOM-W1 (Shizuku)',
    name: 'GCOM-W（雫）',
    kind: '地球觀測',
    text: 'GCOM-W「雫（しずく）」，日本 JAXA 的微波觀測衛星，量測降雨、水氣、海面溫度和海冰，資料也用在颱風分析。',
    facts: ['2012 年發射', '約 700 km 太陽同步軌道'],
  },
};

// 「加入」下拉選單用：有寫好介紹的衛星，依類別、名稱排序
// en：英文名稱（選單和剛加入、還沒拿到 N2YO 名稱時顯示）；name：中文名稱（只用來搜尋）
export const CATALOG = Object.entries(BY_ID)
  .map(([id, v]) => ({ id: Number(id), en: v.en, name: v.name, kind: v.kind }))
  .sort((a, b) => a.kind.localeCompare(b.kind, 'zh-TW') || a.en.localeCompare(b.en, 'en'));

// 剛加入、N2YO 名稱還沒回來時用的名稱：有寫好的用英文名稱，沒有的才用編號
export const initialName = (id) => BY_ID[id]?.en || `#${id}`;

// 依名稱判斷（名稱來自 N2YO，大寫英文）
const BY_NAME = [
  [/STARLINK/, '通訊', 'SpaceX 的星鏈（Starlink）衛星，上萬顆低軌衛星組成的網路，提供全球衛星上網。剛發射時常排成一串「衛星列車」。'],
  [/ONEWEB/, '通訊', 'OneWeb（Eutelsat）的低軌通訊衛星，約 1,200 km 高，提供衛星網路服務。'],
  [/IRIDIUM/, '通訊', '銥（Iridium）衛星，66 顆低軌衛星組成的全球衛星電話和數據網路，兩極也收得到訊號。'],
  [/NAVSTAR|GPS/, '導航', '美國 GPS 全球定位系統的衛星，約 20,200 km 高的中地球軌道，手機、車用導航都靠它們定位。'],
  [/GLONASS/, '導航', '俄羅斯 GLONASS 全球導航衛星系統的衛星，約 19,100 km 高。'],
  [/GALILEO|GSAT0/, '導航', '歐盟伽利略（Galileo）全球導航衛星系統的衛星，約 23,200 km 高。'],
  [/BEIDOU/, '導航', '中國北斗全球導航衛星系統的衛星，有中地球軌道和地球同步軌道兩種。'],
  [/QZS|MICHIBIKI/, '導航', '日本準天頂衛星系統（引路號），補強 GPS 在東亞、大洋洲的定位精度，台灣也收得到。'],
  [/HIMAWARI/, '氣象（同步）', '日本向日葵靜止氣象衛星，固定在赤道上空拍攝東亞到澳洲的雲圖。'],
  [/FENGYUN|^FY-/, '氣象', '中國風雲系列氣象衛星，有繞極和靜止兩種。'],
  [/GOES/, '氣象（同步）', '美國 GOES 靜止氣象衛星，負責美洲的雲圖和颱風（颶風）監測，台灣看不到。'],
  [/NOAA/, '氣象', '美國海洋暨大氣總署（NOAA）的繞極氣象衛星，提供全球雲、溫度、濕度觀測。'],
  [/METEOR/, '氣象', '俄羅斯流星系列繞極氣象衛星。'],
  [/METOP/, '氣象', '歐洲氣象衛星組織（EUMETSAT）的 MetOp 繞極氣象衛星，上午經過赤道，和美國的下午星互補。'],
  [/SENTINEL/, '地球觀測', '歐盟哥白尼計畫的哨兵（Sentinel）衛星，監測陸地、海洋、大氣等環境變化，資料免費公開。'],
  [/LANDSAT/, '地球觀測', '美國 Landsat 陸地衛星系列，從 1972 年開始記錄地球陸地的變化。'],
  [/FORMOSAT[- ]?7|COSMIC[- ]?2/, '氣象', '福衛七號（FORMOSAT-7 / COSMIC-2），台美合作的 6 顆衛星，接收穿過大氣層的 GPS 訊號，推算大氣溫度、濕度，改善颱風和天氣預報。'],
  [/FORMOSAT/, '地球觀測', '台灣國家太空中心的福爾摩沙衛星系列。'],
  [/TIANZHOU/, '貨運飛船', '中國天舟貨運飛船，替天宮太空站運送補給、燃料和實驗器材。'],
  [/SHENZHOU/, '載人飛船', '中國神舟載人飛船，載運太空人往返天宮太空站。'],
  [/DRAGON/, '飛船', 'SpaceX 龍飛船（Dragon），載運太空人或貨物往返國際太空站。'],
  [/PROGRESS/, '貨運飛船', '俄羅斯進步號貨運飛船，替國際太空站運送補給和燃料，也幫太空站抬升軌道。'],
  [/SOYUZ/, '載人飛船', '俄羅斯聯盟號載人飛船，載運太空人往返國際太空站。'],
  [/CYGNUS/, '貨運飛船', '美國天鵝座（Cygnus）貨運飛船，替國際太空站運送補給。'],
  [/\bR\/B\b|ROCKET BODY/, '火箭殘骸', '火箭上面級的殘骸，把衛星送上軌道後留在太空，慢慢因大氣阻力下降、最後重返大氣層燒毀。'],
  [/\bDEB\b|DEBRIS/, '太空碎片', '太空碎片：衛星或火箭解體、碰撞留下的碎片。'],
];

// 依軌道判斷（沒有其他資料時）
function orbitText(s) {
  const alt = s.state?.alt;
  const periodMin = s.satrec?.no ? (2 * Math.PI) / s.satrec.no : null;
  if (periodMin && periodMin > 1300 && periodMin < 1580) {
    return '在地球同步軌道（約 35,786 km），繞一圈剛好一天，從地面看幾乎停在天上不動，通常是通訊、氣象或導航衛星。';
  }
  if (alt === undefined) return '';
  if (alt < 2000) return `在低地球軌道（約 ${Math.round(alt).toLocaleString()} km），繞地球一圈約 1.5–2 小時，常見的是地球觀測、通訊和科學衛星。`;
  if (alt < 30000) return `在中地球軌道（約 ${Math.round(alt).toLocaleString()} km），常見的是 GPS 這類導航衛星。`;
  return `在高軌道（約 ${Math.round(alt).toLocaleString()} km）。`;
}

// s：app.js 的衛星物件（id、name、state、satrec）；下拉選單只給 { id }
export function satInfo(s) {
  const known = BY_ID[s.id];
  if (known) return { ...known, title: s.name || known.en };
  const name = String(s.name || '').toUpperCase();
  for (const [re, kind, text] of BY_NAME) {
    if (re.test(name)) return { kind, text, facts: [], title: s.name };
  }
  const text = orbitText(s);
  return { kind: '', text: `目前沒有這顆衛星的介紹。${text}`, facts: [], title: s.name };
}
