import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, utimes, readdir, symlink, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { desktopView, context, root, until } from './helpers.ts';
import { boardQuota, checkQuota, ensureQuota, executeQuery, parseCodexQuota, parseCursorQuota, parseGrokQuota, queryCodexQuota, queryQuota, quotaBar, quotaDelta, readQuotaCache } from '../src/core/quota.ts';
import { formatQuota } from '../src/cli/quota.ts';
import type { QueryCommand, QuotaSnapshot, QuotaSnapshots } from '../src/core/quota.ts';
import { ensureHome, toolRoot } from '../src/core/paths.ts';
import { localTime } from '../src/cli/format.ts';
import { alive } from '../src/core/fsx.ts';
import { whos, vendorOf } from '../src/core/roster.ts';
import { quotaStops } from '../src/core/settings.ts';

const fixtures = join(root, 'test/fixtures/quota');
const sample = (name: string) => readFile(join(fixtures, name), 'utf8');
const at = '2026-09-29T04:00:00.000Z';
async function snapshot(): Promise<QuotaSnapshot> {
  return { queriedAt: at, providers: [parseCodexQuota(await sample('codex.jsonl'), at), parseGrokQuota(await sample('grok.json'), at), parseCursorQuota(await sample('cursor.txt'), at)] };
}
async function local(t: Parameters<typeof context>[0]) {
  const c = await context(t, false);
  const old = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = old; });
  await ensureHome(); return c;
}

test('三家解析：Codex 周窗口、触顶；Grok 不到 1%；Cursor ANSI、分类换行和重置日期', async () => {
  const data = await snapshot(), codex = data.providers[0];
  assert.equal(codex.plan, 'pro'); assert.equal(codex.at, at);
  assert.equal(quotaBar(data, 'codex')?.used, 63.2);
  assert.equal(codex.bars[0].reset, '2026-09-29T12:00:00.000Z');
  const primaryWeek = JSON.parse(await sample('codex.jsonl'));
  primaryWeek.payload.rate_limits.primary.window_minutes = 10080;
  primaryWeek.payload.rate_limits.secondary = null;
  primaryWeek.payload.rate_limits.rate_limit_reached_type = 'primary';
  const reached = { ...data, providers: [parseCodexQuota(JSON.stringify(primaryWeek), at), ...data.providers.slice(1)] };
  assert.throws(() => checkQuota(reached, [{ who: 'codex' }]), /已触顶/);
  assert.doesNotThrow(() => checkQuota(reached, [{ who: 'codex' }], true));
  const low = parseGrokQuota(await sample('grok-under-one.json'), at);
  assert.equal(low.bars[0].used, 1); assert.equal(low.bars[0].approx, true);
  assert.match(formatQuota({ queriedAt: at, providers: [low] }), /不到 1%/);
  const zero = parseGrokQuota((await sample('grok.json')).replace('32.7', '0'), at);
  assert.equal(zero.bars[0].used, 0); assert.equal(zero.bars[0].approx, undefined);
  const cursor = data.providers[2];
  assert.equal(cursor.plan, 'Ultra'); assert.equal(cursor.onDemand, '$0.00 / $20.00');
  assert.equal(parseCursorQuota((await sample('cursor.txt')).replace('Ultra', 'Pro+'), at).plan, 'Pro+');
  assert.deepEqual(cursor.bars.map(b => b.used), [36.2, 12.3, 84.7]);
  assert.equal(new Date(cursor.bars[0].reset!).getMonth(), 9);
  const nextYear = parseCursorQuota((await sample('cursor.txt')).replace('Oct 15', 'Jan 2'), '2026-12-30T04:00:00Z');
  assert.equal(new Date(nextYear.bars[0].reset!).getFullYear(), 2027);
  assert.throws(() => parseCursorQuota('不认识的界面', at), /界面可能改了/);
  const changedScreen = (await sample('cursor.txt')).replace('Auto', 'Other');
  assert.throws(() => parseCursorQuota(changedScreen, at), /界面可能改了/);
});

