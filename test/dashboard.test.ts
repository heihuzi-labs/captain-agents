import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, Rating, Who } from '../src/core/job.ts';
import { dashboard } from '../src/core/dashboard.ts';
import { quotaDelta } from '../src/core/quota.ts';
import type { QuotaBar, QuotaSnapshot, QuotaSnapshots } from '../src/core/quota.ts';
import { profiles } from '../src/core/profiles.ts';
import { whos } from '../src/core/roster.ts';
import { formatReport } from '../src/cli/report.ts';
import { context, exec, root } from './helpers.ts';

// 用本地构造日期，测试不依赖运行机器所在时区。
const now = new Date(2026, 8, 30, 12).getTime();
const at = (day: number, hour = 0, minute = 0, second = 0) => new Date(2026, 8, day, hour, minute, second).toISOString();
const job = (id: string, extra: Partial<Job> & QuotaSnapshots = {}): Job & QuotaSnapshots => ({
  id, batch: 'batch', project: '甲', repo: '/unused', base: 'test', worktree: '/unused', branch: `xa/${id}`,
  who: 'codex', model: 'test', effort: 'high', mode: 'read-only', kind: '实现', title: id, summary: '仪表盘测试',
  state: 'done', created: at(30, 8), started: at(30, 8), ended: at(30, 9), ...extra,
});
const rating = (extra: Partial<Rating> = {}): Rating => ({ score: 4, tags: [], at: at(30, 10), by: 'lead', ...extra });
const snapshot = (used: number, extra: Partial<QuotaBar> = {}): QuotaSnapshot => ({ queriedAt: at(30), providers: [
  { name: 'Codex', icon: 'codex', plan: null, at: at(30), bars: [{ label: '周额度', windowMinutes: 10080, used, reset: at(35), ...extra }] },
  { name: 'Grok', icon: 'grok', plan: null, at: at(30), bars: [{ label: '本期额度', used, reset: at(35), ...extra }] },
  { name: 'Cursor', icon: 'cursor', plan: null, at: at(30), bars: [
    { label: '自家模型池', used, reset: at(35), ...extra }, { label: '其他模型池', used, reset: at(35), ...extra },
  ] },
] });
const metered = (id: string, who: Who, start: number, end: number, before: number, after: number, weight: number) => job(id, {
  who, started: at(30, start), ended: at(30, end), quota_before: snapshot(before), quota_after: snapshot(after),
  usage: { read: weight + 100, cached: 100, out: 0 },
});

test('本地日历范围包含下边界、排除前一秒与未来；只按结束时间归日，不算在跑和排队', () => {
  const jobs = [job('before', { ended: at(29, 23, 59, 59) }), job('zero', { ended: at(30) }),
    job('at-now', { ended: new Date(now).toISOString() }), job('future', { ended: at(30, 12, 0, 1) }),
    job('running', { state: 'running' }), job('queued', { state: 'queued' }),
    job('seventh', { created: at(20), started: at(20), ended: at(24) }), job('eighth', { ended: at(23, 23, 59, 59) }),
    job('thirtieth', { ended: at(1) }), job('outside-month', { ended: at(0, 23, 59, 59) })];
  const today = dashboard(jobs, 'today', '', now), week = dashboard(jobs, '7d', '', now), month = dashboard(jobs, '30d', '', now);
  assert.equal(today.kpi.jobs, 2); assert.equal(today.from, at(30)); assert.equal(today.to, new Date(now).toISOString());
  assert.equal(week.from, at(24)); assert.equal(week.kpi.jobs, 4); assert.equal(week.daily.length, 7);
  assert.deepEqual(week.daily.map(d => d.jobs), [1, 0, 0, 0, 0, 1, 2]);
  assert.equal(month.from, at(1)); assert.equal(month.daily.length, 30); assert.equal(month.kpi.jobs, 6);
  const fallback = dashboard([job('started', { ended: undefined }), job('created', { ended: undefined, started: undefined })], 'today', '', now);
  assert.equal(fallback.kpi.jobs, 2);
});

