"""產生台灣高解析圖塊用的外海遮罩 public/textures/taiwan-sea-mask.png。

圖塊範圍（117.75–122.75°E、21.5–26.5°N）內，外海用 Blue Marble、陸地和沿岸用 Sentinel-2，
這樣海上看不到 Sentinel-2 拍攝條帶的接縫。只需要在範圍改變時重新產生一次。

做法：向 EOX WMS 下載 terrain-light（OpenStreetMap 資料，海是單一顏色）拼成 4096×4096，
找出水的像素 → 先去掉細河道 → 從邊緣填滿相連的水域（湖泊、水庫不算外海）→ 往外海縮約 1 km
留給 Sentinel-2 的沿岸 → 模糊邊緣。白 = 外海（用 Blue Marble），黑 = 用 Sentinel-2。

需要 Python 3、numpy、Pillow：python tools/make-sea-mask.py
"""
import io
import os
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

WEST, SOUTH, SIZE = 117.75, 21.5, 5.0  # 要和 server.js 的 TW_TILES 一樣
N = 4096
PARTS = 4
WATER = np.array([148, 166, 180], dtype=np.float32)  # terrain-light 的水色
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'textures', 'taiwan-sea-mask.png')


def fetch(w, s, d, px):
    url = ('https://tiles.maps.eox.at/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&STYLES=&SRS=EPSG:4326'
           f'&FORMAT=image/png&LAYERS=terrain-light&BBOX={w},{s},{w + d},{s + d}&WIDTH={px}&HEIGHT={px}')
    with urllib.request.urlopen(url, timeout=60) as r:
        return Image.open(io.BytesIO(r.read())).convert('RGB')


def main():
    part = N // PARTS
    d = SIZE / PARTS
    mosaic = Image.new('RGB', (N, N))
    for j in range(PARTS):        # j 從北邊數（圖片上方）
        for i in range(PARTS):
            print(f'下載 {j * PARTS + i + 1}/{PARTS * PARTS}')
            img = fetch(WEST + i * d, SOUTH + SIZE - (j + 1) * d, d, part)
            mosaic.paste(img, (i * part, j * part))

    rgb = np.asarray(mosaic, dtype=np.float32)
    water = np.linalg.norm(rgb - WATER, axis=2) < 18
    print(f'水的像素 {water.mean():.1%}')
    m = Image.fromarray(np.where(water, 255, 0).astype(np.uint8))
    # 去掉比約 0.7 km 窄的河道，免得河道跟著外海一起被填滿
    m = m.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))

    # 從四邊的水開始填滿相連的水域 → 128
    a = np.asarray(m)
    border = [(x, 0) for x in range(N)] + [(x, N - 1) for x in range(N)] + \
             [(0, y) for y in range(N)] + [(N - 1, y) for y in range(N)]
    for xy in border:
        if m.getpixel(xy) == 255:
            ImageDraw.floodfill(m, xy, 128)
    sea = Image.fromarray(np.where(np.asarray(m) == 128, 255, 0).astype(np.uint8))
    # 往外海縮 7 像素（約 1 km），沿岸留給 Sentinel-2；再模糊讓交界柔和
    sea = sea.filter(ImageFilter.MinFilter(15)).filter(ImageFilter.GaussianBlur(3))
    sea.save(OUT, optimize=True)
    print(f'外海 {np.asarray(sea).mean() / 255:.1%}，存到 {os.path.normpath(OUT)}')


if __name__ == '__main__':
    main()
