import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { checkChoice, effectiveWorkers, validateWorkersPatch } from '../src/core/policy.ts';
import type { WorkerPolicy } from '../src/core/policy.ts';
import { allowedEfforts, supportsFast, whos, spec } from '../src/core/roster.ts';
import { readSettings, writeSettings } from '../src/core/settings.ts';
import { buildView } from '../src/core/view.ts';
import { settingsActions, settingsPatch } from '../app/main/actions.ts';
import { alive } from '../src/core/fsx.ts';
import { context, until } from './helpers.ts';

const normal = (): WorkerPolicy => ({ enabled: true, efforts: ['high'], fast: false });
async function registry(t: TestContext) {
  const c = await context(t, false), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  return c;
}

test('effectiveWorkers：空和坏数据、缺选手回退；各选手结果合法且互不共用数组', () => {
  const defaults = effectiveWorkers(undefined);
  assert.deepEqual(Object.keys(defaults), whos);
  for (const who of whos) assert.deepEqual(defaults[who], { enabled: true, efforts: allowedEfforts(who), fast: supportsFast(who) });
  for (const bad of [undefined, null, false, 42, 'bad', [], {}, { unknown: normal() }]) assert.deepEqual(effectiveWorkers(bad), defaults);
  const stored = { grok: { enabled: false, efforts: ['xhigh', 'medium', 'medium'], fast: true } };
  const before = structuredClone(stored), partial = effectiveWorkers(stored);
  assert.deepEqual(partial.grok, { enabled: false, efforts: ['medium', 'xhigh'], fast: true });
  assert.deepEqual(partial.codex, defaults.codex);
  assert.deepEqual(stored, before);
  for (const bad of [null, [], {}, { ...normal(), enabled: 'false' }, { ...normal(), fast: 1 },
    { ...normal(), efforts: [] }, { ...normal(), efforts: ['high', 'max'] }, { ...normal(), efforts: ['low'] },
    { ...normal(), efforts: [5] }, { ...normal(), extra: true }, { ...normal(), fast: true }]) {
    const value = effectiveWorkers({ codex: bad, grok: normal() });
    assert.deepEqual(value.codex, defaults.codex);
    assert.deepEqual(value.grok, normal());
  }
  assert.equal(effectiveWorkers({ 'cursor-sonnet': { ...normal(), fast: true } })['cursor-sonnet'].fast, false);
  const allOff = Object.fromEntries(whos.map(who => [who, { ...defaults[who], enabled: false }]));
  assert.deepEqual(effectiveWorkers(allOff), defaults);
  partial.codex.efforts.length = 0;
  assert.deepEqual(effectiveWorkers(undefined), defaults);
});

test('validateWorkersPatch：未知选手、空强度、max/low、非布尔、缺项和多余字段均拒绝', () => {
  assert.deepEqual(validateWorkersPatch({}), {});
  const good = { grok: { enabled: false, efforts: ['xhigh', 'medium', 'high', 'high'], fast: true } };
  assert.deepEqual(validateWorkersPatch(good), { grok: { enabled: false, efforts: ['medium', 'high', 'xhigh'], fast: true } });
  assert.equal(good.grok.efforts.length, 4);
  for (const bad of [null, [], true, 'grok', { unknown: normal() }, JSON.parse('{"__proto__":{}}'),
    { codex: { ...normal(), efforts: [] } }, { codex: { ...normal(), efforts: ['max'] } },
    { codex: { ...normal(), efforts: ['low', 'high'] } }, { codex: { ...normal(), efforts: new Array(1) } },
    { codex: { ...normal(), enabled: 1 } }, { grok: { ...normal(), fast: 'true' } },
    { codex: { ...normal(), extra: true } }, { codex: { enabled: true, efforts: ['high'] } },
    { codex: { ...normal(), fast: true } }, { 'cursor-sonnet': { ...normal(), fast: true } }]) {
    assert.throws(() => validateWorkersPatch(bad), /选手|设置|强度|开关|快速版/);
  }
});

