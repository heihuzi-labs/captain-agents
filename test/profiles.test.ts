import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, Rating } from '../src/core/job.ts';
import { profiles } from '../src/core/profiles.ts';
import { stats } from '../src/core/stats.ts';
import { profilesTable } from '../src/cli/profiles.ts';
import { statusTable } from '../src/cli/format.ts';
import { describeTiming, timeSplit } from '../src/core/duration.ts';
import { context, desktopView } from './helpers.ts';

const at = (seconds: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + seconds * 1000).toISOString();
const rating = (extra: Partial<Rating> = {}): Rating => ({ score: 4, tags: [], at: at(100), by: 'lead', ...extra });
const job = (id: string, extra: Partial<Job> = {}): Job => ({ id, batch: 'batch', project: 'test', repo: '/unused', base: 'test',
  worktree: '/unused', branch: `xa/${id}`, who: 'codex', model: 'test', effort: 'high', mode: 'read-only', kind: '实现', title: `题目 ${id}`,
  summary: '档案测试', state: 'done', created: at(0), started: at(0), ended: at(600), seconds: 600, ...extra });

test('档案按选手、快速版和类型汇总结束任务；外部原因不进平均分，返工分母为有分数件数', () => {
  const jobs = [
    job('five', { rating: rating({ score: 5, tags: ['一次做对'] }), sleeps: [{ from: at(100), to: at(300) }, { from: at(200), to: at(400) }] }),
    job('three', { rating: rating({ score: 3, tags: ['需要返工'] }), state: 'failed' }),
    job('external-score', { rating: rating({ score: 1, external: '网络故障', tags: ['需要返工'] }), state: 'stopped' }),
    job('external', { rating: rating({ score: undefined, external: '电脑休眠', tags: ['需要返工'] }), state: 'lost' }),
    job('unrated', { seconds: 100, ended: at(100), cleaned: at(700) }),
    job('running', { state: 'running', rating: rating({ score: 1 }) }), job('queued', { state: 'queued' }),
    job('fast', { fast: true, seconds: 20, rating: rating({ score: 2 }) }),
    job('other-kind', { kind: '调研' }), job('other-who', { who: 'grok', state: 'failed' }),
  ];
  const before = structuredClone(jobs), rows = profiles(jobs), ordinary = rows.find(r => r.who === 'codex' && !r.fast && r.kind === '实现')!;
  assert.equal(rows.length, 4); assert.equal(ordinary.count, 5); assert.equal(ordinary.rated, 3);
  assert.equal(ordinary.avgScore, 4); assert.equal(ordinary.reworkRate, 2 / 3); assert.equal(ordinary.small, false);
  assert.equal(ordinary.avgSeconds, 200);
  const fast = rows.find(r => r.fast)!;
  assert.equal(fast.count, 1); assert.equal(fast.avgScore, 2); assert.equal(fast.avgSeconds, 20); assert.equal(fast.small, true);
  const other = rows.find(r => r.who === 'grok')!;
  assert.equal(other.avgScore, null); assert.equal(other.reworkRate, null); assert.equal(other.avgSeconds, null); assert.equal(other.rated, 0);
  for (const row of rows) assert.equal(row.avgSeconds, stats(jobs).find(s => s.who === row.who && s.fast === row.fast && s.kind === row.kind)!.averageSeconds);
  assert.deepEqual(jobs, before, '纯函数不修改任务或评价');
  assert.deepEqual(profiles([]), []); assert.deepEqual(profiles([job('live', { state: 'running' })]), []);
  const externalOnly = profiles([job('external', { rating: rating({ score: undefined, external: '网络故障' }) })])[0];
  assert.equal(externalOnly.rated, 0); assert.equal(externalOnly.avgScore, null); assert.equal(externalOnly.reworkRate, null); assert.equal(externalOnly.small, true);
  const withExternal = profiles([job('external', { rating: rating({ external: '网络故障' }) })])[0];
  assert.equal(withExternal.rated, 1); assert.equal(withExternal.avgScore, null);
  assert.equal(profiles([job('one', { rating: rating() }), job('two', { rating: rating() }), job('three')])[0].small, true);
});