test('评分和返工复用档案口径，采用率只除拍板件数，用时扣重叠休眠且只算 done', () => {
  const jobs = [job('five', { rating: rating({ score: 5 }), decision: { kind: 'adopt', by: 'lead', at: at(30, 10) },
    sleeps: [{ from: at(30, 8, 10), to: at(30, 8, 30) }, { from: at(30, 8, 20), to: at(30, 8, 40) }] }),
    job('three', { state: 'failed', rating: rating({ score: 3, tags: ['需要返工'] }), decision: { kind: 'drop', by: 'lead', at: at(30, 10) } }),
    job('external-score', { state: 'stopped', rating: rating({ score: 1, external: '网络故障', tags: ['需要返工'] }) }),
    job('external-only', { state: 'lost', rating: rating({ score: undefined, external: '停电', tags: ['需要返工'] }) }),
    job('unrated', { ended: at(30, 8, 10), cleaned: at(30, 10) })];
  const before = structuredClone(jobs), d = dashboard(jobs, 'today', '', now), p = profiles(jobs)[0];
  assert.equal(d.kpi.jobs, 5); assert.equal(d.kpi.done, 2); assert.equal(d.kpi.failed, 3);
  assert.equal(d.kpi.adoptRate, 1 / 2); assert.equal(d.kpi.avgScore, 4); assert.equal(d.kpi.avgScore, p.avgScore);
  assert.equal(d.workers[0].reworkRate, 2 / 3); assert.equal(d.workers[0].reworkRate, p.reworkRate);
  assert.equal(d.kpi.seconds, 2400); assert.equal(d.workers[0].medianSeconds, 1200); assert.equal(d.projects[0].seconds, 2400);
  assert.deepEqual(jobs, before);
  const empty = dashboard([], 'today', '', now);
  assert.equal(empty.kpi.adoptRate, null); assert.equal(empty.kpi.avgScore, null); assert.deepEqual(empty.workers, []);
  assert.deepEqual(empty.daily, [{ day: '2026-09-30', jobs: 0, tokens: { fresh: 0, cached: 0, out: 0 } }]);
});

test('token 缺记录不混入中位数，fresh 不为负；项目排序和选手顺序确定', () => {
  const jobs = [job('big', { project: '乙', who: 'grok', usage: { read: 1000, cached: 100, out: 100 } }),
    job('clamped', { project: '乙', who: 'grok', usage: { read: 2, cached: 10, out: 0 }, state: 'failed' }),
    job('missing', { project: '乙', who: 'grok' }), job('a', { project: '甲' }), job('b', { project: '丙', who: 'cursor-grok' })];
  const d = dashboard(jobs, '7d', '', now), grok = d.workers.find(w => w.who === 'grok')!;
  assert.equal(d.kpi.jobs, 5); assert.equal(d.kpi.withoutUsage, 3);
  assert.deepEqual(d.kpi.tokens, { fresh: 900, cached: 110, out: 100 });
  assert.deepEqual(grok.medianTokens, { fresh: 450, cached: 55, out: 50 }); assert.equal(grok.withoutUsage, 1);
  assert.equal(d.workers[0].medianTokens, null); assert.equal(d.workers[0].adoptRate, null);
  assert.deepEqual(d.workers.map(w => w.who), whos.filter(w => jobs.some(j => j.who === w)));
  assert.deepEqual(d.projects.map(p => p.name), ['乙', ...['甲', '丙'].sort((a, b) => a.localeCompare(b, 'zh-CN'))]);
  assert.deepEqual(d.daily.at(-1)!.tokens, d.kpi.tokens);
  const filtered = dashboard(jobs, '7d', '乙', now);
  assert.equal(filtered.kpi.jobs, 3); assert.deepEqual(filtered.projects, []); assert.deepEqual(filtered.kpi.tokens, d.kpi.tokens);
});

