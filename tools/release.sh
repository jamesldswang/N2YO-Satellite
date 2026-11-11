#!/usr/bin/env bash
# 建立 GitHub Release，並上傳打包好的 zip。
# 用法（在專案資料夾）：npm run dist 之後執行 bash tools/release.sh
# 版號從 package.json 讀取；GitHub 登入資料沿用 git 已存的帳密。
set -e
cd "$(dirname "$0")/.."

VER=$(node -p "require('./package.json').version")
ZIP="dist/SatelliteTracker-$VER-win-x64.zip"
REPO=jamesldswang/N2YO-Satellite
[ -f "$ZIP" ] || { echo "找不到 $ZIP，請先執行 npm run dist"; exit 1; }

TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
[ -n "$TOKEN" ] || { echo "找不到 GitHub 登入資料"; exit 1; }

# 中文不能經過 curl 參數或環境變數傳（Windows 會轉成別的編碼，GitHub 讀不懂），
# 所以由 tools/release-body.js 直接讀 README，寫成 UTF-8 檔案給 curl 讀。
BODY_FILE=dist/release-body.json
trap 'rm -f "$BODY_FILE"' EXIT
node tools/release-body.js "$BODY_FILE"

echo "建立 Release v$VER ..."
RESP=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -X POST "https://api.github.com/repos/$REPO/releases" --data-binary @"$BODY_FILE")
ID=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(d.id||"ERR "+d.message+" "+JSON.stringify(d.errors||""))})')
case "$ID" in ERR*) echo "失敗：$ID"; exit 1;; esac

echo "上傳 $ZIP（約 $(( $(stat -c %s "$ZIP") / 1048576 )) MB，請稍等）..."
UP=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" --data-binary @"$ZIP" \
  "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$(basename "$ZIP")")
echo "$UP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);if(!d.browser_download_url){console.log("上傳失敗："+(d.message||s));process.exit(1)}console.log("已上傳："+d.browser_download_url)})'

echo "完成：https://github.com/$REPO/releases/tag/v$VER"
