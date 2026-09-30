import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJob, readJob, updateJob } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { rate } from '../src/core/rate.ts';
import type { RateOptions } from '../src/core/rate.ts';
import { ensureHome } from '../src/core/paths.ts';
import { withLock, writeJson } from '../src/core/fsx.ts';
import { context } from './helpers.ts';

async function registry(t: TestContext, repository = false) {
  const c = await context(t, repository), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  await ensureHome();
  const add = async (id: string, extra: Partial<Job> = {}) => {
    const job: Job = { id, batch: 'batch', project: '测试', repo: c.repo, base: c.base, worktree: join(c.temp, id), branch: `xa/${id}`,
      who: 'codex', model: 'test', effort: 'high', mode: 'workspace-write', kind: '实现', title: id, summary: '测试评价',
      state: 'done', created: '2026-09-30T00:00:00Z', started: '2026-09-30T00:00:00Z', ended: '2026-09-30T00:01:00Z', seconds: 60, ...extra };
    await createJob(job); return job;
  };
  return { ...c, add };
}

test('rate 只接受四种已结束状态；非法分数、文字、标签不改变原评价', async t => {
  const c = await registry(t);
  for (const state of ['queued', 'running', 'done', 'failed', 'stopped', 'lost'] as const) {
    await c.add(state, { state });
    if (state === 'queued' || state === 'running') {
      await assert.rejects(rate(state, { score: 4 }), /还没结束/);
      assert.equal((await readJob(state)).rating, undefined);
    } else assert.equal((await rate(state, { score: 4 })).rating?.score, 4);
  }
  const file = join(c.home, 'jobs/done/job.json'), before = await readFile(file, 'utf8');
  const invalid: RateOptions[] = [
    {}, { good: '没有分数' }, { external: '  ' },
    ...[0, 6, -1, 2.5, NaN, Infinity, '4', null].map(score => ({ score } as RateOptions)),
    { score: 4, tags: Array.from({ length: 9 }, (_, i) => `标签${i}`) },
    { score: 4, tags: [''] }, { score: 4, tags: [' '] }, { score: 4, tags: ['字'.repeat(13)] },
    { score: 4, tags: [42] } as unknown as RateOptions,
    { score: 4, tags: '标签' } as unknown as RateOptions,
  ];
  for (const field of ['good', 'improve', 'external'] as const) {
    for (const value of ['字'.repeat(201), '😀'.repeat(201), '控制\n字符', '控制\t字符', '控制\x00字符', '控制\x7f字符', '控制\x85字符', 42]) {
      invalid.push({ score: 4, [field]: value });
    }
  }
  for (const tag of ['换\n行', 'a\x00b', 'a\x7fb', 'a\x85b', '😀'.repeat(13)]) invalid.push({ score: 4, tags: [tag] });
  for (const options of invalid) {
    await assert.rejects(rate('done', options), /分数|score|标签|200 字/);
    assert.equal(await readFile(file, 'utf8'), before);
  }
  await assert.rejects(rate('missing', { score: 4 }), /找不到任务/);
  await assert.rejects(rate('../outside', { score: 4 }), /名字/);
});

test('rate 接受边界长度、标签去重和仅外部原因；每次替换完整评价', async t => {
  const c = await registry(t); await c.add('one');
  const tags = ['速度快', '速度快', ' 主动发现问题 ', '😀'.repeat(12), '甲', '乙', '丙', '丁'];
  let j = await rate('one', { score: 5, good: '😀'.repeat(200), improve: '字'.repeat(200), tags, external: '字'.repeat(200) });
  assert.deepEqual(j.rating?.tags, ['速度快', '主动发现问题', '😀'.repeat(12), '甲', '乙', '丙', '丁']);
  assert.equal(j.rating?.by, 'lead'); assert.ok(Number.isFinite(Date.parse(j.rating!.at)));
  j = await rate('one', { external: ' 网络故障 ' });
  assert.equal(j.rating?.external, '网络故障'); assert.equal(j.rating?.score, undefined);
  assert.equal(j.rating?.good, undefined); assert.equal(j.rating?.improve, undefined); assert.deepEqual(j.rating?.tags, []);
  assert.equal(j.rating?.previous?.[0].score, 5); assert.equal(j.rating?.previous?.[0].external, '字'.repeat(200));
});