test('会话按 mtime 看最新 20 份、取最后完整记录，不沿符号链接读取', async t => {
  const c = await local(t), dir = join(c.temp, 'sessions'); await mkdir(join(dir, 'nested'), { recursive: true });
  const raw = await sample('codex.jsonl');
  for (let i = 0; i < 21; i++) {
    const file = join(dir, 'nested', `${i}.jsonl`);
    await writeFile(file, i === 0 ? raw : '{"payload":{}}\n');
    await utimes(file, new Date(i * 1000), new Date(i * 1000));
  }
  const external = join(c.temp, 'outside.jsonl'); await writeFile(external, raw);
  await symlink(external, join(dir, 'link.jsonl'));
  await assert.rejects(queryCodexQuota(dir), /最近 20/);
  const latest = join(dir, 'nested', '20.jsonl');
  await writeFile(latest, raw + raw.replace('63.2', '71.9') + '{"rate_limits":\n');
  await utimes(latest, new Date(at), new Date(at));
  const value = await queryCodexQuota(dir);
  assert.equal(value.bars[1].used, 71.9); assert.equal(value.at, at);
});

test('三家互不影响，调用参数、协议、空目录与缓存正确；10 分钟内复用', async t => {
  const c = await local(t), commands: QueryCommand[] = [];
  const options = { sessionsDir: join(c.temp, 'missing'), now: new Date(at), execute: async (cmd: QueryCommand) => {
    commands.push(cmd);
    if (cmd.file === 'grok') {
      assert.equal(cmd.timeoutMs, 20000); assert.deepEqual(cmd.args, ['agent', '--no-leader', 'stdio']);
      assert.equal(Object.keys(cmd.env!).length, 10); assert.ok(Object.values(cmd.env!).every(v => v === 'false'));
      const msgs = cmd.input!.trim().split('\n').map(v => JSON.parse(v));
      assert.equal(msgs[0].method, 'initialize'); assert.deepEqual(msgs[0].params, { protocolVersion: 1, clientCapabilities: {} });
      assert.equal(msgs[1].method, '_x.ai/billing'); assert.equal(cmd.complete!('{"id":1}'), false);
      const raw = await sample('grok-under-one.json'); assert.equal(cmd.complete!(raw), true); return raw;
    }
    assert.equal(cmd.file, 'python3'); // 不能用 script：它要求标准输入是终端，被管道起动时直接退出。
    assert.deepEqual(cmd.args, [join(toolRoot, 'src/core/pty-bridge.py'), '60', '140', 'cursor-agent', '--trust', '--mode', 'ask']);
    assert.deepEqual(await readdir(cmd.cwd!), []);
    // cursor-agent 会按工作目录建项目目录（含信任标记）：配置和数据目录要搬进本次临时目录，查完一起删，不能留在 ~/.cursor/projects。
    const root = dirname(cmd.cwd!);
    assert.match(basename(root), /^cursor-usage-/); assert.equal(dirname(root), join(c.home, 'cache'));
    assert.deepEqual(cmd.env, { TERM: 'xterm-256color', CURSOR_CONFIG_DIR: join(root, 'state/config'), CURSOR_DATA_DIR: join(root, 'state/data') });
    assert.deepEqual(cmd.writes, [{ afterMs: 6000, text: '/usage' }, { afterMs: 7500, text: '\r' }]);
    assert.equal(cmd.graceMs, 3000); // 要比伪终端桥的收尾宽限（1.5 秒）长，桥才来得及让 cursor-agent 自己退出、删掉运行标记。
    return '未知界面';
  } };
  const result = await queryQuota(options);
  assert.equal(commands.length, 2); assert.ok(result.providers[0].error);
  assert.equal(result.providers[1].bars[0].approx, true); assert.match(result.providers[2].error!, /界面可能改了/);
  assert.deepEqual(await readQuotaCache(), result);
  assert.deepEqual((await readdir(join(c.home, 'cache'))), ['quota.json']);
  assert.deepEqual(await ensureQuota({ ...options, now: new Date(Date.parse(at) + 600000) }), result);
  assert.equal(commands.length, 2);
  await ensureQuota({ ...options, now: new Date(Date.parse(at) + 600001) }); assert.equal(commands.length, 4);
  await writeFile(join(c.home, 'cache/quota.json'), '{broken'); assert.equal(await readQuotaCache(), null);
  await ensureQuota(options); assert.equal(commands.length, 6);
  const malformed = structuredClone(result); malformed.providers[0].bars = [null as any];
  await writeFile(join(c.home, 'cache/quota.json'), JSON.stringify(malformed)); assert.equal(await readQuotaCache(), null);
  assert.equal(boardQuota(null).length, 3); assert.equal(boardQuota(null)[0].bars[0].used, null);
});

