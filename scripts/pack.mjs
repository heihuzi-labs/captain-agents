// 打包：构建 → 准备应用自带的平台 → 核对产物 → 交给 electron-builder。
// 用法：node scripts/pack.mjs [mac-arm64|mac-x64|win-x64]；不写就按本机的系统和芯片。
// 产物：mac-arm64 在 dist/mac-arm64/，mac-x64 在 dist/mac/，都是没压缩的 .app；win-x64 是 dist/ 下的安装程序。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGETS = {
  'mac-arm64': ['--mac', 'dir', '--arm64'],
  'mac-x64': ['--mac', 'dir', '--x64'],
  'win-x64': ['--win', 'nsis', '--x64'],
};
export const hostTarget = (platform = process.platform, arch = process.arch) => `${{ darwin: 'mac', win32: 'win' }[platform] ?? platform}-${arch}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? hostTarget();
  if (!Object.hasOwn(TARGETS, target)) { console.error(`不认识的打包目标：${target}。可以写：${Object.keys(TARGETS).join('、')}。`); process.exit(1); }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const steps = [
    ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
    ['scripts/prepare-platform.mjs'],
    ['scripts/check-desktop-bundle.mjs'],
    ['node_modules/electron-builder/cli.js', ...TARGETS[target]],
  ];
  for (const [script, ...args] of steps) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
