import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { evaluate, expectedProbes, platformIsolations, platformRefusal, ensurePlatform, ensureSelfcheck, readSelfcheck, windowsHardened } from '../src/core/selfcheck.ts';
import { context } from './helpers.ts';
import type { IsolationResult, Probe } from '../src/core/selfcheck.ts';
import { windowsExpectedProbes, windowsGlobalTargets, windowsLabels, windowsProbeScript, windowsTempPaths, windowsTempTargets, resolveWriteProbe, sweepCredentials, windowsSetup, codexHomes, probeHome } from '../src/core/selfcheck-windows.ts';
import { codexPermissions, keychainDirs, homeDeny, SHELL_FILES, CREDENTIAL_FILES, WINDOWS_SHELL_FILES, WINDOWS_CREDENTIAL_FILES } from '../src/core/sandbox.ts';
import { globalTargets } from '../src/core/selfcheck.ts';
import { isWindows } from '../src/core/platform.ts';
import type { Executor } from '../src/core/verify.ts';

const passing = (): IsolationResult[] => [{ isolation: 'codex', probes: windowsExpectedProbes().map(name => ({ name, outcome: ['worktree', 'tmpdir'].includes(name) ? 'allowed' : 'denied', reason: '' } as Probe)) }];

test('Windows 上只开放 Codex 这一路的隔离；别的选手派活时直接拒绝，写明原因', () => {
  assert.deepEqual(platformIsolations(true), ['codex']);
  assert.deepEqual(platformIsolations(false).sort(), ['codex', 'cursor', 'grok']);
  assert.equal(platformRefusal('codex', true), null);
  for (const isolation of ['grok', 'cursor'] as const) {
    assert.match(platformRefusal(isolation, true)!, /还没有在 Windows 上实测过，Windows 上暂时不能派/);
    assert.equal(platformRefusal(isolation, false), null);
    assert.throws(() => ensurePlatform(['codex', isolation], true), /这件没有派出/);
  }
  ensurePlatform(['codex', 'codex'], true); ensurePlatform(['codex', 'grok', 'cursor'], false);
});

test('Windows 的探针清单：macOS 上每一类都有对应，另加身份、开监听口、命名管道、开机启动和 PowerShell 配置', () => {
  const names = windowsExpectedProbes();
  assert.equal(new Set(names).size, names.length, '不能有重名');
  for (const name of ['worktree', 'tmpdir', 'hardlink', 'home', 'chrome', 'listener', 'internet', 'ssh', 'npmrc', 'shell-files', 'credential-files', 'env-secret',
    'login-codex', 'login-grok', 'login-cursor', 'login-deepseek', 'keychain', 'keychain-user', 'keychain-system', ...globalTargets.map(t => t.name)]) assert.ok(names.includes(name), name);
  for (const name of ['account', 'listen', 'pipe', 'startup-folder', 'powershell-profile', 'powershell-profile-5', 'codex-install', ...windowsTempTargets.map(t => t.name)]) assert.ok(names.includes(name), name);
  assert.deepEqual(expectedProbes('codex', true), names);
  const labels = windowsLabels();
  for (const name of names) if (!['worktree', 'tmpdir', 'hardlink', 'home', 'chrome', 'listener', 'internet', 'ssh', 'npmrc', 'shell-files', 'credential-files', 'env-secret', 'login-codex', 'login-grok', 'login-cursor', 'login-deepseek'].includes(name)) assert.ok(labels[name], `${name} 要有给人看的名字`);
  assert.ok(windowsGlobalTargets().every(t => !/^([a-z]:|[\\/])/i.test(t.path)), '都是相对家目录的位置');
});