test('单件额度复用 quotaDelta；重叠按 fresh + out 分摊，缓存不参与权重', () => {
  const a = metered('a', 'codex', 8, 10, 10, 14, 10), b = metered('b', 'codex-luna', 9, 11, 11, 18, 30);
  const one = dashboard([a], 'today', '', now);
  assert.equal(one.workers[0].avgPoints, 4); assert.equal(quotaDelta(a), '周额度 +4.0%');
  b.usage = { read: 110, cached: 100, out: 20 };
  const d = dashboard([b, a], 'today', '', now);
  assert.deepEqual(d.kpi.pools, [{ pool: 'Codex · 周额度', points: 8, jobs: 2 }]);
  assert.deepEqual(d.workers.map(w => w.avgPoints), [2, 6]);
  assert.deepEqual(dashboard([a, b], 'today', '', now), d);
  b.project = '乙';
  assert.equal(dashboard([a, b], 'today', '甲', now).kpi.pools[0].points, 4);
  assert.deepEqual(dashboard([a, b], 'today', '不存在', now).kpi.pools, []);
});

test('闭区间端点相交和传递重叠合成一组，分离组求和，单件平均采用分摊值', () => {
  const jobs = [metered('a', 'codex', 6, 8, 0, 4, 10), metered('b', 'codex', 8, 9, 3, 6, 10),
    metered('c', 'codex', 9, 10, 5, 9, 10), metered('d', 'codex', 11, 12, 10, 12, 10)];
  const d = dashboard(jobs, 'today', '', now);
  assert.equal(d.kpi.pools[0].points, 11); assert.equal(d.workers[0].avgPoints, 2.75); // (3+3+3+2)/4
});

test('缺 token 的整个重叠组不分摊，但快照可算的池总额保留；零权重不除零', () => {
  const a = metered('a', 'codex', 8, 10, 10, 14, 10), b = metered('b', 'codex-luna', 9, 11, 11, 18, 30);
  delete b.usage;
  const d = dashboard([a, b], 'today', '', now);
  assert.deepEqual(d.workers.map(w => w.avgPoints), [null, null]); assert.equal(d.kpi.pools[0].points, 8);
  assert.equal(dashboard([b], 'today', '', now).workers[0].avgPoints, null);
  a.usage = b.usage = { read: 100, cached: 100, out: 0 };
  assert.deepEqual(dashboard([a, b], 'today', '', now).workers.map(w => w.avgPoints), [null, null]);
  a.quota_before = a.quota_after = b.quota_before = b.quota_after = snapshot(10);
  assert.deepEqual(dashboard([a, b], 'today', '', now).workers.map(w => w.avgPoints), [0, 0]);
});

test('跨周期、约数、负差值、缺快照、查询错误均不算额度；坏组不吞掉好组', () => {
  const a = metered('a', 'codex', 8, 9, 10, 14, 10);
  for (const after of [snapshot(14, { reset: at(36) }), snapshot(14, { reset: null }), snapshot(14, { approx: true }), snapshot(9), snapshot(14, { used: null }), null]) {
    const bad = { ...a, quota_after: after }, d = dashboard([bad], 'today', '', now);
    assert.equal(d.workers[0].avgPoints, null); assert.equal(d.kpi.pools[0].points, null); assert.equal(quotaDelta(bad), null);
  }
  const broken = snapshot(14); broken.providers[0].error = '查询失败';
  assert.equal(dashboard([{ ...a, quota_after: broken }], 'today', '', now).kpi.pools[0].points, null);
  const missing = job('missing');
  assert.deepEqual(dashboard([missing], 'today', '', now).kpi.pools, [{ pool: 'Codex · 周额度', points: null, jobs: 1 }]);
  const good = metered('good', 'codex', 10, 11, 20, 23, 10);
  assert.equal(dashboard([{ ...a, quota_after: null }, good], 'today', '', now).kpi.pools[0].points, 3);
  const overlap = metered('overlap', 'codex-luna', 8, 10, 12, 16, 10); overlap.quota_after = snapshot(16, { reset: at(36) });
  assert.deepEqual(dashboard([a, overlap], 'today', '', now).workers.map(w => w.avgPoints), [null, null]);
});