test('80% 四家分别拦截，未知用量不拦，快照跨重置/近似/缺失时不报差值', async () => {
  for (const who of ['codex', 'grok', 'cursor-grok', 'cursor-opus'] as const) {
    const data = await snapshot(), bar = quotaBar(data, who)!;
    bar.used = 79.9; assert.doesNotThrow(() => checkQuota(data, [{ who }]));
    bar.used = 80; assert.throws(() => checkQuota(data, [{ who }]), /--force/);
    assert.doesNotThrow(() => checkQuota(data, [{ who }], true));
    bar.used = null; assert.doesNotThrow(() => checkQuota(data, [{ who }]));
    const before = await snapshot(), after = structuredClone(before);
    quotaBar(after, who)!.used! += 0.3;
    assert.equal(quotaDelta({ who, quota_before: before, quota_after: after }), `${bar.label} +0.3%`);
    assert.equal(quotaDelta({ who, quota_before: before }), null);
    quotaBar(after, who)!.approx = true;
    assert.equal(quotaDelta({ who, quota_before: before, quota_after: after }), null);
    delete quotaBar(after, who)!.approx;
    quotaBar(after, who)!.reset = '2027-01-01T00:00:00.000Z';
    assert.equal(quotaDelta({ who, quota_before: before, quota_after: after }), null);
  }
  const data = await snapshot(); data.providers[0].bars[0].used = 99;
  assert.doesNotThrow(() => checkQuota(data, [{ who: 'codex' }]));
});

test('各选手按传入停派线判断：四档含边界，force、未知和近似用量保持原行为', async () => {
  // DeepSeek 借 Codex 跑但扣自己的余额：没有额度条，Codex 的周额度用到多少都不拦它。
  for (const who of whos.filter(w => vendorOf(w) === 'deepseek')) {
    const data = await snapshot(); quotaBar(data, 'codex')!.used = 100;
    assert.equal(quotaBar(data, who), undefined); assert.doesNotThrow(() => checkQuota(data, [{ who }], false, 50));
  }
  for (const who of whos.filter(w => vendorOf(w) !== 'deepseek')) for (const stop of quotaStops) {
    const data = await snapshot(), bar = quotaBar(data, who)!;
    bar.used = stop - 0.1; assert.doesNotThrow(() => checkQuota(data, [{ who }], false, stop));
    bar.used = stop; assert.throws(() => checkQuota(data, [{ who }], false, stop), new RegExp(`已用 ${stop}%，到了设置里的停派线 ${stop}%`));
    assert.doesNotThrow(() => checkQuota(data, [{ who }], true, stop));
    bar.approx = true; assert.doesNotThrow(() => checkQuota(data, [{ who }], false, stop));
    delete bar.approx;
    bar.used = null; assert.doesNotThrow(() => checkQuota(data, [{ who }], false, stop));
  }
});

