import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCliLauncher, cliLauncherStatus, installCliLauncher } from '../app/main/cli-launcher.ts';
import { context, exec } from './helpers.ts';

test('命令行安装：三种状态、拒绝覆盖、显式替换、旧应用与悬空链接', { skip: process.platform === 'win32' ? '只属于 macOS：.app 内置命令行的 sh 启动脚本及执行权限' : false }, async t => {
  const c = await context(t, false), home = join(c.temp, '用户'), target = join(home, '.local/bin/xagents');
  const options = { home, executable: '/Applications/派活 工作台.app/Contents/MacOS/派活工作台', platform: '/Applications/派活 工作台.app/Contents/Resources/platform' };
  const cli = createCliLauncher(options);
  assert.equal(await cli.cliLauncherStatus(), 'missing');
  await cli.installCliLauncher();
  assert.equal(await cli.cliLauncherStatus(), 'installed');
  assert.ok((await stat(target)).mode & 0o111);
  const content = await readFile(target, 'utf8');
  assert.match(content, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(content, /platform\/bin\/xagents' "\$@"/);
  await Promise.all([cli.installCliLauncher(), cli.installCliLauncher()]);
  assert.equal(await readFile(target, 'utf8'), content);
  assert.equal((await readdir(dirname(target))).filter(n => n.endsWith('.tmp')).length, 0);
  assert.equal(await createCliLauncher({ ...options, executable: '/different/app' }).cliLauncherStatus(), 'other');
  assert.equal(await createCliLauncher({ ...options, platform: '/different/platform' }).cliLauncherStatus(), 'other');
  await chmod(target, 0o600);
  assert.equal(await cli.cliLauncherStatus(), 'other');
  await writeFile(target, '别人的命令行');
  await assert.rejects(cli.installCliLauncher(), /已存在.*replace: true/);
  assert.equal(await readFile(target, 'utf8'), '别人的命令行');
  await cli.installCliLauncher({ replace: true });
  assert.equal(await cli.cliLauncherStatus(), 'installed');
  await rm(target);
  const developer = join(c.temp, 'developer-cli');
  await writeFile(developer, '开发者入口');
  await symlink(developer, target);
  assert.equal(await cli.cliLauncherStatus(), 'other');
  await assert.rejects(cli.installCliLauncher(), /已存在/);
  await cli.installCliLauncher({ replace: true });
  assert.equal(await readFile(developer, 'utf8'), '开发者入口');
  await rm(target); await symlink(join(c.temp, 'missing'), target);
  assert.equal(await cli.cliLauncherStatus(), 'other');
  await assert.rejects(cli.installCliLauncher(), /已存在/);
});

test('命令行启动脚本：空格、中文、引号与 shell 字符均原样传递，不依赖 PATH 中的 Node', { skip: process.platform === 'win32' ? '只属于 macOS：.app 内置命令行的 sh 启动脚本及执行权限' : false }, async t => {
  const c = await context(t, false), home = join(c.temp, '家目录');
  const app = join(c.temp, "派活 ' $工作台.app"), executable = join(app, 'Contents/MacOS/派活工作台');
  const platform = join(app, "Contents/Resources/平台 '目录"), capture = join(c.temp, 'capture.json');
  await mkdir(dirname(executable), { recursive: true });
  // 替身只记录参数和运行时开关，不打开 Electron。
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), mode: process.env.ELECTRON_RUN_AS_NODE }));\n`, { mode: 0o755 });
  const cli = createCliLauncher({ home, executable, platform });
  await cli.installCliLauncher();
  const args = ['workers', '中文 空格', "'\"", '$(false) `false` ; false', '', '换\n行'];
  const result = await exec(join(home, '.local/bin/xagents'), args, c.temp, { PATH: '/usr/bin:/bin' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { args: [join(platform, 'bin/xagents'), ...args], mode: '1' });
});

test('开发版：状态是 other，拒绝安装且不碰家目录', async t => {
  const c = await context(t, false), home = join(c.temp, '未创建的家目录');
  const cli = createCliLauncher({ home, executable: process.execPath });
  assert.equal(await cli.cliLauncherStatus(), 'other');
  await assert.rejects(cli.installCliLauncher({ replace: true }), /开发版不安装命令行/);
  await assert.rejects(stat(home), { code: 'ENOENT' });
  assert.equal(await cliLauncherStatus(), 'other');
  await assert.rejects(installCliLauncher(), /开发版不安装命令行/);
});

test('Windows 的命令行启动脚本：两个文件（给 PowerShell 和命令提示符的 .cmd、给 Git 终端的 sh），内容写的是这个应用里的那一份', async t => {
  const { launcherFiles } = await import('../app/main/cli-launcher.ts');
  const c = await context(t, false), bin = join(c.temp, 'bin');
  const executable = 'C:\\Apps\\派活 工作台\\派活工作台.exe', platform = 'C:\\Apps\\派活 工作台\\resources\\platform';
  const files = launcherFiles({ home: 'C:\\Users\\me', executable, platform, windows: true, binDir: bin });
  assert.deepEqual(files.map(f => f.path), [join(bin, 'xagents.cmd'), join(bin, 'xagents')]);
  assert.equal(files[0].content, ['@echo off', 'rem xagents desktop CLI launcher v1', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"',
    '"C:\\Apps\\派活 工作台\\派活工作台.exe" "C:\\Apps\\派活 工作台\\resources\\platform\\bin\\xagents" %*', ''].join('\r\n'));
  assert.equal(files[1].content, "#!/bin/sh\n# xagents desktop CLI launcher v1\nELECTRON_RUN_AS_NODE=1 exec 'C:/Apps/派活 工作台/派活工作台.exe' 'C:/Apps/派活 工作台/resources/platform/bin/xagents' \"$@\"\n");
  // 没指定位置时放进用户自己的 WindowsApps。
  assert.deepEqual(launcherFiles({ home: 'C:\\Users\\me', executable, platform, windows: true }, { LOCALAPPDATA: 'D:\\Local' }).map(f => f.path.replaceAll('/', '\\')),
    ['D:\\Local\\Microsoft\\WindowsApps\\xagents.cmd', 'D:\\Local\\Microsoft\\WindowsApps\\xagents']);
  assert.throws(() => launcherFiles({ home: 'h', executable: 'C:\\100%\\app.exe', platform, windows: true, binDir: bin }), /带 % 或引号的位置/);
  assert.deepEqual(launcherFiles({ home: 'h', executable, windows: true, binDir: bin }), [], '开发版不装');
});

test('Windows 的命令行安装：两个文件都对才算已安装；别人的不覆盖；装到一半接着装完；替换要明说', async t => {
  const c = await context(t, false), bin = join(c.temp, 'windows apps');
  const cli = createCliLauncher({ home: c.temp, executable: 'C:\\App\\app.exe', platform: 'C:\\App\\resources\\platform', windows: true, binDir: bin });
  assert.equal(await cli.cliLauncherStatus(), 'missing');
  await cli.installCliLauncher();
  assert.equal(await cli.cliLauncherStatus(), 'installed');
  assert.deepEqual((await readdir(bin)).filter(n => !n.startsWith('.')).sort(), ['xagents', 'xagents.cmd']);
  await rm(join(bin, 'xagents'));
  assert.equal(await cli.cliLauncherStatus(), 'other', '只剩一个不算装好');
  await cli.installCliLauncher();
  assert.equal(await cli.cliLauncherStatus(), 'installed', '另一个是自己的，接着装完，不用替换');
  await writeFile(join(bin, 'xagents.cmd'), '别人的');
  assert.equal(await cli.cliLauncherStatus(), 'other');
  await assert.rejects(cli.installCliLauncher(), /xagents\.cmd 已存在.*replace: true/);
  assert.equal(await readFile(join(bin, 'xagents.cmd'), 'utf8'), '别人的');
  await cli.installCliLauncher({ replace: true });
  assert.equal(await cli.cliLauncherStatus(), 'installed');
  assert.equal(await createCliLauncher({ home: c.temp, executable: 'C:\\Other\\app.exe', platform: 'C:\\App\\resources\\platform', windows: true, binDir: bin }).cliLauncherStatus(), 'other');
});

test('Windows 的命令行启动脚本真的能跑：参数和中文、空格原样交给应用里的平台', { skip: process.platform !== 'win32' ? '只在 Windows 上成立：要用命令提示符和 Git 的终端真的启动' : false }, async t => {
  const c = await context(t, false), bin = join(c.temp, 'bin dir'), platform = join(c.temp, '平台 目录');
  const capture = join(c.temp, 'capture.json');
  await mkdir(join(platform, 'bin'), { recursive: true });
  // 替身“应用”就是 Node；替身“平台入口”只记下参数和运行时开关。
  await writeFile(join(platform, 'bin', 'xagents'), `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), mode: process.env.ELECTRON_RUN_AS_NODE }));\n`);
  const cli = createCliLauncher({ home: c.temp, executable: process.execPath, platform, windows: true, binDir: bin });
  await cli.installCliLauncher();
  const args = ['workers', '中文 空格', 'a=b', '--flag'];
  const cmd = await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/c', join(bin, 'xagents.cmd'), ...args], c.temp, c.env);
  assert.equal(cmd.code, 0, cmd.stderr + cmd.stdout);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { args, mode: '1' });
  await rm(capture);
  const { shell } = await import('../src/core/platform.ts');
  const sh = await exec(shell('x').file, [join(bin, 'xagents'), ...args], c.temp, c.env);
  assert.equal(sh.code, 0, sh.stderr + sh.stdout);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { args, mode: '1' });
});
