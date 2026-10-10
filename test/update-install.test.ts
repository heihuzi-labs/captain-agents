import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { installationTarget, installerScript, prepareUpdate } from '../app/main/update-install.ts';
import { checkUpdateZip } from '../app/main/update-zip.ts';
import { context } from './helpers.ts';
import { zip } from './update-helpers.ts';
const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fakeApp(path: string, content = '旧版') { await mkdir(join(path, 'Contents'), { recursive: true }); await writeFile(join(path, 'Contents/Info.plist'), '假 plist'); await writeFile(join(path, 'content'), content); }

test('安装位置：开发、其它平台、异常路径、链接和不可用目录拒绝，正常 .app 可用', async t => {
  const c = await context(t, false), app = join(await realpath(c.temp), '中文 App.app'), executable = join(app, 'Contents/MacOS/应用'); await fakeApp(app);
  assert.equal((await installationTarget(executable, true, 'darwin')).path, app);
  assert.match((await installationTarget(executable, false, 'darwin')).reason!, /不带在线更新/);
  assert.match((await installationTarget(executable, true, 'win32')).reason!, /暂不支持/);
  for (const bad of ['/repo/node', '/repo/app/Contents/MacOS/Electron', 'relative.app/Contents/MacOS/app', '/x/AppTranslocation/X.app/Contents/MacOS/app']) assert.match((await installationTarget(bad, true, 'darwin')).reason!, /正常的/);
  const linked = join(c.temp, 'linked.app'); await symlink(app, linked);
  assert.match((await installationTarget(join(linked, 'Contents/MacOS/app'), true, 'darwin')).reason!, /符号链接/);
  assert.match((await installationTarget('/nonexistent/应用.app/Contents/MacOS/app', true, 'darwin')).reason!, /写权限/);
});
test('ZIP 安全目录：正规 Framework 链接通过，穿越、越界链接、链接父目录、重复名、坏头拒绝', async t => {
  const c = await context(t, false), file = join(c.temp, 'app.zip');
  await writeFile(file, zip([{ name: '应用.app/Contents/file', body: '文件', deflate: true }, { name: '应用.app/Contents/link', body: 'file', mode: 0o120777, deflate: true }]));
  await checkUpdateZip(file);
  const cases = [
    [{ name: '../escape', body: 'x' }], [{ name: '/absolute', body: 'x' }], [{ name: 'a\\b', body: 'x' }],
    [{ name: 'A.app/link', body: '../../outside', mode: 0o120777 }], [{ name: 'A.app/link', body: '/absolute', mode: 0o120777 }],
    [{ name: 'A.app/link', body: 'target', mode: 0o120777 }, { name: 'A.app/link/child', body: 'x' }],
    [{ name: 'A.app/A' }, { name: 'A.app/a' }], [{ name: 'A.app/pipe', mode: 0o010644 }],
  ];
  for (const entries of cases) { await writeFile(file, zip(entries)); await assert.rejects(checkUpdateZip(file), /不安全/); }
  await writeFile(file, 'not zip'); await assert.rejects(checkUpdateZip(file), /格式不支持/);
});
for (const fail of ['', '标识', '版本', '签名', '解压', '外链', '目录']) test(`解压并验应用${fail ? `拒绝${fail}` : '成功'}，核对失败删除文件`, async t => {
  const c = await context(t, false), file = join(c.temp, 'package.zip'), app = join(c.temp, 'unpacked/应用.app');
  await writeFile(file, zip([{ name: '应用.app/Contents/Info.plist', body: 'fake' }])); const commands: string[][] = [];
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command.endsWith('ditto')) {
      if (fail === '解压') throw new Error('failure');
      await fakeApp(app, '新版');
      if (fail === '外链') await symlink(c.home, join(app, 'outside'));
      if (fail === '目录') await fakeApp(join(c.temp, 'unpacked/extra.app'));
      return '';
    }
    if (command.endsWith('plutil')) return args[1] === 'CFBundleIdentifier' ? fail === '标识' ? 'other.id' : 'app.xagents.desk' : fail === '版本' ? '9.0.0' : '0.2.0';
    if (fail === '签名') throw new Error('codesign failure');
    return '';
  };
  if (fail) { await assert.rejects(prepareUpdate(file, c.temp, '0.2.0', run), /[\u3400-\u9fff]/u); assert.ok(!(await readdir(c.temp)).includes('unpacked')); }
  else { assert.equal(await prepareUpdate(file, c.temp, '0.2.0', run), app); assert.deepEqual(commands.at(-1), ['/usr/bin/codesign', '--verify', '--deep', '--strict', app]); }
  assert.ok(!(await readdir(c.temp)).includes('package.zip'));
});
for (const { fail, name } of [...['', 'copy', 'before-sign', 'after-sign', 'move', 'open'].map(fail => ({ fail, name: "中文 应用's $name.app" })), { fail: '', name: 'old.app' }]) test(`独立安装脚本${fail ? `在 ${fail} 失败后回退` : '成功换版并保留废纸篓旧版'}（${name}）`, async t => {
  const c = await context(t, false), installed = join(c.temp, name), staged = join(c.temp, '新版 应用.app'), trash = join(c.temp, '假的 废纸篓');
  await fakeApp(installed); await fakeApp(staged, '新版');
  const log = join(c.temp, 'opened.log');
  async function command(name: string, source: string) { const path = join(c.temp, name); await writeFile(path, '#!/bin/bash\nset -eu\n' + source, { mode: 0o700 }); return path; }
  const commands = {
    plutil: await command('fake plutil', 'if [[ "$2" == CFBundleIdentifier ]]; then echo app.xagents.desk; else echo 0.2.0; fi\n'),
    ditto: await command('fake ditto', `${fail === 'copy' ? 'exit 1\n' : ''}/bin/cp -R "$1" "$2"\n`),
    codesign: await command('fake codesign', fail === 'before-sign' ? 'exit 1\n' : fail === 'after-sign' ? `if [[ "$4" == ${quote(installed)} && "$(cat "$4/content")" == 新版 ]]; then exit 1; fi\n` : 'exit 0\n'),
    mv: await command('fake move', `${fail === 'move' ? `if [[ "$2" == ${quote(installed)} && "$1" != */old.app ]]; then exit 1; fi\n` : ''}/bin/mv "$1" "$2"\n`),
    open: await command('fake open', `${fail === 'open' ? 'if [[ "$(cat "$1/content")" == 新版 ]]; then exit 1; fi\n' : ''}cat "$1/content" >> ${quote(log)}\n`),
  };
  const script = join(c.temp, '独立 安装.sh'); await writeFile(script, installerScript(commands));
  // 用刚退出、已回收的测试进程 PID，不等待或触碰真实应用。
  const child = spawn('/bin/sleep', ['0.01']); await new Promise<void>(resolve => child.once('close', () => resolve()));
  const args = [script, installed, staged, trash, String(child.pid), '0.2.0'];
  if (fail) await assert.rejects(execute('/bin/bash', args)); else await execute('/bin/bash', args);
  assert.equal(await readFile(join(installed, 'content'), 'utf8'), fail ? '旧版' : '新版');
  assert.equal(await readFile(log, 'utf8'), fail ? '旧版' : '新版');
  if (!fail) { const backups = await readdir(trash); assert.equal(backups.length, 1); assert.equal(await readFile(join(trash, backups[0], name, 'content'), 'utf8'), '旧版'); }
  assert.ok(!(await readdir(c.temp)).some(n => n.startsWith('.xagents-update-')));
});
test('安装小程序先等待旧进程退出，再接触安装目录', async t => {
  const c = await context(t, false), installed = join(c.temp, 'old.app'), staged = join(c.temp, 'new.app'); await fakeApp(installed); await fakeApp(staged, '新版');
  const script = join(c.temp, 'install.sh');
  await writeFile(script, installerScript({ ditto: '/usr/bin/false', open: '/usr/bin/true' }));
  const sleeper = spawn('/bin/sleep', ['30']);
  t.after(() => { sleeper.kill('SIGKILL'); });
  let closed = false;
  const work = execute('/bin/bash', [script, installed, staged, join(c.temp, 'trash'), String(sleeper.pid), '0.2.0']).catch(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(closed, false); assert.equal(await readFile(join(installed, 'content'), 'utf8'), '旧版');
  sleeper.kill('SIGTERM'); await new Promise<void>(resolve => sleeper.once('close', () => resolve()));
  await work;
  assert.equal(closed, true); assert.equal(await readFile(join(installed, 'content'), 'utf8'), '旧版');
});

test('macOS 系统 ditto 生成的中文 ZIP 与 Framework 相对链接可被核对、解开', { skip: process.platform !== 'darwin' }, async t => {
  const c = await context(t, false), source = join(c.temp, '源/中文 应用.app'), file = join(c.temp, 'system.zip'), destination = join(c.temp, '下载');
  await fakeApp(source, '新版');
  await mkdir(join(source, 'Contents/Frameworks/Example.framework/Versions/A'), { recursive: true });
  await writeFile(join(source, 'Contents/Frameworks/Example.framework/Versions/A/library'), 'library');
  await symlink('A', join(source, 'Contents/Frameworks/Example.framework/Versions/Current'));
  await symlink('Versions/Current/library', join(source, 'Contents/Frameworks/Example.framework/library'));
  await execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', source, file]);
  await checkUpdateZip(file);
  await mkdir(destination);
  const app = await prepareUpdate(file, destination, '0.2.0', async (command, args) => {
    if (command.endsWith('ditto')) { await execute(command, args); return ''; }
    if (command.endsWith('plutil')) return args[1] === 'CFBundleIdentifier' ? 'app.xagents.desk' : '0.2.0';
    return ''; // 应用签名仍是替身；只验真实 ZIP 读写，不碰真实应用或签名凭据。
  });
  assert.equal(await readFile(join(app, 'content'), 'utf8'), '新版');
  assert.equal(await readFile(join(app, 'Contents/Frameworks/Example.framework/library'), 'utf8'), 'library');
});

// 2026-10-10 真实验收抓到：Electron 后台里 Node 的文件函数把 .asar 当虚拟目录，检查和清理解开的应用时出错。
// 所以这几步的文件函数必须可以换成 Electron 的 original-fs；清理失败也不能盖住真正的原因。
test('解开并核对新版：逐个文件检查和清理都走传进来的文件函数；清理失败不盖住真正的原因', async t => {
  const { mkdtemp, mkdir, writeFile, lstat, readdir, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { prepareUpdate } = await import('../app/main/update-install.ts');
  const dir = await mkdtemp(join(tmpdir(), 'xa-update-files-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source/派活工作台.app');
  await mkdir(join(source, 'Contents/Resources'), { recursive: true });
  await writeFile(join(source, 'Contents/Info.plist'), 'x'); await writeFile(join(source, 'Contents/Resources/app.asar'), 'asar');
  // 包内的相对链接（Frameworks 里常见）是允许的；数据目录在符号链接后面（macOS 的临时目录就是）也不能误判成“指向应用外”。
  const { symlink } = await import('node:fs/promises');
  await symlink('Resources/app.asar', join(source, 'Contents/Current'));
  const zip = join(dir, 'package.zip');
  const pack = () => promisify(execFile)('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, zip]);
  const seen: string[] = [];
  const files = { lstat: (async (p: string) => { seen.push('lstat ' + p); return lstat(p); }) as typeof lstat, readdir: async (p: string) => { seen.push('readdir ' + p); return readdir(p); },
    realpath: async (p: string) => realpath(p), rm: (async (p: string, o: object) => { seen.push('rm ' + p); return rm(p, o); }) as typeof rm, mkdir };
  // 外部命令用替身：ditto 真解，plutil / codesign 说“没问题”。
  const run = async (file: string, args: string[]) => file.endsWith('ditto') ? (await promisify(execFile)(file, args)).stdout : args.includes('CFBundleIdentifier') ? 'app.xagents.desk' : args.includes('CFBundleShortVersionString') ? '0.2.0' : '';
  await pack();
  const app = await prepareUpdate(zip, dir, '0.2.0', run, files);
  assert.ok(seen.includes('lstat ' + join(app, 'Contents/Resources/app.asar')), '包里的 app.asar 是用传进来的函数看的');
  assert.ok(seen.some(line => line === 'rm ' + join(dir, 'unpacked')), '开工前的清理也走传进来的函数');
  // 核对不过，而且清理也失败：报的仍是核对的原因。
  await pack();
  const broken = { ...files, rm: (async () => { throw new Error('ENOTDIR: asar'); }) as unknown as typeof rm };
  const wrong = async (file: string, args: string[]) => args.includes('CFBundleIdentifier') ? 'com.example.other' : run(file, args);
  await rm(join(dir, 'unpacked'), { recursive: true, force: true });
  await assert.rejects(prepareUpdate(zip, dir, '0.2.0', wrong, { ...broken, rm: (async (p: string, o: object) => { if (seen.length && p.endsWith('unpacked') && await lstat(p).then(() => true, () => false)) throw new Error('ENOTDIR: asar'); return rm(p, o); }) as typeof rm }), /更新包的应用标识不符，没有安装/);
});
