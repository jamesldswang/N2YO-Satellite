'use strict';
// 打包成可攜式資料夾 + zip：dist/SatelliteTracker-<版號>-win-x64(.zip)
// 用法：npm run dist
//
// 直接放入這台電腦上原版、有 OpenJS Foundation 數位簽章的 node.exe（內容不改），
// 由 start.cmd / start.vbs 啟動。不做成單一 .exe：那需要改寫 node.exe，
// 簽章會失效，Windows 11「智慧型應用程式控制」會擋下。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require('./package.json');
const name = `SatelliteTracker-${pkg.version}-win-x64`;
const dist = path.join(__dirname, 'dist');
const out = path.join(dist, name);
const zip = `${out}.zip`;

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('只能在 Windows x64 上打包');

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  fs.mkdirSync(out, { recursive: true });

  for (const f of ['server.js', 'collector.js', 'package.json', 'README.md', '.env.example', 'start.cmd', 'start.vbs', 'autostart.cmd']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
  }
  fs.cpSync(path.join(__dirname, 'public'), path.join(out, 'public'), { recursive: true });

  fs.copyFileSync(process.execPath, path.join(out, 'node.exe'));
  // node.exe 的授權條款（MIT 及內含元件），散布時要一起附上。
  const res = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!res.ok) throw new Error(`下載 Node.js LICENSE 失敗：HTTP ${res.status}`);
  fs.writeFileSync(path.join(out, 'node-LICENSE.txt'), await res.text());

  // 用 Windows 內建的 bsdtar 壓 zip（Git Bash 的 GNU tar 不支援 zip）。
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', dist, name], { stdio: 'inherit' });

  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`完成：${zip}（${mb} MB，內含 Node.js ${process.version}）`);
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