test('Windows 的判定：只看 Codex；两项必须通、其余必须挡；拿不准、缺项、出错都算不过', () => {
  const ok = evaluate(passing(), '2026-10-12T00:00:00.000Z', true);
  assert.equal(ok.ok, true); assert.equal(ok.platform, 'win32'); assert.match(ok.note, /隔离里用的是专用账户/);
  // macOS 的判定不认这份结果（那里三种隔离都要有）。
  assert.equal(evaluate(passing(), undefined, false).ok, false);
  for (const [name, outcome, words] of [['account', 'allowed', /以主人的账户运行.*未达到要求/], ['listener', 'allowed', /本机监听端口 未达到要求/], ['listen', 'allowed', /在本机开监听端口 未达到要求/],
    ['pipe', 'unknown', /命名管道 拿不准/], ['startup-folder', 'allowed', /写开机启动文件夹 未达到要求/], ['worktree', 'denied', /副本内写文件 未达到要求/], ['keychain', 'allowed', /读凭据库里的条目 未达到要求/]] as const) {
    const results = passing(); results[0].probes.find(p => p.name === name)!.outcome = outcome;
    const r = evaluate(results, undefined, true);
    assert.equal(r.ok, false, name); assert.match(r.note, words);
  }
  const missing = passing(); missing[0].probes = missing[0].probes.filter(p => p.name !== 'tmp-root');
  assert.match(evaluate(missing, undefined, true).note, /写盘符根目录 缺少有效结果/);
  assert.match(evaluate([{ isolation: 'codex', probes: [], error: '还没装好' }], undefined, true).note, /codex 未能自检：还没装好/);
  assert.match(evaluate([], undefined, true).note, /codex 未能自检（结果缺失或重复）/);
});

