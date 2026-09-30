import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, expectedProbes, permissionOutcome, networkOutcome, probeSource, readSelfcheck, ensureSelfcheck, globalTargets, tempTargets, globalBefore, cleanGlobal } from '../src/core/selfcheck.ts';
import type { Isolation, IsolationResult } from '../src/core/selfcheck.ts';
import { desktopView, context } from './helpers.ts';
import { whos, isolationOf } from '../src/core/roster.ts';

const mustAllow = (name: string) => name === 'worktree' || name === 'tmpdir';
const passing = (): IsolationResult[] => (['codex', 'grok', 'cursor'] as Isolation[]).map(isolation => ({ isolation, probes: expectedProbes(isolation).map(name => ({ name, outcome: mustAllow(name) ? 'allowed' : 'denied', reason: mustAllow(name) ? '操作成功' : 'EPERM' })) }));
test('选手清单里每位选手用的隔离都在自检范围内，缺哪一种自检都不过', () => {
  for (const who of whos) {
    assert.equal(evaluate(passing()).ok, true);
    assert.equal(evaluate(passing().filter(r => r.isolation !== isolationOf(who))).ok, false, who);
  }
  assert.equal(isolationOf('cursor-sonnet'), 'cursor');
});
test('自检只承认明确权限拒绝；连接失败、超时、文件不存在都不能冒充隔离', () => {
  const base = ['worktree', 'tmpdir', 'hardlink', 'home', 'chrome', 'listener', 'internet', 'ssh', 'npmrc'];
  // Codex 的登录由隔离外的主进程读取：三家都要读不到。Grok、Cursor 整个跑在隔离里：只查别家的。
  // 各家全局配置（钩子、技能、规矩、插件、程序、登录）三种隔离都要写不进去。
  // 公用临时位置（负责人会话的临时目录、/tmp、srt 的 /tmp/claude、系统给本用户的临时和缓存目录、npm 日志）也要写不进去。
  const global = globalTargets.map(t => t.name), shared = tempTargets.map(t => t.name);
  assert.deepEqual(shared, ['tmp-lead', 'tmp-shared', 'tmp-srt', 'tmp-user', 'tmp-cache', 'npm-logs']);
  for (const name of ['cursor-hooks', 'cursor-skills', 'cursor-rules', 'cursor-mcp', 'cursor-config', 'cursor-trust', 'cursor-install', 'grok-skills', 'grok-agents', 'grok-rules', 'grok-hooks', 'grok-admin', 'grok-memory', 'grok-plugins', 'grok-sessions', 'grok-login', 'claude-config', 'agents-skills']) assert.ok(global.includes(name), name);
  assert.deepEqual(expectedProbes('codex'), [...base, 'login-codex', 'login-grok', 'login-cursor', ...global, ...shared]);
  assert.deepEqual(expectedProbes('grok'), [...base, 'login-codex', 'login-cursor', ...global, ...shared]);
  assert.deepEqual(expectedProbes('cursor'), [...base, 'login-codex', 'login-grok', ...global, ...shared]);
  for (const code of ['EPERM', 'EACCES']) assert.equal(permissionOutcome(code), 'denied');
  for (const code of ['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', '']) assert.equal(permissionOutcome(code), 'unknown');
  assert.equal(evaluate(passing()).ok, true);
  for (const r of passing()) for (const p of r.probes) {
    const results = passing();
    results.find(x => x.isolation === r.isolation)!.probes.find(x => x.name === p.name)!.outcome = 'unknown';
    assert.equal(evaluate(results).ok, false, `${r.isolation}/${p.name}`);
  }
});
test('自检必须各项齐全，副本可写；所有敏感文件读取都不能例外放行', () => {
  const r = passing(); r[0].probes.find(p => p.name === 'login-grok')!.outcome = 'allowed';
  assert.equal(evaluate(r).ok, false); assert.doesNotMatch(evaluate(r).note, /已知例外/);
  for (const [mode, name] of [['cursor', 'cursor-hooks'], ['grok', 'grok-skills'], ['grok', 'grok-agents'], ['codex', 'claude-config'], ['grok', 'login-cursor'], ['cursor', 'login-grok'], ['codex', 'login-codex'], ['codex', 'login-grok'], ['codex', 'npmrc'], ['grok', 'npmrc'], ['cursor', 'npmrc'], ['codex', 'ssh'], ['codex', 'chrome'], ['grok', 'login-codex'], ['cursor', 'home'], ['codex', 'worktree'], ['grok', 'tmpdir'], ['cursor', 'tmp-lead'], ['grok', 'tmp-shared'], ['codex', 'tmp-user'], ['cursor', 'npm-logs']]) {
    const r = passing(), p = r.find(x => x.isolation === mode)!.probes.find(p => p.name === name)!;
    p.outcome = mustAllow(name) ? 'denied' : 'allowed'; assert.equal(evaluate(r).ok, false);
  }
  const missing = passing(); missing[1].probes.pop(); assert.equal(evaluate(missing).ok, false);
  const duplicate = passing(); duplicate[0].probes.push(duplicate[0].probes[0]); assert.equal(evaluate(duplicate).ok, false);
  assert.equal(evaluate(passing().slice(1)).ok, false); assert.equal(evaluate([...passing(), passing()[0]]).ok, false);
  const broken = passing(); broken[2].error = '程序不存在'; assert.equal(evaluate(broken).ok, false);
});
test('缓存一天有效，过期重检；失败和损坏拦截，不能仅凭 ok:true 放行', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'xagents-selfcheck-test-')), old = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = temp;
  t.after(async () => { if (old === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = old; await rm(temp, { recursive: true, force: true }); });
  await mkdir(join(temp, 'cache'));
  const file = join(temp, 'cache/selfcheck.json');
  let calls = 0;
  const checker = async () => { calls++; return evaluate(passing()); };
  assert.equal((await readSelfcheck()).ok, null); await ensureSelfcheck(checker); assert.equal(calls, 1);
  const now = Date.now(); await writeFile(file, JSON.stringify(evaluate(passing(), new Date(now).toISOString())));
  assert.equal((await readSelfcheck(now + 86399999)).ok, true);
  assert.equal((await readSelfcheck(now + 86400000)).ok, null);
  assert.equal((await readSelfcheck(now - 1)).ok, null);
  await ensureSelfcheck(checker); assert.equal(calls, 1);
  await writeFile(file, JSON.stringify(evaluate(passing(), new Date(now - 86400000).toISOString()))); await ensureSelfcheck(checker); assert.equal(calls, 2);
  await writeFile(file, JSON.stringify({ version: 3, ok: true, at: new Date().toISOString(), results: [] }));
  await assert.rejects(ensureSelfcheck(checker), /自检没过/); assert.equal(calls, 2);
  // 旧版本的缓存（探针做法改之前）即使名字齐全、写着通过，也要重新自检。
  await writeFile(file, JSON.stringify({ ...evaluate(passing()), version: 2 }));
  assert.equal((await readSelfcheck()).ok, null); await ensureSelfcheck(checker); assert.equal(calls, 3);
  await writeFile(file, '{'); await assert.rejects(ensureSelfcheck(checker), /缓存损坏/);
});
test('隔离内的 CLI 自检不启动真实探针，保存失败且桌面视图不显示通过', async t => {
  const c = await context(t, false);
  const r = await c.cli(['selfcheck']); assert.equal(r.code, 1); assert.match(r.stdout, /需要负责人在外面跑/);
  const cache = JSON.parse(await readFile(join(c.home, 'cache/selfcheck.json'), 'utf8'));
  assert.equal(cache.ok, false); assert.equal(cache.results.length, 3); assert.ok(cache.results.every((r: any) => r.probes.length === 0));
  assert.equal((await desktopView(c.home)).selfcheck.ok, false);
});
test('真实派发入口被失败自检挡住，尚未登记任务和副本', async t => {
  const c = await context(t); await c.add();
  await writeFile(join(c.home, 'cache/selfcheck.json'), JSON.stringify(evaluate([])));
  // 只关选手替身来走真实派发入口；额度查询照样用替身，不许真的启动 Cursor、Grok 去查（2026-09-30 发现每跑一次就在 ~/.cursor/projects 留一个目录）。
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], { XAGENTS_FAKE_WORKER: undefined, XAGENTS_QUERY_EXEC: join(import.meta.dirname, 'fixtures/quota/query.ts'), XAGENTS_CODEX_SESSIONS: join(import.meta.dirname, 'fixtures/quota') });
  assert.equal(r.code, 1); assert.match(r.stderr, /隔离自检没过/); assert.equal((await c.jobs()).length, 0);
});