test('不同厂家互不影响，Cursor 两个池分开，同池不同选手共享组', () => {
  const jobs = [metered('codex', 'codex', 8, 10, 10, 12, 1), metered('grok', 'grok', 8, 10, 10, 15, 1),
    metered('auto', 'cursor-grok', 8, 10, 10, 17, 1), metered('api-a', 'cursor-opus', 8, 10, 10, 16, 1),
    metered('api-b', 'cursor-sonnet', 9, 11, 11, 18, 3)];
  const d = dashboard(jobs, 'today', '', now);
  assert.deepEqual(d.kpi.pools, [
    { pool: 'Codex · 周额度', points: 2, jobs: 1 }, { pool: 'Cursor · 其他模型池', points: 8, jobs: 2 },
    { pool: 'Cursor · 自家模型池', points: 7, jobs: 1 }, { pool: 'Grok · 本期额度', points: 5, jobs: 1 },
  ]);
  assert.deepEqual(d.workers.map(w => w.avgPoints), [2, 5, 7, 2, 6]);
});

test('夏令时切换仍按本地日历连续列出七天', async () => {
  const source = `import { dashboard } from './src/core/dashboard.ts';
    console.log(JSON.stringify(dashboard([], '7d', '', new Date(2026, 2, 10, 12).getTime())));`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', source], root, { ...process.env, TZ: 'America/New_York' });
  assert.equal(result.code, 0, result.stderr);
  const d = JSON.parse(result.stdout);
  assert.equal(d.from, '2026-03-04T05:00:00.000Z');
  assert.deepEqual(d.daily.map((row: { day: string }) => row.day), ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
});

test('report 中文块、万与一位小数，JSON 原样等于核心；已归档项目和已清理记录也统计，读取不改任务', async t => {
  const c = await context(t, false);
  assert.equal((await c.cli(['report'])).code, 0);
  const current = new Date(); current.setHours(0, 0, 0, 0);
  const ended = current.toISOString();
  const jobs = [job('archived', { project: '已归档', started: current.toISOString(), ended, cleaned: ended,
    usage: { read: 30000, cached: 10000, out: 12000 }, rating: rating({ score: 5 }),
    decision: { kind: 'adopt', by: 'lead', at: ended }, quota_before: snapshot(10), quota_after: snapshot(12.5) }),
    job('other', { project: '其他', started: current.toISOString(), ended, state: 'failed' })];
  const settingsPath = join(c.home, 'config.json');
  await writeFile(settingsPath, JSON.stringify({ archivedProjects: ['已归档'] }));
  for (const j of jobs) { await mkdir(join(c.home, 'jobs', j.id)); await writeFile(join(c.home, 'jobs', j.id, 'job.json'), JSON.stringify(j)); }
  for (const range of ['today', '7d', '30d'] as const) for (const project of ['', '已归档']) {
    const result = await c.cli(['report', '--range', range, ...(project ? ['--project', project] : []), '--json']);
    assert.equal(result.code, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual, dashboard(jobs, range, project, Date.parse(actual.to)));
    assert.equal(actual.kpi.jobs, project ? 1 : 2);
  }
  const result = await c.cli(['report']); assert.equal(result.code, 0, result.stderr);
  for (const text of ['近 7 天', '含已归档', '汇总', '件数', '采用率', '平均分', '总用时', '新读', '缓存命中', '写出', '各池额度', '各家对比', '每天', '按项目', '（按用量分摊）', '2 万', '1.2 万', '2.5 个百分点', '100.0%']) assert.ok(result.stdout.includes(text), text);
  assert.match(formatReport(dashboard([], 'today', '', now)), /暂无记录/);
  assert.match((await c.cli(['report', '--range', 'week'])).stderr, /只能填写 today（今天）、7d（近 7 天）或 30d/);
  for (const args of [['report', '--range'], ['report', '--range', 'week'], ['report', '--unknown'], ['report', 'extra']]) assert.equal((await c.cli(args)).code, 1);
  assert.match((await c.cli(['--help'])).stdout, /xagents report \[--range today\|7d\|30d\]/);
  assert.equal((await c.cli(['report', '--help'])).code, 0);
  for (const j of jobs) assert.equal(await readFile(join(c.home, 'jobs', j.id, 'job.json'), 'utf8'), JSON.stringify(j));
});
