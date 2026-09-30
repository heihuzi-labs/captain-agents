import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stats, quotaUsed, typicalFor, typicals } from '../src/core/stats.ts';
import { awakeSeconds, sleptSeconds } from '../src/core/duration.ts';
import { buildView } from '../src/core/view.ts';
import { statsTable } from '../src/cli/stats.ts';
import type { Job } from '../src/core/job.ts';
import { context } from './helpers.ts';
import { ensureHome } from '../src/core/paths.ts';

const job = (extra: Record<string, unknown> = {}): Job => ({ who: 'codex', kind: '实现', state: 'done', seconds: 10, created: '2026-09-29T00:00:00Z', ...extra }) as Job;
const quota = (n: number) => ({ codex: { secondary: { used_percent: n } } });
test('按选手和类型统计结束任务；验收分母、未知额度、重置和少样本准确；出错、停下不进平均用时', () => {
  const rows = stats([
    job({ verify: { ok: true }, decision: { kind: 'adopt' }, quota_before: quota(20), quota_after: quota(21) }),
    job({ state: 'failed', seconds: 20, verify: { ok: false }, quota_before: quota(99), quota_after: quota(1) }),
    job({ state: 'stopped', seconds: 30 }), job({ state: 'running' }), job({ state: 'queued' }),
    job({ who: 'grok', kind: '调研', state: 'lost', seconds: undefined }),
  ]);
  const a = rows.find(r => r.who === 'codex')!;
  assert.deepEqual(a, { who: 'codex', fast: false, kind: '实现', count: 3, small: false, doneRate: 1 / 3, verified: 2, passed: 1, verifyRate: 0.5, adopted: 1, adoptRate: 1 / 3, secondsSamples: 1, averageSeconds: 10, quotaSamples: 1, averageQuotaDelta: 1 });
  const b = rows.find(r => r.who === 'grok')!; assert.equal(b.small, true); assert.equal(b.verifyRate, null); assert.equal(b.averageSeconds, null); assert.equal(b.averageQuotaDelta, null);
  assert.match(statsTable(rows), /（少）/); assert.deepEqual(stats([]), []);
});
test('额度按选手所用池取数；零有效，未知和非法值不补零', () => {
  assert.equal(quotaUsed({ codex: { primary: { used_percent: 80 }, secondary: { used_percent: 0 } } }, 'codex'), 0);
  assert.equal(quotaUsed({ grok: { config: { creditUsagePercent: 12 } } }, 'grok'), 12);
  assert.equal(quotaUsed({ cursor: { auto: 3, api: 30 } }, 'cursor-grok'), 3);
  assert.equal(quotaUsed({ cursor: { auto: 3, api: 30 } }, 'cursor-opus'), 30);
  for (const v of [-1, 101, '10', null, undefined, NaN]) assert.equal(quotaUsed({ grok: { usedPercent: v } }, 'grok'), null);
});
test('stats 命令从登记处汇总已清理历史任务', async t => {
  const c = await context(t, false); await c.cli(['stats']);
  const dir = join(c.home, 'jobs/history'); await mkdir(dir);
  await writeFile(join(dir, 'job.json'), JSON.stringify(job({ id: 'history', cleaned: '2026-09-29T01:00:00Z' })));
  const r = await c.cli(['stats']); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /codex/); assert.match(r.stdout, /（少）/); assert.match(r.stdout, /100.0%/);
});

