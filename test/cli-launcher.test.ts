import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCliLauncher, cliLauncherStatus, installCliLauncher } from '../app/main/cli-launcher.ts';
import { context, exec } from './helpers.ts';

test('命令行安装：三种状态、拒绝覆盖、显式替换、旧应用与悬空链接', async t => {
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

test('命令行启动脚本：空格、中文、引号与 shell 字符均原样传递，不依赖 PATH 中的 Node', async t => {
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
