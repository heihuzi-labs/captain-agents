import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, exec, root, until } from './helpers.ts';
import type { QuotaSnapshot } from '../src/core/quota.ts';

async function quota(home: string, used: number) {
  const at = new Date().toISOString();
  const snapshot: QuotaSnapshot = { queriedAt: at, providers: [
    { name: 'Codex', icon: 'codex', plan: 'pro', at, bars: [{ label: '周额度', used, reset: null, windowMinutes: 10080 }] },
    { name: 'Grok', icon: 'grok', plan: null, at, bars: [] },
    { name: 'Cursor', icon: 'cursor', plan: null, at, bars: [] },
  ] };
  await mkdir(join(home, 'cache'), { recursive: true });
  await writeFile(join(home, 'cache/quota.json'), JSON.stringify(snapshot));
}

// 拒绝后任务、批次、磁盘副本、git 副本和分支都不能增加。
async function inventory(c: Awaited<ReturnType<typeof context>>) {
  return {
    jobs: await readdir(join(c.home, 'jobs')),
    batches: await readdir(join(c.home, 'batches')),
    copies: await readdir(join(c.repo, '.worktrees')).catch(() => []),
    worktrees: await c.git(['worktree', 'list', '--porcelain']),
    branches: await c.git(['branch', '--list', 'xa/*']),
  };
}

test('同时最多跑读设置：2 件占满就拒绝，环境变量 5 不能放宽，1 可以收紧，force 不能绕过', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ limits: { maxRunning: 2, quotaStop: 80 } }));
  await quota(c.home, 55);
  const args = ['run', c.task, '--summary', '派活限制测试', '--who', 'codex:high'];
  const started = await c.cli([...args, '--who', 'codex:high'], { XA_TEST_MODE: 'hang' });
  assert.equal(started.code, 0, started.stderr);
  const jobs = await until(c.jobs, rows => rows.length === 2 && rows.every(j => j.state === 'running'));
  const before = await inventory(c);
  for (const env of [undefined, '5']) for (const force of [false, true]) {
    const denied = await c.cli([...args, ...(force ? ['--force'] : [])], { XAGENTS_MAX_RUNNING: env });
    assert.equal(denied.code, 1, denied.stdout + denied.stderr);
    assert.match(denied.stderr, /同时最多跑 2 件（设置 → 选手与模型 → 派活限制），现在已有 2 件/);
    assert.deepEqual(await inventory(c), before);
  }
  assert.equal((await c.cli(['stop', jobs[0].id])).code, 0);
  const afterStop = await inventory(c);
  const stricter = await c.cli(args, { XAGENTS_MAX_RUNNING: '1' });
  assert.equal(stricter.code, 1);
  assert.match(stricter.stderr, /同时最多跑 1 件.*现在已有 1 件/);
  assert.match(stricter.stderr, /XAGENTS_MAX_RUNNING 临时收紧/);
  assert.deepEqual(await inventory(c), afterStop);
  assert.equal((await c.cli(['stop', jobs[1].id])).code, 0);
});

test('缺省最多 12 件，环境变量不能突破；非法环境变量拒绝且不登记', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  await quota(c.home, 55);
  const args = ['run', c.task, '--summary', '上限底线测试', '--who', 'codex:high'];
  const before = await inventory(c);
  const denied = await c.cli([...args, ...Array.from({ length: 12 }, () => ['--who', 'codex:high']).flat()], { XAGENTS_MAX_RUNNING: '99' });
  assert.equal(denied.code, 1); assert.match(denied.stderr, /同时最多跑 12 件/);
  assert.deepEqual(await inventory(c), before);
  for (const value of ['0', '-1', '1.5', 'bad']) {
    const invalid = await c.cli(args, { XAGENTS_MAX_RUNNING: value });
    assert.equal(invalid.code, 1); assert.match(invalid.stderr, /必须是正整数/);
    assert.deepEqual(await inventory(c), before);
  }
});

test('额度停派线读设置：60% 时拒绝 65%、放行 55%，force 能跳过额度，缺省仍为 80%', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  const config = join(c.home, 'config.json');
  await writeFile(config, JSON.stringify({ limits: { maxRunning: 2, quotaStop: 60 } }));
  const args = ['run', c.task, '--summary', '额度停派线测试', '--who', 'codex:high'];
  await quota(c.home, 65);
  const before = await inventory(c), denied = await c.cli(args);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Codex 的周额度已用 65%，到了设置里的停派线 60%/);
  assert.deepEqual(await inventory(c), before);
  for (const [used, force, defaults] of [[65, true, false], [55, false, false], [65, false, true]] as const) {
    if (defaults) await writeFile(config, '{}');
    await quota(c.home, used);
    const previous = new Set((await c.jobs()).map(j => j.id));
    const launched = await c.cli([...args, ...(force ? ['--force'] : [])]);
    assert.equal(launched.code, 0, launched.stderr);
    const job = (await c.jobs()).find(j => !previous.has(j.id))!;
    assert.ok(job);
    const waited = await c.cli(['wait', job.id]); assert.equal(waited.code, 0, waited.stderr);
    assert.equal((await c.jobs()).find(j => j.id === job.id)?.state, 'done');
  }
  await quota(c.home, 80);
  const finalBefore = await inventory(c), defaultDenied = await c.cli(args);
  assert.equal(defaultDenied.code, 1); assert.match(defaultDenied.stderr, /停派线 80%/);
  assert.deepEqual(await inventory(c), finalBefore);
});

test('workers 和帮助显示当前派活限制与环境变量只能收紧', async t => {
  const c = await context(t, false);
  for (const limits of [{ maxRunning: 2, quotaStop: 60 }, { maxRunning: 12, quotaStop: 80 }]) {
    await writeFile(join(c.home, 'config.json'), JSON.stringify({ limits }));
    const workers = await c.cli(['workers']); assert.equal(workers.code, 0, workers.stderr);
    assert.ok(workers.stdout.trimEnd().endsWith(`派活限制：同时最多 ${limits.maxRunning} 件；额度用到 ${limits.quotaStop}% 停派（设置 → 选手与模型）`));
  }
  const help = await c.cli(['--help']); assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /XAGENTS_MAX_RUNNING：正整数.*临时收紧.*较小值.*不能放宽设置或超过 12/);
});

test('设置边界：12 件合法，13 件拒绝且保留原设置', async t => {
  const c = await context(t, false);
  const result = await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readSettings, writeSettings } from './src/core/settings.ts';
    assert.equal((await readSettings()).limits.maxRunning, 12);
    await writeSettings({ limits: { maxRunning: 12, quotaStop: 80 } });
    assert.deepEqual((await readSettings()).limits, { maxRunning: 12, quotaStop: 80 });
    await assert.rejects(writeSettings({ limits: { maxRunning: 13, quotaStop: 80 } }), /同时最多跑 1–12 件/);
    assert.deepEqual((await readSettings()).limits, { maxRunning: 12, quotaStop: 80 });
  `], root, c.env);
  assert.equal(result.code, 0, result.stderr);
});