test('改分只保留最近 5 版，旧评价不嵌套；并发改分不丢失其他任务字段', async t => {
  const c = await registry(t); await c.add('one');
  for (let i = 0; i < 8; i++) await rate('one', { score: 4, good: `第${i}版`, tags: ['报告老实'] });
  let j = await readJob('one');
  assert.equal(j.rating?.good, '第7版');
  assert.deepEqual(j.rating?.previous?.map(r => r.good), ['第2版', '第3版', '第4版', '第5版', '第6版']);
  assert.ok(j.rating?.previous?.every(r => !('previous' in r) && r.by === 'lead' && r.tags[0] === '报告老实'));
  await c.add('parallel');
  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => rate('parallel', { score: 3, good: `并发${i}` })),
    updateJob('parallel', job => { job.comments = [{ by: 'owner', text: '保留留言', at: new Date().toISOString() }]; }),
  ]);
  j = await readJob('parallel');
  assert.equal(new Set([j.rating!.good, ...j.rating!.previous!.map(r => r.good)]).size, 6);
  assert.equal(j.comments?.[0].text, '保留留言');
});

test('rate 在锁内检查最新状态，不能用等待前的已结束状态覆盖记录', async t => {
  const c = await registry(t); const job = await c.add('one');
  let pending: Promise<Job>;
  await withLock(join(c.home, 'jobs/one'), async () => {
    pending = rate('one', { score: 5 });
    await writeJson(join(c.home, 'jobs/one/job.json'), { ...job, state: 'running' });
  });
  await assert.rejects(pending!, /还没结束/);
  assert.equal((await readJob('one')).rating, undefined);
});

test('rate 命令解析重复标签、仅外部原因与改分；拒绝非法参数和未结束任务', async t => {
  const c = await registry(t); await c.add('one'); await c.add('live', { state: 'running' });
  let result = await c.cli(['rate', 'one', '--score', '4', '--good', '做对了', '--improve', '补测试', '--tag', '速度快', '--tag', '速度快']);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /已记下评价：one/);
  assert.deepEqual((await readJob('one')).rating?.tags, ['速度快']);
  result = await c.cli(['rate', 'one', '--external', '网络故障']);
  assert.equal(result.code, 0, result.stderr); assert.equal((await readJob('one')).rating?.previous?.[0].score, 4);
  const before = (await readJob('one')).rating;
  for (const args of [
    ['one'], ['one', '--score'], ['one', '--score', '2.5'], ['one', '--score', 'NaN'], ['one', '--score', '0'], ['one', '--score', '6'],
    ['one', '--score', '4', '--score', '5'], ['one', '--external', ' '], ['one', '--good', '只有评语'],
    ['one', '--external', '换\n行'], ['one', '--score', '4', '--tag', ''], ['one', '--score', '4', '--json'],
    ['one', 'extra', '--score', '4'], ['--score', '4'], ['live', '--score', '4'], ['../outside', '--score', '4'],
  ]) assert.equal((await c.cli(['rate', ...args])).code, 1, JSON.stringify(args));
  assert.deepEqual((await readJob('one')).rating, before);
  const help = await c.cli(['--help']); assert.match(help.stdout, /xagents rate/); assert.match(help.stdout, /xagents profiles \[--json\]/);
});

test('清理整批先列出全部缺评价的已拍板任务；有评分或仅 external 放行，没拍板照旧', async t => {
  const c = await registry(t, true);
  const jobs = [await c.add('plain'), await c.add('adopt', { decision: { kind: 'adopt', at: '2026-09-30T00:02:00Z', by: 'owner' } }),
    await c.add('drop', { decision: { kind: 'drop', at: '2026-09-30T00:02:00Z', by: 'lead' } })];
  for (const job of jobs) {
    await c.git(['worktree', 'add', '-b', job.branch, job.worktree, c.base]);
    await writeFile(join(job.worktree, 'change.txt'), '保留改动\n');
  }
  await writeJson(join(c.home, 'batches/batch.json'), { id: 'batch', jobs: jobs.map(j => j.id) });
  let result = await c.cli(['clean', 'batch']);
  assert.equal(result.code, 1); assert.match(result.stderr, /adopt、drop/); assert.match(result.stderr, /先 xagents rate/);
  for (const job of jobs) { await access(job.worktree); assert.equal((await readJob(job.id)).cleaned, undefined); }
  assert.equal((await c.cli(['clean', 'adopt'])).code, 1);
  result = await c.cli(['clean', 'plain']); assert.equal(result.code, 0, result.stderr);
  result = await c.cli(['clean', '--done']); assert.equal(result.code, 1); assert.match(result.stderr, /drop/);
  await rate('drop', { external: '网络故障' });
  result = await c.cli(['clean', '--done']); assert.equal(result.code, 0, result.stderr);
  await access(jobs[1].worktree); assert.ok((await readJob('drop')).cleaned);
  await rate('adopt', { score: 5 });
  result = await c.cli(['clean', 'batch']); assert.equal(result.code, 0, result.stderr);
  for (const job of jobs) {
    assert.ok((await readJob(job.id)).cleaned); await assert.rejects(access(job.worktree));
    assert.match(await readFile(join(c.home, 'jobs', job.id, 'diff.patch'), 'utf8'), /保留改动/);
  }
  assert.equal((await readJob('adopt')).rating?.score, 5);
});
