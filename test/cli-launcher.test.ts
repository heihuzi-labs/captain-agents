import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCliLauncher, cliLauncherStatus, installCliLauncher, launcherFiles, refreshCliLauncher } from '../app/main/cli-launcher.ts';
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
  assert.equal(await cli.refreshCliLauncher(), false);
  assert.equal(await refreshCliLauncher(), false);
  await assert.rejects(stat(home), { code: 'ENOENT' });
  assert.equal(await cliLauncherStatus(), 'other');
  await assert.rejects(installCliLauncher(), /开发版不安装命令行/);
});

test('Windows 的命令行启动脚本：两个文件（给 PowerShell 和命令提示符的 .cmd、给 Git 终端的 sh），内容写的是这个应用里的那一份', async t => {
  const c = await context(t, false), bin = join(c.temp, 'bin');
  const executable = 'C:\\Apps\\派活 工作台\\captain-agents.exe', platform = 'C:\\Apps\\派活 工作台\\resources\\platform';
  const files = launcherFiles({ home: 'C:\\Users\\me', executable, platform, windows: true, binDir: bin });
  assert.deepEqual(files.map(f => f.path), [join(bin, 'xagents.cmd'), join(bin, 'xagents')]);
  assert.equal(files[0].content, ['@echo off', 'rem xagents desktop CLI launcher v1', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"',
    '"C:\\Apps\\派活 工作台\\captain-agents.exe" "C:\\Apps\\派活 工作台\\resources\\platform\\bin\\xagents" %*', ''].join('\r\n'));
  assert.equal(files[1].content, "#!/bin/sh\n# xagents desktop CLI launcher v1\nELECTRON_RUN_AS_NODE=1 exec 'C:/Apps/派活 工作台/captain-agents.exe' 'C:/Apps/派活 工作台/resources/platform/bin/xagents' \"$@\"\n");
  // 没指定位置时放进用户自己的 WindowsApps。
  assert.deepEqual(launcherFiles({ home: 'C:\\Users\\me', executable, platform, windows: true }, { LOCALAPPDATA: 'D:\\Local' }).map(f => f.path.replaceAll('/', '\\')),
    ['D:\\Local\\Microsoft\\WindowsApps\\xagents.cmd', 'D:\\Local\\Microsoft\\WindowsApps\\xagents']);
  assert.throws(() => launcherFiles({ home: 'h', executable: 'C:\\100%\\app.exe', platform, windows: true, binDir: bin }), /带 % 或引号的位置/);
  assert.deepEqual(launcherFiles({ home: 'h', executable, windows: true, binDir: bin }), [], '开发版不装');
});

test('Windows 的命令行安装：两个文件都对才算已安装；别人的不覆盖；装到一半接着装完；替换要明说', async t => {
  const c = await context(t, false), bin = join(c.temp, 'windows apps');
  const cli = createCliLauncher({ home: c.temp, executable: 'C:\\App\\captain-agents.exe', platform: 'C:\\App\\resources\\platform', windows: true, binDir: bin });
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
  assert.equal(await createCliLauncher({ home: c.temp, executable: 'C:\\Other\\captain-agents.exe', platform: 'C:\\App\\resources\\platform', windows: true, binDir: bin }).cliLauncherStatus(), 'other');
});

