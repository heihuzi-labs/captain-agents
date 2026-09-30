import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { desktopPath, unpackedPath } from '../src/core/paths.ts';
import { externalPackages } from '../scripts/check-desktop-bundle.mjs';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('外部程序路径：只替换完整 app.asar 路径段，开发路径和已解包路径不变', () => {
  assert.equal(unpackedPath('/Applications/派活工作台.app/Contents/Resources/app.asar/src/core/pty-bridge.py'),
    '/Applications/派活工作台.app/Contents/Resources/app.asar.unpacked/src/core/pty-bridge.py');
  for (const path of ['/repo/src/core/pty-bridge.py', '/app.asar.unpacked/src/core/pty-bridge.py', '/my-app.asar/file']) {
    assert.equal(unpackedPath(path), path);
  }
  assert.equal(unpackedPath('app.asar/file'), 'app.asar.unpacked/file');
});

test('桌面 PATH：只追加存在的目录，保留原顺序，重复调用不重复追加', async t => {
  const home = await mkdtemp(join(tmpdir(), 'xagents-path-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const local = join(home, '.local/bin'), grok = join(home, '.grok/bin');
  await mkdir(local, { recursive: true });
  await mkdir(join(home, '.grok'));
  await writeFile(grok, '这是文件，不是目录');
  const original = `/usr/bin:/bin:${local}:/custom/bin`;
  const first = desktopPath(original, home);
  assert.deepEqual(first.split(':').slice(0, 4), original.split(':'));
  assert.equal(first.split(':').filter(p => p === local).length, 1);
  assert.ok(!first.split(':').includes(grok));
  assert.equal(desktopPath(first, home), first);
  await rm(grok); await mkdir(grok);
  // 固定系统目录用替身，测试结果不取决于机器是否装了 Homebrew。
  const existing = new Set([local, grok, '/opt/homebrew/bin']);
  const hasDirectory = (path: string) => existing.has(path);
  assert.equal(desktopPath(original, home, hasDirectory), `${original}:${grok}:/opt/homebrew/bin`);
  assert.equal(desktopPath(undefined, home, hasDirectory), `${local}:${grok}:/opt/homebrew/bin`);
  assert.equal(desktopPath('', home, () => false), '');
});

test('打包后的模块位置仍把 toolRoot 指向 app.asar，Python 使用解包路径', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'xagents-asar-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const appRoot = join(temp, '派活工作台.app/Contents/Resources/app.asar');
  const module = join(appRoot, 'out/main/paths.ts');
  await mkdir(join(appRoot, 'out/main'), { recursive: true });
  await writeFile(module, await readFile(join(root, 'src/core/paths.ts')));
  const packed = await import(pathToFileURL(module).href);
  assert.equal(packed.toolRoot, `${appRoot}/`);
  assert.equal(packed.unpackedPath(join(packed.toolRoot, 'src/core/pty-bridge.py')), `${appRoot}.unpacked/src/core/pty-bridge.py`);
});

test('打包配置：中文名、固定应用标识、图标、Python 解包、只出 arm64 目录', () => {
  const config = pkg.build;
  assert.equal(config.productName, '派活工作台'); assert.equal(config.appId, 'app.xagents.desk');
  assert.equal(config.mac.icon, 'build/icon.icns'); assert.equal(config.mac.identity, null);
  assert.deepEqual(config.mac.target, [{ target: 'dir', arch: ['arm64'] }]);
  assert.deepEqual(config.files.filter((p: string) => !p.startsWith('!')), ['out/**', 'package.json', 'src/core/pty-bridge.py']);
  assert.ok(config.files.includes('!node_modules{,/**/*}'));
  assert.ok(config.asarUnpack.includes('src/core/pty-bridge.py'));
  assert.equal(config.asar, true); assert.equal(config.npmRebuild, false);
  assert.match(pkg.scripts.pack, /^electron-vite build && node scripts\/check-desktop-bundle.mjs && electron-builder --mac dir --arm64$/);
});

test('electron-builder 实际文件过滤器排除 pnpm 软链接背后的依赖文件', async t => {
  const home = await mkdtemp(join(tmpdir(), 'xagents-package-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const realModule = join(home, 'node_modules/.pnpm/example@1/node_modules/example');
  await mkdir(join(realModule, 'lib'), { recursive: true });
  await writeFile(join(realModule, 'package.json'), '{"name":"example","version":"1"}');
  await writeFile(join(realModule, 'lib/index.js'), 'module.exports = 1;');
  const link = join(home, 'node_modules/example');
  await symlink('.pnpm/example@1/node_modules/example', link);
  const require = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
  const { getNodeModuleFileMatcher, FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
  const { NodeModuleCopyHelper } = require('app-builder-lib/out/util/NodeModuleCopyHelper.js');
  const packager = { config: pkg.build, appInfo: { type: 'module' }, debugLogger: { isEnabled: false }, getWorkspaceRoot: async () => home };
  const matcher = getNodeModuleFileMatcher(home, join(home, 'destination'), (p: string) => p, pkg.build.mac, packager);
  for (const source of [link, await realpath(link)]) {
    const copier = new NodeModuleCopyHelper(new FileMatcher(source, join(home, 'destination/node_modules/example'), (p: string) => p, matcher.patterns), packager);
    assert.deepEqual(await copier.collectNodeModules({ name: 'example', dir: source }, [], 'node_modules/example'), []);
  }
});

test('构建产物检查：允许 Electron 和 Node，拒绝外部包和不能确认的动态加载', () => {
  assert.deepEqual(externalPackages('import { app } from "electron"; import fs from "node:fs"; require("path"); import("./chunk.js"); const text = "require(react)";', 'index.js'), []);
  assert.deepEqual(externalPackages('import "react"; export { x } from "react-dom"; require("@anthropic-ai/sandbox-runtime"); import("another"); __require(variable);', 'index.js'),
    ['react', 'react-dom', '@anthropic-ai/sandbox-runtime', 'another', 'index.js：无法静态确认的动态依赖']);
});

test('安装脚本语法正确，旧版只移到废纸篓；步骤失败即停', async () => {
  const path = join(root, 'scripts/install-app.sh'), source = await readFile(path, 'utf8');
  const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(source, /set -euo pipefail/);
  assert.doesNotMatch(source, /\brm\s+[^\n]*-rf/);
  assert.match(source, /mktemp -d "\$HOME\/\.Trash\//);
  const stages = ['npm run pack', 'codesign --force --deep --sign -', 'codesign --verify --deep --strict', 'pids="$(running_pids)"', 'mv "$installed"', 'mv "$support/派活台" "$support/派活工作台"', 'ditto "$app" "$installed"', 'open "$installed"'];
  let position = -1;
  for (const stage of stages) { const next = source.indexOf(stage); assert.ok(next > position, stage); position = next; }
});

test('安装脚本只匹配开发版和已装版主进程，不匹配其他 Electron、辅助进程或 shell 命令', async () => {
  const source = await readFile(join(root, 'scripts/install-app.sh'), 'utf8');
  // 不设语言环境时 macOS 的 ps 会把中文路径转义成 M-f…，匹配不上“派活工作台”，旧进程就关不掉（2026-09-30 踩过）。
  assert.match(source, /LC_ALL=en_US\.UTF-8 ps -axo/);
  const awk = /\| (?:LC_ALL=\S+ )?awk '([\s\S]*?)'/.exec(source)![1];
  const commands = [
    '101 /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js',
    '102 Electron /repo/out/main/index.js',
    '103 /Applications/派活工作台.app/Contents/MacOS/派活工作台',
    '104 /Applications/Other.app/Contents/MacOS/Electron /other/app.js',
    '105 /Applications/派活工作台.app/Contents/Frameworks/派活工作台 Helper.app/Contents/MacOS/派活工作台 Helper --type=renderer',
    '106 bash -c /repo/Electron out/main/index.js',
    '107 /repo/Electron out/main/index.js.other',
    // 改名前的已装版也要能关掉。
    '108 /Applications/派活台.app/Contents/MacOS/派活台',
    '109 /Applications/派活台.app/Contents/Frameworks/派活台 Helper.app/Contents/MacOS/派活台 Helper --type=gpu-process',
  ];
  const result = spawnSync('awk', [awk], { input: commands.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '101\n102\n103\n108\n');
});
