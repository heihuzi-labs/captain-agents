// 把 build/icon.svg 渲染成 build/icon.icns（macOS 应用图标）。用法：npm run icon。
// 用仓库自带的 Electron 在后台窗口里渲染 1024×1024，再用系统自带的 sips、iconutil 出各档尺寸，不需要装别的工具。
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8');
app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, javascript: false } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = image.resize({ width: 1024, height: 1024 }).toPNG();
  const set = join(root, 'build/icon.iconset');
  rmSync(set, { recursive: true, force: true }); mkdirSync(set, { recursive: true });
  const master = join(set, 'icon_512x512@2x.png'); writeFileSync(master, png);
  for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512]]) {
    execFileSync('sips', ['-z', String(size), String(size), master, '--out', join(set, `icon_${name}.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build/icon.icns')]);
  writeFileSync(join(root, 'build/icon.png'), png);
  rmSync(set, { recursive: true, force: true });
  console.log('已生成 build/icon.icns 和 build/icon.png');
  app.quit();
});