const at = (s: number) => new Date(Date.parse('2026-09-29T00:00:00Z') + s * 1000).toISOString();
// 用 started/ended 都写全，休眠才有基准。
const timed = (seconds: number, extra: Record<string, unknown> = {}) => job({ started: at(0), ended: at(seconds), seconds, ...extra });
test('合格只认验收记录：没有记录写不出比例，分母只算有记录的件数', () => {
  const none = stats([job(), job(), job()])[0];
  assert.equal(none.verified, 0); assert.equal(none.passed, 0); assert.equal(none.verifyRate, null);
  const some = stats([job({ verify: { ok: true } }), job({ verify: { ok: true } }), job({ verify: { ok: false } }), job(), job()])[0];
  assert.equal(some.count, 5); assert.equal(some.verified, 3); assert.equal(some.passed, 2); assert.ok(Math.abs(some.verifyRate! - 2 / 3) < 1e-9);
  assert.match(statsTable(stats([job()])), /没有验收记录/); assert.match(statsTable(stats([job({ verify: { ok: true } }), job({ verify: { ok: false } })])), /1\/2 合格/);
});
test('平均用时：停下、断了、出错的不算；休眠时段扣掉；快速版和普通版分开', () => {
  const [normal, fast] = stats([timed(100), timed(300), timed(9000, { state: 'stopped' }), timed(9000, { state: 'lost' }), timed(9000, { state: 'failed' }),
    timed(60, { fast: true })]);
  assert.equal(normal.fast, false); assert.equal(normal.count, 5); assert.equal(normal.secondsSamples, 2); assert.equal(normal.averageSeconds, 200);
  assert.equal(fast.fast, true); assert.equal(fast.averageSeconds, 60);
  // 600 秒里睡了 300 秒（其中两段有重叠，只算一次），另一段在任务之外，不扣。
  const slept = timed(600, { sleeps: [{ from: at(100), to: at(300) }, { from: at(200), to: at(400) }, { from: at(1000), to: at(2000) }] });
  assert.equal(awakeSeconds(slept), 300); assert.equal(stats([slept, timed(100)])[0].averageSeconds, 200);
  assert.equal(sleptSeconds([{ from: at(-50), to: at(50) }], Date.parse(at(0)), Date.parse(at(100))), 50);
  assert.equal(awakeSeconds({ seconds: undefined }), null); assert.equal(awakeSeconds(job({ state: 'running' })), 10);
  assert.equal(stats([job({ state: 'failed' })])[0].averageSeconds, null);
});
test('“通常多久”：同一选手、同一类活、做完了的至少 3 件才给；扣休眠；不算停下、断了、出错；快速版分开', () => {
  const two = [timed(10), timed(20)];
  assert.deepEqual(typicals(two), []); assert.equal(typicalFor(typicals(two), job()), null);
  const jobs = [...two, timed(60), timed(9000, { state: 'stopped' }), timed(9000, { state: 'lost' }), timed(9000, { state: 'failed' }), timed(9000, { fast: true }), timed(9000, { kind: '调研' })];
  const list = typicals(jobs);
  assert.equal(list.length, 1); assert.equal(list[0].count, 3); assert.equal(list[0].seconds, 20);
  assert.equal(typicalFor(list, job()), 20); assert.equal(typicalFor(list, job({ fast: true })), null); assert.equal(typicalFor(list, job({ kind: '调研' })), null);
  assert.equal(typicalFor(list, job({ who: 'grok' })), null);
  const slept = timed(1000, { sleeps: [{ from: at(0), to: at(900) }] }); // 只干了 100 秒
  assert.equal(typicals([slept, slept, slept])[0].seconds, 100);
});
test('看板数据：每件活的用时已扣休眠，运行中的活按核心规则带“通常多久”；合格、平均只来自 stats', async t => {
  const c = await context(t, false), old = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = old; });
  // 用一个真的活着的进程冒充看管进程（测试收尾会清掉登记处里的进程号，所以不能用测试自己的）。
  const sitter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); t.after(() => { sitter.kill(); });
  const write = async (id: string, extra: Record<string, unknown>) => {
    const dir = join(c.home, 'jobs', id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'job.json'), JSON.stringify({ ...job(), id, batch: id, title: id, created: at(0), started: at(0), ...extra }));
  };
  await ensureHome();
  await write('a', { seconds: 100, ended: at(100) }); await write('b', { seconds: 200, ended: at(200) });
  await write('c', { seconds: 1000, ended: at(1000), sleeps: [{ from: at(0), to: at(700) }] });
  await write('live', { state: 'running', pid: sitter.pid, seconds: undefined });
  await write('two', { state: 'running', pid: sitter.pid, seconds: undefined, kind: '调研' });
  const v = await buildView(), by = (id: string) => v.jobs.find(j => j.id === id)!;
  assert.equal(by('c').seconds, 300); assert.equal(by('a').seconds, 100);
  assert.equal(by('live').typical, 200); assert.equal(by('two').typical, null); assert.equal(by('live').seconds, null);
  assert.equal(v.stats.find(s => s.kind === '实现')!.averageSeconds, 200);
});