test('checkChoice：开关、强度和快速版给出中文改法；允许的选择通过', () => {
  const policy = effectiveWorkers({ codex: normal(), grok: { ...normal(), enabled: false } });
  assert.throws(() => checkChoice(policy, { who: 'grok', effort: 'high' }), /主人.*关掉.*请换/);
  assert.throws(() => checkChoice(policy, { who: 'codex', effort: 'medium' }), /只允许.*高档.*请把强度/);
  policy.grok.enabled = true;
  assert.throws(() => checkChoice(policy, { who: 'grok', effort: 'high', fast: true }), /没有打开.*请去掉 :fast/);
  assert.doesNotThrow(() => checkChoice(policy, { who: 'codex', effort: 'high' }));
  policy.grok.fast = true;
  assert.doesNotThrow(() => checkChoice(policy, { who: 'grok', effort: 'high', fast: true }));
});

test('writeSettings：逐选手整体替换、并发合并、读写一致，不影响其他设置', async t => {
  const c = await registry(t), file = join(c.home, 'config.json');
  await writeFile(file, JSON.stringify({ custom: { keep: 42 }, board: { columns: { running: '#123456' } }, keepAwake: false, notifications: false }));
  await Promise.all([
    writeSettings({ workers: { codex: normal() } }),
    writeSettings({ workers: { grok: { enabled: false, efforts: ['xhigh', 'medium', 'medium'], fast: true } } }),
    writeSettings({ columns: { done: '#abcdef' } }),
  ]);
  const read = await readSettings();
  assert.deepEqual(read.workers.codex, normal());
  assert.deepEqual(read.workers.grok, { enabled: false, efforts: ['medium', 'xhigh'], fast: true });
  assert.equal(read.keepAwake, false); assert.equal(read.notifications, false);
  assert.deepEqual(read.columns, { done: '#abcdef' });
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.workers, read.workers); assert.deepEqual(stored.custom, { keep: 42 });
  assert.deepEqual(stored.board, { columns: { running: '#123456' } });
  await writeSettings({ workers: { grok: normal() } });
  assert.deepEqual((await readSettings()).workers.grok, normal());
  assert.deepEqual((await readSettings()).workers.codex, read.workers.codex);
  const before = await readFile(file, 'utf8');
  await assert.rejects(writeSettings({ workers: { grok: { enabled: true } } } as Parameters<typeof writeSettings>[0]));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(c.home), ['config.json']);
});