test('优点毛病各取前三、次数降序同次数按中文排序；其他标签不混入，每件标签只计一次', () => {
  const good = ['一次做对', '速度快', '主动发现问题', '报告老实', '代码规整', '考虑周到'];
  const bad = ['需要返工', '夸大结论', '留多余文件', '测试没打到真实环境', '越界改动', '偏慢', '前提错误'];
  for (const tag of good) assert.deepEqual(profiles([job(tag, { rating: rating({ tags: [tag] }) })])[0].good, [{ tag, n: 1 }]);
  for (const tag of bad) assert.deepEqual(profiles([job(tag, { rating: rating({ tags: [tag] }) })])[0].bad, [{ tag, n: 1 }]);
  const jobs = [job('all', { rating: rating({ tags: ['速度快', '速度快', '一次做对', '考虑周到', '报告老实', '偏慢', '前提错误', '需要返工', '夸大结论', '自定标签'] }) }),
    job('again', { rating: rating({ tags: ['速度快', '需要返工', '自定标签'], previous: [rating({ tags: ['夸大结论'] })] }) })];
  const p = profiles(jobs)[0];
  assert.deepEqual(p.good, [{ tag: '速度快', n: 2 }, ...['一次做对', '考虑周到', '报告老实'].sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, 2).map(tag => ({ tag, n: 1 }))]);
  assert.deepEqual(p.bad, [{ tag: '需要返工', n: 2 }, ...['偏慢', '前提错误', '夸大结论'].sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, 2).map(tag => ({ tag, n: 1 }))]);
  assert.deepEqual(profiles([...jobs].reverse()), [p], '排序不依赖输入顺序');
  const custom = profiles([job('custom', { rating: rating({ tags: ['自定标签'] }) })])[0];
  assert.deepEqual(custom.good, []); assert.deepEqual(custom.bad, []);
});

test('最近 5 条按当前评价时间排序，只收有评语的；同时间按任务号稳定排序，不混历史', () => {
  const jobs = Array.from({ length: 7 }, (_, i) => job(`id-${i}`, { rating: rating({ at: at(i), good: `评语${i}`, score: 4 }) }));
  jobs.push(job('score-only', { rating: rating({ at: at(999) }) }), job('empty-comment', { rating: rating({ good: ' ', at: at(999) }) }),
    job('external-only', { rating: rating({ score: undefined, external: '网络故障', at: at(999) }) }),
    job('with-improve', { rating: rating({ score: undefined, external: '网络故障', improve: '报告要说明环境', at: at(8), previous: [rating({ good: '旧版' })] }) }),
    job('same-time', { rating: rating({ good: '同一时间', at: at(6) }) }));
  const before = structuredClone(jobs), recent = profiles(jobs)[0].recent;
  assert.deepEqual(recent.map(r => r.id), ['with-improve', 'id-6', 'same-time', 'id-5', 'id-4']);
  assert.deepEqual(recent[0], { id: 'with-improve', title: '题目 with-improve', at: at(8), improve: '报告要说明环境' });
  assert.equal(recent[1].score, 4); assert.equal(recent[1].good, '评语6'); assert.deepEqual(jobs, before);
});

test('profiles 表格有中文列、空值和少样本提醒；普通快速版分开', () => {
  const rows = profiles([job('normal', { rating: rating({ score: 5, tags: ['报告老实', '偏慢'] }) }), job('fast', { fast: true, state: 'failed' })]);
  const output = profilesTable(rows);
  for (const text of ['选手', '类型', '件数', '平均分', '返工比例', '平均用时', '平均步数', '跑命令', '优点', '毛病', '5.0 分', '0.0%', '600.0 秒', '报告老实（1）', '偏慢（1）', 'codex（快速版）', '—', '样本少，仅供参考']) assert.ok(output.includes(text), text);
  assert.match(profilesTable([]), /还没有已结束/);
});