test('执行器识别分段回复、失败、超时，终止进程组，延迟输入可替换', async t => {
  const c = await local(t), oldFake = process.env.XAGENTS_FAKE_WORKER, oldExec = process.env.XAGENTS_QUERY_EXEC;
  delete process.env.XAGENTS_FAKE_WORKER; delete process.env.XAGENTS_QUERY_EXEC;
  t.after(() => { if (oldFake) process.env.XAGENTS_FAKE_WORKER = oldFake; if (oldExec) process.env.XAGENTS_QUERY_EXEC = oldExec; });
  const command = (code: string): QueryCommand => ({ file: process.execPath, args: ['-e', code], timeoutMs: 3000 });
  const raw = await executeQuery({ ...command('process.stdout.write("first"); setTimeout(()=>process.stdout.write("done"),30); setInterval(()=>{},1000)'), complete: s => s.includes('firstdone') });
  assert.equal(raw, 'firstdone');
  assert.equal(await executeQuery({ ...command('process.stdin.once("data", b => {process.stdout.write(b); process.exit(0)})'), writes: [{ afterMs: 20, text: '/usage\r' }] }), '/usage\r');
  await assert.rejects(executeQuery(command('process.exit(3)')), /退出码 3/);
  const marker = join(c.temp, 'pids');
  const hanging = command(`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)`);
  hanging.timeoutMs = 250;
  await assert.rejects(executeQuery(hanging), /超时/);
  const pids = JSON.parse(await readFile(marker, 'utf8'));
  await until(async () => pids.every((pid: number) => !alive(pid)));
  await assert.rejects(executeQuery({ file: join(c.temp, 'missing'), args: [] }), /ENOENT/);
});

test('收尾关程序时报 EPERM（程序刚退出还没被收走）：已拿到结果就照常返回，没拿到结果照旧当失败', async t => {
  const oldFake = process.env.XAGENTS_FAKE_WORKER, oldExec = process.env.XAGENTS_QUERY_EXEC;
  delete process.env.XAGENTS_FAKE_WORKER; delete process.env.XAGENTS_QUERY_EXEC;
  t.after(() => { if (oldFake) process.env.XAGENTS_FAKE_WORKER = oldFake; if (oldExec) process.env.XAGENTS_QUERY_EXEC = oldExec; });
  const real = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return real(pid, signal);
  });
  const command = (code: string): QueryCommand => ({ file: process.execPath, args: ['-e', code], timeoutMs: 3000 });
  assert.equal(await executeQuery({ ...command('process.stdout.write("done")'), complete: s => s.includes('done') }), 'done');
  await assert.rejects(executeQuery({ ...command('process.stdout.write("half"); setTimeout(() => {}, 100)'), timeoutMs: 20, complete: s => s.includes('done') }), /EPERM|超时/);
});
test('CLI 替身查询写缓存；派活拦截在建任务前，force 放行，结束只读缓存，桌面视图输出额度格式', async t => {
  const c = await context(t); await c.add();
  const marker = join(c.temp, 'queries'), extra = { XAGENTS_QUERY_EXEC: join(fixtures, 'query.ts'), XAGENTS_CODEX_SESSIONS: fixtures, XA_QUERY_MARKER: marker };
  const quota = await c.cli(['quota', '--json'], extra); assert.equal(quota.code, 0, quota.stderr);
  const data: QuotaSnapshot = JSON.parse(quota.stdout); assert.deepEqual(data.providers.filter(p => p.error).map(p => [p.name, p.error]), [], '三家替身查询都应成功；偶发失败时这里会写出是哪家、什么错');
  assert.match((await c.cli(['quota'], extra)).stdout, /自家模型池/);
  const before = await snapshot(); before.queriedAt = new Date().toISOString(); quotaBar(before, 'codex')!.used = 80;
  await writeFile(join(c.home, 'cache/quota.json'), JSON.stringify(before));
  const denied = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], extra);
  assert.equal(denied.code, 1); assert.match(denied.stderr, /--force/); assert.equal((await c.jobs()).length, 0);
  const stamp = (await stat(join(c.home, 'cache/quota.json'))).mtimeMs;
  const launched = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high', '--force'], { ...extra, XA_TEST_MODE: 'stream' });
  assert.equal(launched.code, 0, launched.stderr);
  const job = (await c.jobs())[0];
  await until(c.jobs, rows => rows[0]?.state === 'running');
  const after = structuredClone(before); quotaBar(after, 'codex')!.used = 80.3;
  await writeFile(join(c.home, 'cache/quota.json'), JSON.stringify(after));
  const calls = await readFile(marker, 'utf8');
  await writeFile(join(c.home, 'jobs', job.id, 'continue-1'), '');
  await writeFile(join(c.home, 'jobs', job.id, 'continue-2'), '');
  assert.equal((await c.cli(['wait', job.id], extra)).code, 0);
  const done = (await c.jobs())[0] as typeof job & QuotaSnapshots;
  assert.deepEqual(done.quota_before, before); assert.deepEqual(done.quota_after, after);
  assert.equal(await readFile(marker, 'utf8'), calls);
  assert.ok((await stat(join(c.home, 'cache/quota.json'))).mtimeMs >= stamp);
  assert.equal(quotaDelta(done), '周额度 +0.3%');
  assert.deepEqual((await desktopView(c.home)).quota, boardQuota(after));
});