test('Windows 的命令行启动脚本真的能跑：参数和中文、空格原样交给应用里的平台', { skip: process.platform !== 'win32' ? '只在 Windows 上成立：要用命令提示符和 Git 的终端真的启动' : false }, async t => {
  // 放启动脚本的目录不带空格（真实位置 WindowsApps 也不带）：命令提示符对“带引号的程序路径再加带引号的参数”有自己的一套拆法，那是它的事，不是启动脚本的事。
  const c = await context(t, false), bin = join(c.temp, 'bin'), platform = join(c.temp, '平台 目录');
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

for (const windows of [false, true]) {
  const label = windows ? 'Windows' : 'macOS';
  const installation = (home: string, old: boolean) => ({
    home, windows, binDir: join(home, 'WindowsApps'),
    executable: windows
      ? `${old ? 'C:\\Old App' : 'D:\\New App'}\\captain-agents.exe`
      : join(home, old ? "旧 ' $(false) 应用.app" : '新 应用.app', 'Contents/MacOS/派活工作台'),
    platform: windows
      ? `${old ? 'C:\\Old App' : 'D:\\New App'}\\resources\\platform`
      : join(home, old ? "旧 ' $(false) 应用.app" : '新 应用.app', 'Contents/Resources/platform'),
  });

  test(`${label} 自动更新：完整旧脚本换成当前位置；单独换程序或平台位置也能认出`, async t => {
    for (const change of ['both', 'executable', 'platform'] as const) {
      await t.test(change, async t => {
        const c = await context(t, false), current = installation(c.temp, false), previous = installation(c.temp, true);
        if (change === 'executable') previous.platform = current.platform;
        if (change === 'platform') previous.executable = current.executable;
        await createCliLauncher(previous).installCliLauncher();
        const cli = createCliLauncher(current);
        assert.equal(await cli.cliLauncherStatus(), 'other', '内部过时状态不传给窗口');
        assert.deepEqual((await Promise.all([cli.refreshCliLauncher(), cli.refreshCliLauncher()])).sort(), [false, true], '锁内复查，只更新一次');
        assert.equal(await cli.cliLauncherStatus(), 'installed');
        for (const file of launcherFiles(current)) assert.equal(await readFile(file.path, 'utf8'), file.content);
        assert.equal(await cli.refreshCliLauncher(), false, '没有过时脚本不重写');
        assert.equal((await readdir(dirname(launcherFiles(current)[0].path))).some(name => name.endsWith('.tmp')), false);
      });
    }
  });

  test(`${label} 启动时：还没装的自动装上；装了一半的补齐；开发版什么都不做`, async t => {
    const c = await context(t, false), home = join(c.temp, 'fresh'), options = installation(home, false);
    const cli = createCliLauncher(options), list = launcherFiles(options);
    assert.equal(await cli.cliLauncherStatus(), 'missing');
    assert.equal(await cli.refreshCliLauncher(), true, '没装过：自动装上（文件夹不在就建）');
    assert.equal(await cli.cliLauncherStatus(), 'installed');
    for (const file of list) assert.equal(await readFile(file.path, 'utf8'), file.content);
    assert.equal(await cli.refreshCliLauncher(), false, '已经装好：不再动');
    if (list.length > 1) {
      await rm(list.at(-1)!.path);
      assert.equal(await cli.refreshCliLauncher(), true, '少了一个文件：补齐');
      assert.equal(await cli.cliLauncherStatus(), 'installed');
    }
    // 开发版（没有应用自带的平台）不装，也不建文件夹。
    const dev = join(c.temp, 'dev');
    assert.equal(await createCliLauncher({ home: dev, executable: options.executable }).refreshCliLauncher(), false);
    await assert.rejects(stat(dev), { code: 'ENOENT' });
  });

  test(`${label} 自动更新：别人的、增删或修改一行、目录、链接均原样保留`, async t => {
    for (const kind of ['foreign', 'edited', 'extra', 'missing-line', 'directory', 'link', 'dangling-link', 'wrong-entry'] as const) {
      await t.test(kind, async t => {
        // Windows 的普通文件软链接需要开发者模式或管理员；用目录联接也能验证 lstat 不跟随链接。
        if (process.platform === 'win32' && kind === 'dangling-link') {
          t.skip('Windows 普通文件软链接需要开发者模式或管理员；另测不需提权的目录联接'); return;
        }
        const c = await context(t, false), options = installation(c.temp, false), previous = installation(c.temp, true);
        await createCliLauncher(previous).installCliLauncher();
        const list = launcherFiles(previous), target = list[0].path;
        let unchanged = list[0].content;
        if (kind === 'foreign') unchanged = '别人的命令行\n';
        if (kind === 'edited') unchanged = unchanged.replace('launcher v1', 'launcher v2');
        if (kind === 'extra') unchanged += '\n';
        if (kind === 'missing-line') unchanged = unchanged.replace(/^.*\r?\n/, '');
        if (kind === 'wrong-entry') unchanged = unchanged.replace(/bin([/\\])xagents/, 'bin$1other');
        const external = join(c.temp, 'external');
        if (kind === 'directory') {
          await rm(target); await mkdir(target);
        } else if (kind === 'link' || kind === 'dangling-link') {
          await rm(target);
          if (process.platform === 'win32') {
            await mkdir(external); await symlink(external, target, 'junction');
          } else {
            if (kind === 'link') await writeFile(external, unchanged, { mode: 0o755 });
            await symlink(external, target);
          }
        } else await writeFile(target, unchanged);
        const cli = createCliLauncher(options);
        assert.equal(await cli.cliLauncherStatus(), 'other');
        assert.equal(await cli.refreshCliLauncher(), false);
        if (kind === 'directory') assert.ok((await stat(target)).isDirectory());
        else if (kind === 'link' || kind === 'dangling-link') {
          assert.ok((await lstat(target)).isSymbolicLink());
          if (process.platform !== 'win32' && kind === 'link') assert.equal(await readFile(external, 'utf8'), unchanged);
        } else assert.equal(await readFile(target, 'utf8'), unchanged);
        for (const file of list.slice(1)) assert.equal(await readFile(file.path, 'utf8'), file.content, '一个是别人的，另一个旧脚本也不动');
      });
    }
  });
}

test('Windows 自动更新：两个旧脚本中任何一个被改过，都不覆盖另一个', async t => {
  const c = await context(t, false), options = { home: c.temp, binDir: join(c.temp, 'bin'), windows: true,
    executable: 'C:\\Old\\captain-agents.exe', platform: 'C:\\Old\\resources\\platform' };
  const previous = createCliLauncher(options), list = launcherFiles(options);
  const current = createCliLauncher({ ...options, executable: 'D:\\New\\captain-agents.exe', platform: 'D:\\New\\resources\\platform' });
  for (const file of list) {
    await previous.installCliLauncher({ replace: true });
    await writeFile(file.path, file.content.replace('launcher v1', 'launcher v2'));
    const before = await Promise.all(list.map(file => readFile(file.path, 'utf8')));
    assert.equal(await current.refreshCliLauncher(), false);
    assert.deepEqual(await Promise.all(list.map(file => readFile(file.path, 'utf8'))), before);
  }
  await previous.installCliLauncher({ replace: true });
  await rm(list[1].path);
  assert.equal(await current.refreshCliLauncher(), true, '一个过时、一个缺失，补齐当前脚本');
  assert.equal(await current.cliLauncherStatus(), 'installed');
});