test('profiles 命令与 --json 汇总清理后的历史，看板含同形档案且 stats 保持原样，读取不落盘', async t => {
  const c = await context(t, false);
  let result = await c.cli(['profiles', '--json']); assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), []);
  const jobs = [job('normal', { rating: rating({ good: '做得好', tags: ['一次做对'] }), cleaned: at(700), timing: { steps: 45, toolSeconds: 30 } }), job('fast', { fast: true })];
  for (const j of jobs) { await mkdir(join(c.home, 'jobs', j.id)); await writeFile(join(c.home, 'jobs', j.id, 'job.json'), JSON.stringify(j)); }
  result = await c.cli(['profiles', '--json']); assert.equal(result.code, 0, result.stderr);
  const rows = JSON.parse(result.stdout); assert.deepEqual(rows, profiles(jobs));
  assert.equal(rows.find((r: any) => !r.fast).avgSteps, 45);
  assert.equal(rows.find((r: any) => !r.fast).avgToolSeconds, 30);
  assert.equal(rows.find((r: any) => r.fast).avgSteps, null);
  assert.equal(rows.find((r: any) => r.fast).avgToolSeconds, null);
  result = await c.cli(['profiles']); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /样本少，仅供参考/); assert.match(result.stdout, /4.0 分/);
  for (const text of ['平均步数', '跑命令', '45.0', '30.0 秒']) assert.ok(result.stdout.includes(text), text);
  result = await c.cli(['status', '--all']); assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(describeTiming(timeSplit(jobs[0]))!));
  assert.equal(result.stdout.split('\n').filter(s => s.includes('共 45 步')).length, 1);
  for (const args of [['profiles', 'extra'], ['profiles', '--unknown'], ['profiles', '--json', 'extra']]) assert.equal((await c.cli(args)).code, 1);
  const view = await desktopView(c.home);
  assert.deepEqual(view.profiles, rows); assert.deepEqual(view.stats, stats(jobs));
  assert.deepEqual(Object.keys(view.profiles[0]).sort(), ['who', 'fast', 'kind', 'count', 'rated', 'avgScore', 'reworkRate', 'avgSeconds', 'avgToolSeconds', 'avgSteps', 'good', 'bad', 'recent', 'small'].sort());
  for (const j of jobs) assert.equal(await readFile(join(c.home, 'jobs', j.id, 'job.json'), 'utf8'), JSON.stringify(j));
});

test('平均工具秒数和步数只算 done 且有计时的任务，零值是样本，缺记录不是零', () => {
  const timed = (steps: number, toolSeconds: number) => ({ steps, toolSeconds });
  const rows = profiles([job('one', { timing: timed(3, 10) }), job('two', { timing: timed(4, 20) }), job('legacy'),
    ...(['failed', 'lost', 'stopped', 'queued', 'running'] as const).map(state => job(state, { state, timing: timed(1000, 1000) })),
    job('fast-zero', { fast: true, timing: timed(0, 0) }), job('grok-legacy', { who: 'grok' }),
    job('failed-only', { who: 'cursor-opus', state: 'failed', timing: timed(10, 20) })]);
  const normal = rows.find(r => r.who === 'codex' && !r.fast)!;
  assert.equal(normal.avgSteps, 3.5); assert.equal(normal.avgToolSeconds, 15);
  const fast = rows.find(r => r.fast)!;
  assert.equal(fast.avgSteps, 0); assert.equal(fast.avgToolSeconds, 0);
  for (const row of rows.filter(r => r.who !== 'codex')) {
    assert.equal(row.avgSteps, null); assert.equal(row.avgToolSeconds, null);
  }
});

test('status 每件有记录的任务下显示共用人话，老任务没有额外行', () => {
  const jobs = [job('timed', { timing: { steps: 45, toolSeconds: 30 } }), job('legacy'), job('zero', { timing: { steps: 0, toolSeconds: 0 } })];
  const lines = statusTable(jobs).split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[2], `  ${describeTiming(timeSplit(jobs[0]))}`);
  assert.ok(lines[3].includes('legacy'));
  assert.equal(lines[5], `  ${describeTiming(timeSplit(jobs[2]))}`);
  jobs[0].error = '失败原因\n错误详情';
  const multiline = statusTable(jobs);
  assert.ok(multiline.includes(`错误详情\n  ${describeTiming(timeSplit(jobs[0]))}`));
  assert.ok(multiline.endsWith(`  ${describeTiming(timeSplit(jobs[2]))}`));
});