test('失败和被停止的任务也在结束状态同次落盘保存缓存快照', async t => {
  const c = await context(t); await c.add();
  await mkdir(join(c.home, 'cache'), { recursive: true });
  const data = await snapshot(); data.queriedAt = new Date().toISOString();
  await writeFile(join(c.home, 'cache/quota.json'), JSON.stringify(data));
  for (const mode of ['fail', 'hang']) {
    const previous = new Set((await c.jobs()).map(j => j.id));
    const started = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], { XA_TEST_MODE: mode });
    assert.equal(started.code, 0, started.stderr);
    const job = (await c.jobs()).find(j => !previous.has(j.id))!;
    if (mode === 'hang') {
      await until(c.jobs, rows => Boolean(rows.find(j => j.id === job.id)?.workerPid));
      assert.equal((await c.cli(['stop', job.id])).code, 0);
    } else assert.equal((await c.cli(['wait', job.id])).code, 1);
    const ended = (await c.jobs()).find(j => j.id === job.id)! as typeof job & QuotaSnapshots;
    assert.equal(ended.state, mode === 'hang' ? 'stopped' : 'failed');
    assert.deepEqual(ended.quota_after, data);
  }
});

test('Cursor 真实界面：套餐和重置日期在同一行，进度条、横线、链接不混进数值', async () => {
  const cursor = parseCursorQuota(await sample('cursor-real.txt'), at);
  assert.equal(cursor.plan, 'Ultra');
  assert.deepEqual(cursor.bars.map(b => [b.label, b.used]), [['总额度', 24], ['自家模型池', 8], ['其他模型池', 37]]);
  const reset = new Date(cursor.bars[0].reset!);
  assert.deepEqual([reset.getMonth(), reset.getDate()], [10, 12]);
  assert.equal(cursor.onDemand, 'Disabled');
  assert.equal(quotaBar({ queriedAt: at, providers: [cursor] }, 'cursor-opus')?.used, 37);
  // 只截到“正在加载”的画面时，不能当成查到了。
  assert.throws(() => parseCursorQuota('\x1b[2JLoading usage data...', at), /界面可能改了/);
});

test('Grok 真实回复：套餐在 result 顶层，用量 1.0 不算“不到 1%”，夹杂通知和别的回复也能找对', async () => {
  const raw = await sample('grok-real.jsonl');
  const grok = parseGrokQuota(raw, at);
  assert.equal(grok.plan, 'Example Plan');
  assert.equal(grok.bars[0].used, 12); assert.equal(grok.bars[0].approx, undefined);
  assert.equal(grok.bars[0].reset, '2030-01-08T00:00:00.000Z');
  // 单独构造 1.0 边界，保留原测试对“不到 1%”的检查。
  const boundary = parseGrokQuota(raw.replace('"creditUsagePercent":12.0', '"creditUsagePercent":1.0'), at);
  assert.equal(boundary.bars[0].used, 1);
  assert.equal(boundary.bars[0].approx, undefined);
  // 分块到达：只收到前半行时不能算读到。
  const cut = raw.indexOf('"subscription_tier"');
  assert.throws(() => parseGrokQuota(raw.slice(0, cut), at), /未读到/);
});