test('Windows 的探针脚本：能被 Node 解析，查的是给定的位置，不含新建固定名字的操作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xa-winprobe-'));
  try {
    const spec = { worktree: 'C:\\w t\\repo', tmp: 'C:\\w t\\tmp', home: "C:\\Users\\o'brien 张", homeFile: 'C:\\Users\\me\\.x', linkTarget: 'C:\\w t\\link', marker: 'MARK:', token: '.tok',
      port: 4321, pipe: '\\\\.\\pipe\\xa-test', owner: 'Me', credential: 'xagents-selfcheck-1', fakes: ['XA_FAKE_KEY'], writes: [{ name: 'startup-folder', path: 'C:\\Users\\me\\Startup', dir: true }, { name: 'cursor-hooks', path: 'C:\\Users\\me\\.cursor\\hooks.json', dir: false }] };
    const source = windowsProbeScript(spec);
    assert.ok(source.startsWith('\uFEFF'), '带 BOM：系统自带的 PowerShell 才会按 UTF-8 读，中文不坏');
    // 说明放在一段原样字符串里：一行 JSON，路径里的引号、空格、中文都原样在里面；小写的账户名、去掉前缀的管道名。
    const json = /^\$spec = @'\n(.*)\n'@ \| ConvertFrom-Json$/m.exec(source)![1], data = JSON.parse(json);
    assert.equal(data.home, spec.home); assert.equal(data.owner, 'me'); assert.equal(data.pipe, 'xa-test'); assert.equal(data.port, 4321);
    assert.deepEqual(data.writes, spec.writes); assert.deepEqual(data.fakes, ['XA_FAKE_KEY']); assert.equal(data.credential, 'xagents-selfcheck-1');
    for (const name of [...SHELL_FILES, ...WINDOWS_SHELL_FILES]) assert.ok(data.shellFiles.includes(name), name);
    for (const name of [...CREDENTIAL_FILES, ...WINDOWS_CREDENTIAL_FILES]) assert.ok(data.credentialFiles.includes(name), name);
    for (const piece of ['whoami.exe', 'cmdkey.exe', "'TEMP', 'TMP'", "Test 'worktree'", "Test 'internet'", "Unread 'keychain-system'", '$spec.marker']) assert.ok(source.includes(piece), piece);
    assert.doesNotMatch(source, /New-Item -ItemType Directory|mkdir|Remove-Item|rmdir/i, '探针不建、不删文件夹');
    assert.doesNotMatch(source, /node|ELECTRON/i, '探针不依赖 Node，也不依赖应用自己的程序');
    assert.doesNotMatch(source, /\.ToLower\(\)|\.ToUpper\(\)/, '大小写按与地区无关的规则折叠');
    assert.equal(json.includes('\n'), false, '说明必须是一行');
    assert.match(windowsProbeScript({ ...spec, credential: null }), /"credential":null/);
    // 在真的 Windows 上让系统自带的 PowerShell 解析一遍：语法错了当场报出来。
    if (isWindows) {
      const file = join(dir, 'probe.ps1'); await writeFile(file, source);
      const { spawnSync } = await import('node:child_process');
      const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('试写的位置：目标在就试目标；不在就试最近的现有上级文件夹，不去新建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xa-writeprobe-'));
  try {
    await mkdir(join(dir, 'a', 'b'), { recursive: true }); await writeFile(join(dir, 'a', 'file.json'), '{}');
    assert.deepEqual(await resolveWriteProbe('x', join(dir, 'a', 'b'), true), { name: 'x', path: join(dir, 'a', 'b'), dir: true });
    assert.deepEqual(await resolveWriteProbe('x', join(dir, 'a', 'file.json'), false), { name: 'x', path: join(dir, 'a', 'file.json'), dir: false });
    assert.deepEqual(await resolveWriteProbe('x', join(dir, 'a', 'b', 'missing', 'deeper'), true), { name: 'x', path: join(dir, 'a', 'b'), dir: true });
    assert.deepEqual(await resolveWriteProbe('x', join(dir, 'a', 'missing.json'), false), { name: 'x', path: join(dir, 'a'), dir: true });
    // 该是文件夹的地方是个文件：照文件的办法试（只写方式打开），不当文件夹用。
    assert.deepEqual(await resolveWriteProbe('x', join(dir, 'a', 'file.json'), true), { name: 'x', path: join(dir, 'a', 'file.json'), dir: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows 的公用可写位置和存凭据的系统文件夹：按环境变量取，取不到用缺省位置', () => {
  const home = join('C:', 'Users', 'me');
  const temp = windowsTempPaths(home, { LOCALAPPDATA: 'L', SystemRoot: 'S', PUBLIC: 'P', ProgramData: 'D' }, 'T', 'A', 'B');
  assert.deepEqual(Object.keys(temp), windowsTempTargets.map(t => t.name));
  assert.deepEqual(temp, { 'tmp-user': 'T', 'tmp-shared': join('S', 'Temp'), 'tmp-public': 'P', 'tmp-programdata': 'D', 'tmp-root': temp['tmp-root'], 'npm-logs': join('L', 'npm-cache', '_logs'), 'own-install': 'A', 'own-program': 'B' });
  // 派活工作台自己的程序目录也在试写之列：装到隔离挡不住的位置时，自检要判不过。
  for (const name of ['own-install', 'own-program']) assert.ok(windowsExpectedProbes().includes(name), name);
  assert.deepEqual(keychainDirs(true, home, { APPDATA: 'R', LOCALAPPDATA: 'L' }), [join('R', 'Microsoft', 'Credentials'), join('L', 'Microsoft', 'Credentials'), join('R', 'Microsoft', 'Protect'), join('R', 'Microsoft', 'Vault'), join('L', 'Microsoft', 'Vault')]);
  assert.deepEqual(keychainDirs(true, home, {}).slice(0, 2), [join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials'), join(home, 'AppData', 'Local', 'Microsoft', 'Credentials')]);
  assert.deepEqual(keychainDirs(false, '/Users/me'), [join('/Users/me', 'Library/Keychains'), '/Library/Keychains']);
  assert.ok(homeDeny(true).includes('Documents/PowerShell') && homeDeny(true).includes('.netrc'));
  assert.ok(!homeDeny(false).includes('Documents/PowerShell'));
});

test('凭据库里的自检测试条目：只删自己前缀的，列不了或删不掉都报出来', async () => {
  const calls: string[][] = [];
  const list = 'Target: LegacyGeneric:target=xagents-selfcheck-11111111-2222-3333-4444-555555555555\r\nTarget: git:https://example.invalid\r\nTarget: LegacyGeneric:target=xagents-selfcheck-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n';
  const run = (async (file, args) => { calls.push([file, ...args]); return { exit: 0, output: args[0] === '/list' ? list : '' }; }) as Executor;
  assert.equal(await sweepCredentials(run), null);
  assert.deepEqual(calls, [['cmdkey.exe', '/list'], ['cmdkey.exe', '/delete:xagents-selfcheck-11111111-2222-3333-4444-555555555555'], ['cmdkey.exe', '/delete:xagents-selfcheck-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']]);
  assert.match((await sweepCredentials((async () => ({ exit: 1, output: '' })) as Executor))!, /未能列出凭据库/);
  assert.match((await sweepCredentials((async (_f, args) => ({ exit: args[0] === '/list' ? 0 : 5, output: list })) as Executor))!, /未能删除凭据库里的自检测试条目/);
});

test('一次装齐：先建好文件夹和结果文件，再以管理员身份调安装脚本；结果逐步翻成人话，装完作废旧的自检结果', async t => {
  const home = await mkdtemp(join(tmpdir(), 'xa-winsetup-'));
  const saved = { XAGENTS_HOME: process.env.XAGENTS_HOME, XAGENTS_CODEX: process.env.XAGENTS_CODEX, CODEX_HOME: process.env.CODEX_HOME, USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN };
  t.after(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(home, { recursive: true, force: true }); });
  const codex = join(home, 'codex.exe'); await writeFile(codex, '');
  Object.assign(process.env, { XAGENTS_HOME: join(home, 'registry'), XAGENTS_CODEX: codex, CODEX_HOME: join(home, 'owner codex'), USERNAME: "o'neil", USERDOMAIN: 'PC' });
  assert.deepEqual(codexHomes(), [join(home, 'owner codex'), join(home, 'registry', 'deepseek'), probeHome()]);
  await mkdir(join(home, 'registry', 'cache'), { recursive: true }); await writeFile(join(home, 'registry', 'cache', 'selfcheck.json'), '{}');
  let command = '';
  const answer = (result: unknown): Executor => async (_file, args) => {
    command = args.at(-1)!;
    const file = /'-Result','"([^"]+)"'/.exec(command)![1];
    for (const dir of codexHomes()) assert.ok((await import('node:fs')).existsSync(dir), `${dir} 要在提权前建好`);
    assert.equal(await readFile(file, 'utf8'), '', '结果文件要在提权前建好');
    if (result !== undefined) await writeFile(file, typeof result === 'string' ? result : JSON.stringify(result));
    return { exit: 0, output: '' };
  };
  const done = await windowsSetup(answer({ ok: true, steps: [{ name: 'codex-setup', target: 'C:\\x', ok: true, detail: 'ok' }, { name: 'fence-install', target: '', ok: true, detail: 'installed 6 filters' }] }));
  assert.deepEqual(done, { ok: true, lines: ['给 C:\\x 装 Codex 的隔离：好了', '装本机回环的拦截规则：好了'] });
  assert.match(command, /Start-Process -FilePath '.*powershell\.exe' -Verb RunAs -Wait -PassThru/);
  assert.ok(command.includes(`'-User','"PC\\o''neil"'`), '账户名里的单引号要转义');
  assert.ok(command.includes(`'-CodexHomes','"${codexHomes().join('|')}"'`));
  assert.ok(command.includes(`'-File','"${join(dirname(import.meta.dirname), 'sandbox', 'windows', 'setup.ps1')}"'`));
  await assert.rejects(readFile(join(home, 'registry', 'cache', 'selfcheck.json')), { code: 'ENOENT' });
  const failed = await windowsSetup(answer({ ok: false, steps: [{ name: 'codex-setup', target: 'D', ok: false, detail: 'home-missing' }, { name: 'setup', target: '', ok: false, detail: 'not-elevated' }] }));
  assert.deepEqual(failed, { ok: false, lines: ['给 D 装 Codex 的隔离：没成功（文件夹不存在）', '安装：没成功（没有拿到管理员权限）'] });
  const none = await windowsSetup(async () => ({ exit: 1, output: 'Start-Process : The operation was canceled by the user.' }));
  assert.deepEqual(none, { ok: false, lines: ['没有装：管理员确认被取消了。'] });
  const removed = await windowsSetup(answer({ ok: true, steps: [{ name: 'fence-remove', target: '', ok: true, detail: 'removed' }] }), true);
  assert.deepEqual(removed.lines, ['撤掉本机回环的拦截规则：好了']); assert.ok(command.includes("'-Remove'") && !command.includes('-CodexHomes'));
  process.env.XAGENTS_CODEX = join(home, 'missing.exe');
  await assert.rejects(windowsSetup(answer(undefined)), /找不到 Codex 程序/);
});

test('Windows 的权限表只写本机存在的路径；macOS 上不存在的也照写', { skip: !isWindows ? '只在 Windows 上成立：权限表按当前系统生成' : false }, () => {
  const job = { mode: 'workspace-write' as const, repo: join(homedir(), 'repo'), worktree: join(homedir(), 'repo', 'wt'), id: 'x' };
  const tmp = join(homedir(), 'xa-tmp');
  const none = codexPermissions(job, { denyReadExtra: ['.data'] }, tmp, false, () => false);
  assert.doesNotMatch(none, /="deny"/); assert.doesNotMatch(none, /slash_tmp/);
  assert.match(none, /":tmpdir"="read"/); assert.ok(none.includes(`${JSON.stringify(tmp)}="write"`));
  const all = codexPermissions(job, { denyReadExtra: ['.data'] }, tmp, false, () => true);
  for (const path of ['.ssh', '.npmrc', '.codex', 'Documents/PowerShell', '.netrc']) assert.ok(all.includes(`${JSON.stringify(join(homedir(), path))}="deny"`), path);
  for (const dir of keychainDirs()) assert.ok(all.includes(`${JSON.stringify(dir)}="deny"`), dir);
  assert.ok(all.includes(`${JSON.stringify(join(job.repo, '.data'))}="deny"`) && all.includes(`${JSON.stringify(join(job.worktree, '.data'))}="deny"`));
});

test('Windows 上自检不拦派活：没装、没过都照派，选手改用 Codex 自带的做法；通过了才算加固；通过过的过期了自动重检一次', { skip: isWindows ? false : '缓存按当前系统判定，这一条要在 Windows 上跑' }, async t => {
  const c = await context(t, false), old = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = old; });
  const file = join(c.home, 'cache/selfcheck.json'); await mkdir(dirname(file), { recursive: true });
  let calls = 0; const check = async () => { calls++; return evaluate(passing(), new Date().toISOString(), true); };
  const cache = (results: IsolationResult[], at = new Date().toISOString()) => writeFile(file, JSON.stringify({ version: 8, platform: 'win32', ok: true, at, results }));
  // 从没自检过：不拦，也不替主人去跑那一整套。
  await ensureSelfcheck(check, true); assert.equal(calls, 0); assert.equal(await windowsHardened(true), false);
  // 自检没过：照样不拦。
  const failing = passing(); failing[0].probes.find(p => p.name === 'internet')!.outcome = 'unknown';
  await cache(failing); await ensureSelfcheck(check, true); assert.equal(calls, 0); assert.equal(await windowsHardened(true), false);
  // 通过了：这件活用加固。
  await cache(passing()); assert.equal(await windowsHardened(true), true);
  // 没过的过期了不重检；通过过的过期了重检一次。
  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString();
  await cache(failing, yesterday); await ensureSelfcheck(check, true); assert.equal(calls, 0);
  await cache(passing(), yesterday); assert.equal((await readSelfcheck()).passed, true); await ensureSelfcheck(check, true); assert.equal(calls, 1);
});

test('不带禁读名单的权限表：只剩任务临时目录那两条，别的系统上的隔离不受影响', () => {
  const job = { mode: 'workspace-write' as const, repo: join(tmpdir(), 'r'), worktree: join(tmpdir(), 'w'), id: 'x' }, tmp = join(tmpdir(), 'job-tmp');
  const plain = codexPermissions(job, { denyReadExtra: ['secret'], denyReadHome: ['.mine'] }, tmp, false, () => true, true);
  assert.ok(!plain.includes('"deny"'), '没有禁读'); assert.ok(plain.includes(`${JSON.stringify(tmp)}="write"`)); assert.ok(plain.includes('":tmpdir"="read"'));
  assert.match(plain, /^permissions\.xa=\{extends=":workspace",filesystem=\{/);
  assert.ok(codexPermissions(job, { denyReadExtra: [] }, tmp, false, () => true).includes('"deny"'), '缺省照旧带禁读名单');
  assert.ok(codexPermissions(job, { denyReadExtra: [] }, tmp, true, () => true, true).endsWith(',network={enabled=true}}'));
});