test('网络必须直连和代理都拒绝；生成探针无需运行也能做语法检查', async t => {
  assert.equal(networkOutcome(['denied', 'denied']), 'denied');
  assert.equal(networkOutcome(['denied', 'allowed']), 'allowed');
  assert.equal(networkOutcome(['unknown', 'denied']), 'unknown');
  assert.equal(networkOutcome([]), 'unknown');
  const c = await context(t, false);
  const path = join(c.temp, 'probe.mjs');
  const temp = { 'tmp-lead': '/t/a', 'tmp-shared': '/t', 'tmp-srt': '/t/b', 'tmp-user': null, 'tmp-cache': '/c', 'npm-logs': '/n' };
  await writeFile(path, probeSource('grok', c.repo, join(c.temp, 'outside'), 1234, 'MARKER', 'TOKEN', temp, join(c.temp, 'tmp'), join(c.temp, 'target')));
  const { exec } = await import('./helpers.ts');
  const r = await exec(process.execPath, ['--check', path], c.temp, c.env); assert.equal(r.code, 0, r.stderr);
});

test('旧自检缓存缺 npmrc 或该查的登录探针，即使 ok 为 true 也不能派活', async t => {
  const c = await context(t, false);
  const oldHome = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (oldHome === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = oldHome; });
  await mkdir(join(c.home, 'cache'));
  // Codex 要查自己的登录文件；Grok、Cursor 只查别家的（自己的必须能读，否则启动不了）。
  for (const [isolation, login] of [['codex', 'login-codex'], ['grok', 'login-cursor'], ['cursor', 'login-grok']] as [Isolation, string][]) for (const name of ['npmrc', login]) {
    const results = passing(), result = results.find(r => r.isolation === isolation)!;
    result.probes = result.probes.filter(p => p.name !== name);
    await writeFile(join(c.home, 'cache/selfcheck.json'), JSON.stringify({ version: 3, ok: true, at: new Date().toISOString(), results }));
    await assert.rejects(ensureSelfcheck(), /缺少有效结果/);
  }
});