test('给人看的时间是本地时间“10-04 01:00”，数据里仍是 ISO', async () => {
  const local = new Date(2026, 9, 4, 1, 0);
  assert.equal(localTime(local), '10-04 01:00'); assert.equal(localTime(local.toISOString()), '10-04 01:00');
  assert.equal(localTime(null), '未知时间'); assert.equal(localTime('乱写'), '未知时间');
  const data = await snapshot(); data.providers[0].bars[0].reset = local.toISOString(); data.providers[0].at = new Date(2026, 8, 29, 12, 5).toISOString();
  const text = formatQuota(data);
  assert.match(text, /10-04 01:00 重置/); assert.match(text, /数据时间 09-29 12:05/);
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT/);
  assert.match(JSON.stringify(data), /\d{4}-\d\d-\d\dT/);
});

test('伪终端桥：程序拿到 60×140 的真终端，输入原样送达，收尾时交互程序一起退出', async t => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('本机没有 python3'); return; }
  const c = await local(t), oldFake = process.env.XAGENTS_FAKE_WORKER, oldExec = process.env.XAGENTS_QUERY_EXEC;
  delete process.env.XAGENTS_FAKE_WORKER; delete process.env.XAGENTS_QUERY_EXEC;
  t.after(() => { if (oldFake) process.env.XAGENTS_FAKE_WORKER = oldFake; if (oldExec) process.env.XAGENTS_QUERY_EXEC = oldExec; });
  const marker = join(c.temp, 'tty-pid');
  const raw = await executeQuery({ file: 'python3', args: [join(toolRoot, 'src/core/pty-bridge.py'), '60', '140', process.execPath, join(fixtures, 'tty.ts'), marker],
    cwd: c.temp, timeoutMs: 8000, writes: [{ afterMs: 300, text: '/usage' }, { afterMs: 500, text: '\r' }], complete: s => s.includes('got:/usage') });
  assert.match(raw, /size=140x60 tty=true/);
  await until(async () => !alive(Number(await readFile(marker, 'utf8'))));
});

test('伪终端桥收尾：先整组 SIGTERM 让程序自己删运行标记，不理的等宽限到了整组强杀', async t => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('本机没有 python3'); return; }
  const c = await local(t), oldFake = process.env.XAGENTS_FAKE_WORKER, oldExec = process.env.XAGENTS_QUERY_EXEC;
  delete process.env.XAGENTS_FAKE_WORKER; delete process.env.XAGENTS_QUERY_EXEC;
  t.after(() => { if (oldFake) process.env.XAGENTS_FAKE_WORKER = oldFake; if (oldExec) process.env.XAGENTS_QUERY_EXEC = oldExec; });
  const run = async (name: string, mode: string, extra: Partial<QueryCommand>) => {
    const markers = join(c.temp, name), pidFile = join(c.temp, `${name}.pids`); await mkdir(markers);
    const started = Date.now();
    const result = await executeQuery({ file: 'python3', args: [join(toolRoot, 'src/core/pty-bridge.py'), '60', '140', process.execPath, join(fixtures, 'tty.ts'), pidFile, markers, mode],
      cwd: c.temp, timeoutMs: 8000, graceMs: 3000, writes: [{ afterMs: 300, text: '/usage' }, { afterMs: 500, text: '\r' }], complete: s => s.includes('got:/usage'), ...extra })
      .then(raw => ({ raw }), (error: Error) => ({ error }));
    const pids: number[] = JSON.parse(await readFile(pidFile, 'utf8'));
    assert.equal(pids.length, 2);
    await until(async () => pids.every(pid => !alive(pid)));
    return { result, pids, ms: Date.now() - started, left: await readdir(markers) };
  };
  // 像 cursor-agent：主进程和子进程收到 SIGTERM 各自删掉 .running/<进程号> 再退出，查询不必等满宽限。
  const polite = await run('polite', '', {});
  assert.ok('raw' in polite.result && polite.result.raw.includes('got:/usage'));
  assert.deepEqual(polite.left, []);
  assert.ok(polite.ms < 2500, `正常退出不该等满宽限：${polite.ms} 毫秒`);
  // 不理 SIGTERM：桥等 1.5 秒后整组强杀，两个进程都不留；标记留下，说明替身确实写过。
  const stubborn = await run('stubborn', 'stubborn', {});
  assert.ok('raw' in stubborn.result);
  assert.deepEqual(stubborn.left.map(Number).sort(), [...stubborn.pids].sort());
  assert.ok(stubborn.ms >= 1500, `应先等宽限再强杀：${stubborn.ms} 毫秒`);
  // 超时也一样：报超时，整组杀干净。
  const late = await run('late', 'stubborn', { timeoutMs: 700, complete: () => false });
  assert.ok('error' in late.result && /超时/.test(late.result.error.message));
});

