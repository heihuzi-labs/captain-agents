import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPlatform, platformParts, preparePlatform } from '../scripts/prepare-platform.mjs';
import { context, exec, root } from './helpers.ts';
import { isWindows } from '../src/core/platform.ts';

test('平台装配：只带 srt 依赖链、展开 pnpm 链接，平台移到仓库外仍能加载 srt', async t => {
  const c = await context(t, false), destination = join(c.temp, 'Resources/platform');
  const result = await preparePlatform(root, destination);
  assert.ok(result.packages >= 5); assert.ok(result.bytes > 0);
  for (const part of platformParts) await stat(join(destination, part));
  for (const name of ['react', 'electron', 'vite', 'typescript']) {
    await assert.rejects(stat(join(destination, 'node_modules', name)), { code: 'ENOENT' });
    assert.ok(!result.dependencies.some((pkg: string) => pkg.startsWith(`${name}@`)));
  }
  const moved = join(c.temp, '独立平台');
  await rename(destination, moved);
  const srt = await exec(process.execPath, [join(moved, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js'), '--help'], c.temp, c.env);
  assert.equal(srt.code, 0, srt.stderr); assert.match(srt.stdout, /sandbox|srt/i);
  const cli = await exec(process.execPath, [join(moved, 'bin/xagents'), 'workers'], c.temp, c.env);
  assert.equal(cli.code, 0, cli.stderr); assert.match(cli.stdout, /codex/);
  // Windows 上平台还带着调系统接口用的模块：移到仓库外照样加载得了、读得出进程列表。
  if (isWindows) {
    const rows = await exec(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(join(moved, 'src/core/native-windows.ts')).href)}); console.log(m.processRows().some(r => r.pid === process.pid));`], c.temp, c.env);
    assert.equal(rows.stdout.trim(), 'true', rows.stderr);
  }
  const dangling = join(moved, 'dangling');
  await symlink('missing', dangling);
  await assert.rejects(checkPlatform(moved), /符号链接/);
  await rm(dangling);
  await rm(join(moved, 'node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander'), { recursive: true });
  await assert.rejects(checkPlatform(moved), /缺少平台依赖.*commander/);
});

test('依赖复制：嵌套多版本、环形依赖只解析生产依赖，缺依赖时不发布半包', async t => {
  const c = await context(t, false), source = join(c.temp, 'source'), destination = join(c.temp, 'platform');
  const files = ['bin/xagents', 'src/cli/cli.ts', 'src/core/paths.ts', 'src/core/node-entry.ts', 'src/core/pty-bridge.py', 'sandbox/grok.json', 'sandbox/cursor.json', 'rules.md', 'guide/README.md', 'package.json'];
  for (const file of files) { await mkdir(dirname(join(source, file)), { recursive: true }); await writeFile(join(source, file), '{}'); }
  async function pkg(name: string, path: string, dependencies = {}, devDependencies = {}) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '1', dependencies, devDependencies }));
    return path;
  }
  const modules = join(source, 'node_modules'), store = join(modules, '.pnpm');
  const a = await pkg('@anthropic-ai/sandbox-runtime', join(store, 'srt/node_modules/@anthropic-ai/sandbox-runtime'), { a: '1', common: '1' }, { 'uninstalled-dev': '1' });
  await mkdir(join(a, 'dist')); await writeFile(join(a, 'dist/cli.js'), '');
  const b = await pkg('a', join(store, 'a/node_modules/a'), { '@anthropic-ai/sandbox-runtime': '1', common: '2' });
  const common1 = await pkg('common', join(store, 'common1/node_modules/common'));
  const common2 = await pkg('common', join(store, 'common2/node_modules/common'));
  await writeFile(join(common2, 'version'), '2');
  async function link(from: string, name: string, to: string) {
    const path = join(from, 'node_modules', name); await mkdir(dirname(path), { recursive: true }); await symlink(to, path);
  }
  await link(source, '@anthropic-ai/sandbox-runtime', a);
  await link(a, 'a', b); await link(a, 'common', common1);
  await link(b, '@anthropic-ai/sandbox-runtime', a); await link(b, 'common', common2);
  // 这里只看 srt 这条依赖链，按 macOS 的安装包装配（Windows 的还要带别的，见下一条）。
  const result = await preparePlatform(source, destination, 'mac-arm64');
  assert.equal(result.packages, 4);
  assert.equal(await readFile(join(destination, 'node_modules/@anthropic-ai/sandbox-runtime/node_modules/a/node_modules/common/version'), 'utf8'), '2');
  await rm(join(a, 'node_modules/common'));
  await assert.rejects(preparePlatform(source, destination, 'mac-arm64'), /缺少平台依赖/);
  assert.equal((await checkPlatform(destination, 'mac-arm64')).packages, 4);
});

test('Windows 的安装包带上调系统接口的模块和这种芯片的编译产物，两个包并排放；缺了或版本对不上就不出包', async t => {
  const c = await context(t, false), source = join(c.temp, 'source'), destination = join(c.temp, 'platform');
  for (const file of ['bin/xagents', 'src/cli/cli.ts', 'src/core/paths.ts', 'src/core/node-entry.ts', 'src/core/pty-bridge.py', 'sandbox/grok.json', 'sandbox/cursor.json', 'rules.md', 'guide/README.md', 'package.json']) {
    await mkdir(dirname(join(source, file)), { recursive: true }); await writeFile(join(source, file), '{}');
  }
  const store = join(source, 'node_modules/.pnpm');
  async function pkg(name: string, path: string, version = '1') {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version }));
    return path;
  }
  async function link(name: string, to: string) {
    const path = join(source, 'node_modules', name); await mkdir(dirname(path), { recursive: true }); await symlink(to, path, 'junction');
  }
  const srt = await pkg('@anthropic-ai/sandbox-runtime', join(store, 'srt/node_modules/@anthropic-ai/sandbox-runtime'));
  await mkdir(join(srt, 'dist')); await writeFile(join(srt, 'dist/cli.js'), '');
  await link('@anthropic-ai/sandbox-runtime', srt);
  // 包管理器的摆法：模块和它的编译产物在同一个 node_modules 里并排，项目的 node_modules 里只有模块自己的链接。
  const koffi = await pkg('koffi', join(store, 'koffi/node_modules/koffi'), '3');
  await link('koffi', koffi);
  await assert.rejects(preparePlatform(source, destination, 'win-x64'), /缺少平台依赖：@koromix\/koffi-win32-x64/);
  const binary = await pkg('@koromix/koffi-win32-x64', join(store, 'koffi/node_modules/@koromix/koffi-win32-x64'), '3');
  await mkdir(join(binary, 'win32_x64')); await writeFile(join(binary, 'win32_x64/koffi.node'), 'x');
  const result = await preparePlatform(source, destination, 'win-x64');
  assert.deepEqual(result.dependencies, ['@anthropic-ai/sandbox-runtime@1', 'koffi@3', '@koromix/koffi-win32-x64@3']);
  assert.equal(await readFile(join(destination, 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'), 'utf8'), 'x');
  await stat(join(destination, 'node_modules/koffi/package.json'));
  // macOS 的安装包不带。
  const mac = join(c.temp, 'platform-mac');
  assert.deepEqual((await preparePlatform(source, mac, 'mac-arm64')).dependencies, ['@anthropic-ai/sandbox-runtime@1']);
  await assert.rejects(stat(join(mac, 'node_modules/koffi')), { code: 'ENOENT' });
  await assert.rejects(checkPlatform(mac, 'win-x64'), /缺少平台依赖：koffi/);
  await writeFile(join(destination, 'node_modules/koffi/package.json'), JSON.stringify({ name: 'koffi', version: '4' }));
  await assert.rejects(checkPlatform(destination, 'win-x64'), /版本对不上/);
});