test('Codex 自检真实调用共用权限表，空 CODEX_HOME 仅给子进程，成功/失败/抛错都清理', async t => {
  const { codexProbe } = await import('../src/core/selfcheck.ts');
  const { codexPermissions } = await import('../src/core/sandbox.ts');
  const { readdir, access } = await import('node:fs/promises');
  const c = await context(t, false), inherited = process.env.CODEX_HOME;
  const project = { denyReadExtra: ['秘密 "目录'] };
  for (const mode of ['workspace-write', 'read-only'] as const) for (const behavior of ['ok', 'failed', 'throw']) {
    const job = { mode, repo: c.temp, worktree: c.repo };
    let temporaryHome = '';
    const result = { exit: behavior === 'ok' ? 0 : 1, output: '', timedOut: behavior === 'failed' };
    const tmp = join(c.temp, 'job-tmp');
    const call = codexProbe(job, project, '/temporary/probe.mjs', tmp, async (file, args, cwd, timeout, onData, env) => {
      assert.equal(file, process.env.XAGENTS_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
      assert.deepEqual(args, ['sandbox', '-P', 'xa', '-C', job.worktree, '-c', codexPermissions({ ...job, id: '' }, project, tmp), '--', process.execPath, '/temporary/probe.mjs']);
      // 与派活时一样：TMPDIR 指向任务的 tmp，权限表把它写明可写、/tmp 只读。
      assert.equal(env!.TMPDIR, tmp); assert.ok(args[6].includes(`":slash_tmp"="read"`)); assert.ok(args[6].includes(`":tmpdir"="read"`)); assert.ok(args[6].includes(`${JSON.stringify(tmp)}="write"`));
      assert.equal(cwd, job.worktree); assert.equal(timeout, 20000); assert.equal(onData, undefined);
      temporaryHome = env!.CODEX_HOME!; assert.ok(temporaryHome); assert.notEqual(temporaryHome, inherited);
      assert.deepEqual(await readdir(temporaryHome), []);
      await writeFile(join(temporaryHome, 'temporary-config'), 'test');
      assert.equal(process.env.CODEX_HOME, inherited);
      if (behavior === 'throw') throw new Error('模拟启动失败');
      return result;
    });
    if (behavior === 'throw') await assert.rejects(call, /模拟启动失败/);
    else assert.deepEqual(await call, result);
    await assert.rejects(access(temporaryHome), { code: 'ENOENT' });
    assert.equal(process.env.CODEX_HOME, inherited);
  }
});

test('执行器传入子进程环境而不修改父进程，原有环境仍可继承', async t => {
  const { execute } = await import('../src/core/verify.ts');
  const c = await context(t, false);
  const old = { XA_TEST_PARENT: process.env.XA_TEST_PARENT, XA_TEST_CHILD: process.env.XA_TEST_CHILD };
  process.env.XA_TEST_PARENT = 'parent'; process.env.XA_TEST_CHILD = 'before';
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const result = await execute(process.execPath, ['-e', 'console.log(process.env.XA_TEST_PARENT + ":" + process.env.XA_TEST_CHILD)'], c.temp, 5000, undefined, { XA_TEST_CHILD: 'after' });
  assert.equal(result.exit, 0); assert.equal(result.output.trim(), 'parent:after');
  assert.equal(process.env.XA_TEST_CHILD, 'before');
});

test('外面的清理只删能证明是探针建的：随机名文件照删，固定位置要探针报告过且文件编号对得上', async t => {
  const c = await context(t, false);
  const { lstat, stat } = await import('node:fs/promises');
  const home = join(c.temp, 'home');
  await mkdir(join(home, '.cursor/skills'), { recursive: true }); await mkdir(join(home, '.grok'), { recursive: true });
  await writeFile(join(home, '.cursor/cli-config.json'), '{"keep":true}');
  const before = await globalBefore(home);
  assert.equal(before.get(join(home, '.cursor/cli-config.json')), true);
  assert.equal(before.get(join(home, '.cursor/hooks.json')), false);
  // 探针建出又没删掉的：钩子文件（报告过、编号对）、规矩目录（报告过、编号对）、随机名文件；
  // 另有一个“主人同时建的” mcp.json（没报告）和一个编号对不上的 AGENTS.md，都不能删。
  await writeFile(join(home, '.cursor/hooks.json'), ''); await mkdir(join(home, '.cursor/rules'));
  await writeFile(join(home, '.cursor/skills/TOKEN'), '');
  await writeFile(join(home, '.cursor/mcp.json'), ''); await writeFile(join(home, '.grok/AGENTS.md'), '');
  const ino = async (p: string) => (await stat(p)).ino;
  const probes = [
    { created: [{ path: join(home, '.cursor/hooks.json'), dir: false, ino: await ino(join(home, '.cursor/hooks.json')) }] },
    { created: [{ path: join(home, '.cursor/rules'), dir: true, ino: await ino(join(home, '.cursor/rules')) }] },
    { created: [{ path: join(home, '.grok/AGENTS.md'), dir: false, ino: 1 }] },
  ];
  const problems = await cleanGlobal('TOKEN', before, probes, home);
  const exists = (p: string) => lstat(join(home, p)).then(() => true, () => false);
  for (const gone of ['.cursor/hooks.json', '.cursor/rules', '.cursor/skills/TOKEN']) assert.equal(await exists(gone), false, gone);
  for (const kept of ['.cursor/mcp.json', '.grok/AGENTS.md', '.cursor/cli-config.json', '.cursor/skills']) assert.equal(await exists(kept), true, kept);
  assert.equal(problems.length, 2);
  assert.ok(problems.every(p => /不能确认是探针建的，没有删/.test(p)));
  // 编号对得上但后来被写进了内容：不删，报错。
  await writeFile(join(home, '.cursor/hooks.json'), '');
  const written = { created: [{ path: join(home, '.cursor/hooks.json'), dir: false, ino: await ino(join(home, '.cursor/hooks.json')) }] };
  await writeFile(join(home, '.cursor/hooks.json'), '{"hooks":{}}');
  const kept = await cleanGlobal('TOKEN', before, [written], home);
  assert.equal(await exists('.cursor/hooks.json'), true); assert.ok(kept.some(p => /被写进了内容，没有删/.test(p)));
  await rm(join(home, '.cursor/hooks.json'));
  // 探针没结果（例如被杀掉）时，新出现的固定位置一律不删，只报错。
  await writeFile(join(home, '.cursor/hooks.json'), '');
  const orphan = await cleanGlobal('TOKEN', before, null, home);
  assert.equal(await exists('.cursor/hooks.json'), true); assert.ok(orphan.some(p => p.includes('hooks.json')));
});

test('公用临时目录：自检期间新出现的固定名目录即使探针报告过也不删，只报错；随机名文件照删', async t => {
  const c = await context(t, false);
  const { lstat, stat } = await import('node:fs/promises');
  const home = join(c.temp, 'home'), shared = join(c.temp, 'shared');
  await mkdir(home); await mkdir(shared);
  const temp = { 'tmp-shared': shared, 'tmp-lead': join(shared, 'claude-501') };
  const before = await globalBefore(home, temp);
  assert.equal(before.get(shared), true); assert.equal(before.get(join(shared, 'claude-501')), false);
  await mkdir(join(shared, 'claude-501')); await writeFile(join(shared, 'TOKEN'), '');
  const probes = [{ created: [{ path: join(shared, 'claude-501'), dir: true, ino: (await stat(join(shared, 'claude-501'))).ino }] }];
  const problems = await cleanGlobal('TOKEN', before, probes, home, temp);
  assert.ok(await lstat(join(shared, 'claude-501')).then(() => true));
  await assert.rejects(lstat(join(shared, 'TOKEN')));
  assert.deepEqual(problems, [`自检期间出现了 ${join(shared, 'claude-501')}（公用临时目录），不自动删，请负责人查看`]);
});
test('公用临时位置：getconf 查系统目录，查不到算空；没有 ~/.npm 时改查家目录本身', async t => {
  const c = await context(t, false);
  const { tempPaths } = await import('../src/core/selfcheck.ts');
  const home = join(c.temp, 'home'); await mkdir(home);
  const run = async (file: string, args: string[]) => ({ exit: args[0] === 'DARWIN_USER_TEMP_DIR' ? 0 : 1, output: args[0] === 'DARWIN_USER_TEMP_DIR' ? c.temp + '/\n' : '', timedOut: false });
  const paths = await tempPaths(run as any, c.temp, home);
  assert.equal(paths['tmp-shared'], '/private/tmp'); assert.equal(paths['tmp-srt'], '/private/tmp/claude');
  assert.equal(paths['tmp-lead'], `/private/tmp/claude-${process.getuid!()}`);
  assert.equal(paths['tmp-user'], await (await import('node:fs/promises')).realpath(c.temp)); assert.equal(paths['tmp-cache'], null);
  assert.equal(paths['npm-logs'], home);
  await mkdir(join(home, '.npm'));
  assert.equal((await tempPaths(run as any, c.temp, home))['npm-logs'], join(home, '.npm/_logs'));
});