test('某一家这次查不到：保留那家上一次的数据和时间，写明这次没查到；不因旧数据拦派活', async t => {
  const c = await local(t), dir = join(c.temp, 'sessions'); await mkdir(dir);
  const raw = await sample('codex.jsonl'); const reachedLine = JSON.parse(raw); reachedLine.payload.rate_limits.rate_limit_reached_type = 'secondary';
  await writeFile(join(dir, 'a.jsonl'), JSON.stringify(reachedLine) + '\n');
  await utimes(join(dir, 'a.jsonl'), new Date(at), new Date(at));
  const good = async (cmd: QueryCommand) => cmd.file === 'grok' ? sample('grok.json') : sample('cursor.txt');
  const first = await queryQuota({ sessionsDir: dir, now: new Date(at), execute: good });
  assert.ok(first.providers.every(p => !p.error)); assert.equal(first.providers[0].reached, 'secondary');
  const later = new Date(Date.parse(at) + 3_600_000);
  const second = await queryQuota({ sessionsDir: join(c.temp, 'missing'), now: later, execute: async cmd => { if (cmd.file === 'grok') throw new Error('查询超时'); return sample('cursor.txt'); } });
  const [codex, grok, cursor] = second.providers;
  assert.match(codex.error!, /ENOENT|no such/i); assert.equal(codex.at, at); assert.equal(codex.bars[1].used, first.providers[0].bars[1].used); assert.equal(codex.reached, undefined);
  assert.equal(grok.error, '查询超时'); assert.equal(grok.at, at); assert.equal(grok.bars[0].used, first.providers[1].bars[0].used);
  assert.equal(cursor.error, undefined); assert.equal(cursor.at, later.toISOString());
  assert.deepEqual(await readQuotaCache(), second);
  const shown = boardQuota(second);
  assert.equal(shown[0].failed, true); assert.equal(shown[0].at, at); assert.equal(shown[0].bars[1].used, codex.bars[1].used);
  assert.equal(shown[2].failed, undefined); assert.equal(shown[2].at, later.toISOString());
  assert.equal(quotaBar(second, 'codex'), undefined); // 旧数据只给人看，不参与拦截和差值
  assert.doesNotThrow(() => checkQuota(second, [{ who: 'codex' }, { who: 'grok' }]));
  assert.match(formatQuota(second), /Grok：这次没查到（查询超时）；上一次的数据：.*（数据时间 \d\d-\d\d \d\d:\d\d）/);
  // 上次也没有数据：照旧写查不到，不编数字。
  const third = await queryQuota({ sessionsDir: join(c.temp, 'missing'), now: later, execute: async () => { throw new Error('坏了'); } });
  await writeFile(join(c.home, 'cache/quota.json'), '{broken');
  const fresh = await queryQuota({ sessionsDir: join(c.temp, 'missing'), now: later, execute: async () => { throw new Error('坏了'); } });
  assert.ok(fresh.providers.every(p => p.error && p.at === null && p.bars.every(b => b.used === null)));
  assert.equal(third.providers[2].error, '坏了'); assert.equal(third.providers[2].bars[0].used, cursor.bars[0].used); // 连续失败仍保留最早那次的数据
  assert.match(formatQuota(fresh), /Codex：查不到/);
  assert.equal(boardQuota(null).every(p => p.failed === undefined && p.at === null), true);
});
test('额度数据时间：CLI 用本地时间 MM-DD HH:mm', async () => {
  assert.match(formatQuota(await snapshot()), new RegExp(`数据时间 ${localTime(at)}`));
  assert.match(localTime(at), /^\d\d-\d\d \d\d:\d\d$/);
});
