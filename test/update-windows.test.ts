import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { windowsExecutableVersion } from '../app/main/update-exe.ts';
import { checkWindowsPackage, cleanWindowsDownloads, launchWindowsInstaller, prepareWindowsUpdate, verifyWindowsInstaller, windowsInstallationTarget, windowsInstallerArguments, windowsPackageName } from '../app/main/update-windows.ts';
import type { WindowsTargetFiles } from '../app/main/update-windows.ts';
import { updateClient } from '../app/main/update-download.ts';
import { createUpdater } from '../app/main/updater.ts';
import { context } from './helpers.ts';
import { feed, publicKey, response, signed } from './update-helpers.ts';

// 最小 PE32，RT_VERSION 的三级目录和 VS_FIXEDFILEINFO 都是真实格式。
function executable(version = '0.3.0') {
  const data = Buffer.alloc(1024);
  data.write('MZ'); data.writeUInt32LE(64, 60); data.writeUInt32LE(0x4550, 64);
  data.writeUInt16LE(0x14c, 68); data.writeUInt16LE(1, 70); data.writeUInt16LE(224, 84); data.writeUInt16LE(2, 86);
  data.writeUInt16LE(0x10b, 88); data.writeUInt32LE(16, 88 + 92); data.writeUInt32LE(0x1000, 88 + 112); data.writeUInt32LE(512, 88 + 116);
  data.writeUInt32LE(0x1000, 312 + 12); data.writeUInt32LE(512, 312 + 16); data.writeUInt32LE(512, 312 + 20);
  for (const [offset, id, next] of [[0, 16, 24], [24, 1, 48], [48, 1033, 72]]) {
    data.writeUInt16LE(1, 512 + offset + 14); data.writeUInt32LE(id, 512 + offset + 16);
    data.writeUInt32LE(next === 72 ? next : (next | 0x80000000) >>> 0, 512 + offset + 20);
  }
  data.writeUInt32LE(0x1000 + 88, 512 + 72); data.writeUInt32LE(92, 512 + 76);
  const v = 512 + 88, [major, minor, patch] = version.split('.').map(Number);
  data.writeUInt16LE(92, v); data.writeUInt16LE(52, v + 2); data.write('VS_VERSION_INFO\0', v + 6, 'utf16le');
  data.writeUInt32LE(0xfeef04bd, v + 40); data.writeUInt32LE((major << 16 | minor) >>> 0, v + 48); data.writeUInt32LE((patch << 16) >>> 0, v + 52);
  return data;
}
test('Windows 安装目录：自选目录、大小写和斜杠；解压版、链接、缺文件及不可写都拒绝', async t => {
  const c = await context(t, false), regular = await lstat(join(c.temp, 'task.md')), calls: string[] = [];
  const target = 'D:\\中文 App\\captain-agents';
  let missing = '', linked = false, writable = true, real = target;
  const files: WindowsTargetFiles = {
    lstat: async path => { calls.push(String(path)); if (String(path).includes(missing) && missing) throw new Error('ENOENT'); return { ...regular, isFile: () => true, isSymbolicLink: () => linked } as typeof regular; },
    realpath: async () => real,
    mkdtemp: async prefix => { if (!writable) throw new Error('EACCES'); return prefix + 'probe'; },
    rm: async () => {},
  };
  assert.equal((await windowsInstallationTarget(target + '\\captain-agents.exe', files)).path, target);
  assert.equal((await windowsInstallationTarget(target.replaceAll('\\', '/') + '/CAPTAIN-AGENTS.EXE', files)).path, target);
  assert.ok(calls.includes(win32.join(target, 'Uninstall captain-agents.exe')));
  for (const name of ['Uninstall', 'app.asar']) { missing = name; assert.match((await windowsInstallationTarget(target + '\\captain-agents.exe', files)).reason!, /正常.*手动/); }
  missing = ''; linked = true; assert.match((await windowsInstallationTarget(target + '\\captain-agents.exe', files)).reason!, /链接/);
  // 上层目录是链接或短路径名：不拦，装到展开后的真实位置。
  linked = false; real = 'D:\\LONGNA~1\\captain-agents'; assert.equal((await windowsInstallationTarget(target + '\\captain-agents.exe', files)).path, real);
  real = target; writable = false; assert.match((await windowsInstallationTarget(target + '\\captain-agents.exe', files)).reason!, /写权限/);
  for (const path of ['relative\\captain-agents.exe', '\\\\server\\share\\captain-agents.exe', 'C:\\captain-agents.exe', target + '\\Electron.exe']) assert.ok((await windowsInstallationTarget(path, files)).reason);
});
test('Windows 包：EXE 文件名、清单版本、PE 与内嵌版本、大小和哈希；失败清理', async t => {
  const c = await context(t, false), name = windowsPackageName('0.3.0'), file = join(c.temp, name), data = executable();
  const pkg = { urls: ['https://example.invalid/' + name], size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  await writeFile(file, data);
  assert.equal(await windowsExecutableVersion(file), '0.3.0.0');
  assert.equal(await prepareWindowsUpdate(file, '0.3.0', pkg), file);
  assert.equal(checkWindowsPackage(pkg, '0.3.0'), name);
  for (const bad of ['captain-agents_0.2.9_windows-x64.exe', 'captain-agents_0.3.0_windows-arm64.exe', 'app.zip']) assert.throws(() => checkWindowsPackage({ ...pkg, urls: ['https://example.invalid/' + bad] }, '0.3.0'), /文件名或版本/);
  for (const body of [executable('0.3.1'), Buffer.alloc(data.length), data.subarray(0, 60)]) {
    await writeFile(file, body);
    await assert.rejects(prepareWindowsUpdate(file, '0.3.0', { ...pkg, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }), /版本|Windows 可执行/);
    assert.equal((await readdir(c.temp)).includes(name), false);
  }
  await writeFile(file, data); await assert.rejects(verifyWindowsInstaller(file, '0.3.0', { ...pkg, sha256: '0'.repeat(64) }), /发布的不一致/);
  await assert.rejects(verifyWindowsInstaller(file, '0.3.0', { ...pkg, size: 1 }), /大小/);
  const renamed = join(c.temp, 'renamed.exe'); await writeFile(renamed, data); await assert.rejects(verifyWindowsInstaller(renamed, '0.3.0', pkg), /文件名/);
  // PE 指针越界、错误架构、DLL、版本目录越界，均不能只靠 MZ 头放行。
  for (const [offset, value, bytes] of [[60, 0xffffffff, 4], [68, 0xaa64, 2], [86, 0x2002, 2], [512 + 20, 0xffffffff, 4]]) {
    const bad = Buffer.from(data); if (bytes === 2) bad.writeUInt16LE(value, offset); else bad.writeUInt32LE(value, offset);
    await writeFile(file, bad); await assert.rejects(windowsExecutableVersion(file), /Windows 可执行/);
  }
});
test('Windows 更新共用下载换源和状态机；就绪后被篡改不能重启，启动成功才退出', async t => {
  const c = await context(t, false), data = executable(), name = windowsPackageName('0.3.0');
  const pkg = { urls: ['https://store.invalid/' + name, 'https://pages.invalid/' + name], size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const addresses: string[] = [], client = updateClient({ feed: 'https://store.invalid/latest-v2.json', hosts: ['pages.invalid'], version: '0.2.0', fetch: async url => { addresses.push(url.host); return response([url.host === 'store.invalid' ? Buffer.alloc(data.length) : data]); } });
  let quit = false, starts = 0;
  const updater = createUpdater({ version: '0.2.0', platform: 'win32', arch: 'x64', publicKey, autoCheck: false,
    fetchFeed: async verify => verify(signed(feed({ version: '0.3.0', packages: { 'darwin-arm64': feed().packages['darwin-arm64'], 'win32-x64': pkg } }))),
    download: (pkg, progress, version) => client.download(pkg, c.temp, progress, checkWindowsPackage(pkg, version)),
    prepare: (file, version) => prepareWindowsUpdate(file, version, pkg),
    restart: async (file, version) => { await verifyWindowsInstaller(file, version, pkg); starts++; quit = true; }, saveAutoCheck: async () => {}, publish: () => {},
  });
  assert.equal((await updater.check()).phase, 'available'); await updater.download(); assert.equal(updater.info().update.phase, 'ready');
  assert.deepEqual(addresses, ['store.invalid', 'pages.invalid']);
  assert.equal(quit, false); await writeFile(join(c.temp, name), Buffer.alloc(data.length)); await updater.restart();
  assert.equal(updater.info().update.phase, 'error'); assert.equal(starts, 0); assert.equal(quit, false);
  await updater.check(); await updater.download(); await updater.restart(); assert.equal(starts, 1); assert.equal(quit, true);
  await cleanWindowsDownloads(c.temp); assert.equal((await readdir(c.temp)).includes(name), false);
});
test('Windows 启动参数：中文、空格、& 原样传给 EXE；/D 最后无引号，无外壳，spawn 失败不成功', async () => {
  const installed = 'D:\\中文 App & tools\\captain-agents';
  assert.deepEqual(windowsInstallerArguments(installed), ['/S', '--updated', '--force-run', '/currentuser', '/D=' + installed]);
  const file = 'C:\\下载 目录\\' + windowsPackageName('0.3.0'); let unref = false;
  await launchWindowsInstaller(file, installed, ((command, args, options) => {
    assert.equal(command, file); assert.deepEqual(args, windowsInstallerArguments(installed));
    assert.deepEqual(options, { argv0: `"${file}"`, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, cwd: win32.dirname(file) });
    const child = Object.assign(new EventEmitter(), { unref() { unref = true; } }); queueMicrotask(() => child.emit('spawn')); return child;
  }) as never);
  assert.equal(unref, true);
  await assert.rejects(launchWindowsInstaller(file, installed, (() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('EACCES'))); return child; }) as never), /EACCES/);
  for (const bad of ['relative', 'C:\\', installed + '\\', installed + '"', installed + '\n', 'D:\\a\\..\\b']) assert.throws(() => windowsInstallerArguments(bad), /安装目录/);
});
test('NSIS 自定义检查由安装器和卸载器共用，不启动 PowerShell/cmd、不强杀任务', async () => {
  const script = await readFile(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  const instructions = script.split('\n').filter(line => !line.trim().startsWith(';')).join('\n');
  assert.match(instructions, /!macro customCheckAppRunning/); assert.match(instructions, /nsProcess::_FindProcess/);
  // 唯一允许启动的程序：放弃更新前把原来的应用重新打开（静默安装时没人看得到提示）。
  const reopen = `Exec '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}"'`;
  assert.equal(instructions.split(reopen).length, 2, '只在等不到旧进程退出时重开原来的应用');
  assert.doesNotMatch(instructions.replace(reopen, ''), /\bExec(?:Wait|Shell)?\b|PowerShell|cmd\.exe|_KillProcess|_CloseProcess/i);
});