test('writeSettings：并发关闭最后两位只准一个成功，最后一位被拒绝且文件不变', async t => {
  const c = await registry(t), all = effectiveWorkers(undefined);
  for (const who of whos) all[who].enabled = who === 'codex' || who === 'grok';
  await writeSettings({ workers: all });
  const results = await Promise.allSettled(['codex', 'grok'].map(who => writeSettings({ workers: { [who]: { ...normal(), enabled: false } } })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected'); assert.match(rejected.reason.message, /至少.*一位/);
  const workers = (await readSettings()).workers;
  const enabled = whos.filter(who => workers[who].enabled); assert.equal(enabled.length, 1);
  const before = await readFile(join(c.home, 'config.json'), 'utf8');
  await assert.rejects(writeSettings({ notifications: false, workers: { [enabled[0]]: { ...normal(), enabled: false } } }), /至少.*一位/);
  assert.equal(await readFile(join(c.home, 'config.json'), 'utf8'), before);
});

test('主进程 settingsPatch 与 settingsActions：合法 workers 写入真实设置，非法请求不落盘', async t => {
  const c = await registry(t);
  let updated = 0, login = false;
  const actions = settingsActions({ readSettings, writeSettings, getLogin: () => login, setLogin: value => { login = value; } }, async () => { updated++; });
  const patch = { workers: { codex: normal() }, notifications: false };
  assert.deepEqual(settingsPatch(patch), patch);
  const result = await actions.set([patch]);
  assert.deepEqual(result.workers.codex, normal()); assert.equal(result.notifications, false);
  assert.deepEqual((await actions.get([])).workers, (await readSettings()).workers); assert.equal(updated, 1);
  const before = await readFile(join(c.home, 'config.json'), 'utf8');
  for (const workers of [null, [], { unknown: normal() }, { grok: { ...normal(), efforts: ['max'] } },
    { grok: { ...normal(), enabled: 'yes' } }, { grok: { ...normal(), surprise: true } }]) {
    assert.throws(() => settingsPatch({ workers }));
    await assert.rejects(actions.set([{ workers, openAtLogin: true }]));
  }
  assert.equal(login, false); assert.equal(updated, 1);
  assert.equal(await readFile(join(c.home, 'config.json'), 'utf8'), before);
});

test('看板提供完整策略和按 roster 排序的能力，workers 命令与帮助反映主人限制', async t => {
  const c = await registry(t);
  await writeSettings({ workers: { codex: { ...normal(), enabled: false }, grok: normal() } });
  const view = await buildView();
  assert.deepEqual(view.settings.workers, (await readSettings()).workers);
  assert.deepEqual(view.roster, whos.map(who => ({ who, name: spec(who).name, model: spec(who).shown, efforts: allowedEfforts(who), fastSupported: supportsFast(who) })));
  assert.deepEqual(view.roster[0].efforts, ['medium', 'high', 'xhigh']);
  const result = await c.cli(['workers']); assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout.split('\n');
  assert.match(rows.find(row => row.includes('（codex）'))!, /GPT-6 Astra.*high（高档）.*未开放.*关闭/);
  assert.match(rows.find(row => row.includes('（grok）'))!, /Grok 4.7.*high（高档）.*未开放.*开启/);
  for (const who of whos) assert.ok(rows.some(row => row.includes(`（${who}）`)));
  assert.match((await c.cli(['--help'])).stdout, /xagents workers/);
  assert.equal((await c.cli(['workers', 'extra'])).code, 1);
});

test('真实 CLI run：整批先校验，关掉、禁用强度、未开快速版连 --force 都拒绝且不留任务或副本', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ workers: {
    codex: { ...normal(), enabled: false }, grok: normal(),
  } }));
  const worktrees = await c.git(['worktree', 'list', '--porcelain']);
  const cases = [['codex:high', /主人.*关掉/], ['grok:medium', /主人只允许.*高档/], ['grok:high:fast', /主人没有打开.*快速版/]] as const;
  for (const [choice, error] of cases) for (const force of [false, true]) {
    const run = await c.cli(['run', c.task, '--summary', '策略拒绝测试', '--who', 'cursor-sonnet:high', '--who', choice, ...(force ? ['--force'] : [])]);
    assert.equal(run.code, 1, run.stdout + run.stderr); assert.match(run.stderr, error);
    assert.deepEqual(await c.jobs(), []);
    assert.deepEqual(await readdir(join(c.home, 'jobs')), []);
    assert.deepEqual(await readdir(join(c.home, 'batches')), []);
    assert.deepEqual(await readdir(join(c.home, 'cache')), []);
    assert.ok(!(await readdir(c.home)).includes('board'));
    assert.ok(!(await readdir(c.home)).includes('icons'));
    assert.deepEqual(await readdir(join(c.repo, '.worktrees')).catch(() => []), []);
    assert.equal(await c.git(['worktree', 'list', '--porcelain']), worktrees);
    assert.equal(await c.git(['branch', '--list', 'xa/*']), '');
  }
  // 无效项目/题目也应先报主人策略，证明拒绝发生在准备之前。
  const early = await c.cli(['run', join(c.temp, 'missing.md'), '--summary', '检查校验顺序', '--project', '不存在', '--who', 'codex:high']);
  assert.match(early.stderr, /主人.*关掉/);
  const allowed = await c.cli(['run', c.task, '--summary', '允许的照常派', '--who', 'grok:high']);
  assert.equal(allowed.code, 0, allowed.stderr);
  const job = (await c.jobs())[0]; assert.equal(job.who, 'grok'); assert.equal(job.effort, 'high');
  const waited = await c.cli(['wait', job.id]); assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const done = (await c.jobs())[0]; assert.equal(done.state, 'done');
  assert.ok(done.command?.args[0].endsWith('test/fixtures/worker.ts'));
  await until(async () => !alive(done.pid) && !alive(done.workerPid));
  assert.equal((await c.cli(['clean', done.id])).code, 0);
});

test('真实 CLI run：配置不可读时停止派活，--force 也不按全开绕过', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  await mkdir(join(c.home, 'config.json'));
  for (const force of [false, true]) {
    const result = await c.cli(['run', c.task, '--summary', '配置读取故障', '--who', 'codex:high', ...(force ? ['--force'] : [])]);
    assert.equal(result.code, 1); assert.match(result.stderr, /EISDIR/);
    assert.deepEqual(await readdir(join(c.home, 'jobs')), []);
    assert.deepEqual(await readdir(join(c.home, 'batches')), []);
    assert.deepEqual(await readdir(join(c.repo, '.worktrees')).catch(() => []), []);
  }
});
