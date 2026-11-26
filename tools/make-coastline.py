# 產生 public/taiwan-coast.json：台灣（含澎湖、金門、馬祖、綠島、蘭嶼）的海岸線。
# 資料：Natural Earth 1:10m Admin 0 Countries（公有領域），https://www.naturalearthdata.com/
# 用法：python tools/make-coastline.py [已下載的 ne_10m_admin_0_countries.geojson]
# 輸出：[[[lat, lng], ...], ...]，每個多邊形一條封閉的線，座標取到小數 4 位（約 10 m）。
import json
import os
import sys
import urllib.request

URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'taiwan-coast.json')

if len(sys.argv) > 1:
    with open(sys.argv[1], encoding='utf-8') as f:
        data = json.load(f)
else:
    with urllib.request.urlopen(URL) as r:
        data = json.load(r)

feature = next(f for f in data['features'] if f['properties'].get('ADM0_A3') == 'TWN')
geom = feature['geometry']
polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]

rings = []
for poly in polys:
    ring = poly[0]  # 外圈
    rings.append([[round(lat, 4), round(lng, 4)] for lng, lat in ring])
rings.sort(key=len, reverse=True)

with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(rings, f, separators=(',', ':'))
print(len(rings), 'rings,', sum(len(r) for r in rings), 'points ->', os.path.normpath(OUT))
