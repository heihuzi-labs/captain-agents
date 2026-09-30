import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { buildView } from '../src/core/view.ts';
import { interruption, listJobs, reconcile } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { writeJson } from '../src/core/fsx.ts';
import { reconcileSafely } from '../src/core/runner.ts';
import { notices } from '../app/main/notifications.ts';

async function registry(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'xa-view-state-'));
  const previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, 'jobs'));
  await mkdir(join(home, 'batches'));
  return home;
}
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, batch: '', project: '测试', repo: '/unused', base: 'base', worktree: '/unused', branch: 'test',
  who: 'codex', model: 'test', effort: 'high', mode: 'read-only', kind: '修复', title: id, summary: '测试说明',
  state: 'running', created: '2026-09-29T00:00:00Z', started: '2026-09-29T00:00:01Z', ...extra,
});
async function save(home: string, record: Job) {
  const dir = join(home, 'jobs', record.id); await mkdir(dir);
  const file = join(dir, 'job.json'); await writeJson(file, record); return file;
}

test('已不存在的看管 PID 显示失联，读取不改文件、时间戳或生成锁，失联不发通知', async t => {
  const home = await registry(t);
  const record = job('lost', { pid: 2147483647 });
  const file = await save(home, record), before = await readFile(file, 'utf8'), info = await stat(file);
  const view = await buildView();
  assert.equal(view.jobs[0].state, 'lost');
  assert.equal(notices(view).length, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await stat(file)).mtimeMs, info.mtimeMs);
  assert.deepEqual(await readdir(join(home, 'jobs/lost')), ['job.json']);
  assert.equal(record.state, 'running');
  assert.equal((await reconcile(record)).state, 'lost');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'lost');
});

test('判断保留存活任务、准备任务、已结束任务和主动停下语义', () => {
  assert.equal(interruption(job('live', { pid: process.pid })), undefined);
  assert.equal(interruption(job('done', { state: 'done' }), () => false), undefined);
  assert.equal(interruption(job('stopped', { stopRequested: true }), () => false)?.state, 'stopped');
  assert.equal(interruption(job('queued', { state: 'queued' }), () => false)?.state, 'failed');
  assert.equal(interruption(job('queued', { state: 'queued', queuedBy: 123 }), pid => pid === 123), undefined);
});

test('坏任务和坏批次逐条跳过，其余记录照常显示且坏文件保持原样', async t => {
  const home = await registry(t);
  await save(home, job('good', { state: 'done' }));
  for (const [id, raw] of [['empty', ''], ['partial', '{"id":'], ['null', 'null']]) {
    await mkdir(join(home, 'jobs', id)); await writeFile(join(home, 'jobs', id, 'job.json'), raw);
    await writeFile(join(home, 'batches', `${id}.json`), raw);
  }
  await writeJson(join(home, 'batches/good.json'), { id: 'good', jobs: ['good'], started: '2026-09-29', title: '有效批次' });
  assert.deepEqual((await listJobs()).map(j => j.id), ['good']);
  const view = await buildView();
  assert.deepEqual(view.jobs.map(j => j.id), ['good']);
  assert.deepEqual(view.batches.map(b => b.id), ['good']);
  assert.equal(await readFile(join(home, 'jobs/partial/job.json'), 'utf8'), '{"id":');
  assert.equal(await readFile(join(home, 'batches/partial.json'), 'utf8'), '{"id":');
});

test('登记处整体读取失败仍抛错，交给应用错误提示', async t => {
  const home = await registry(t);
  await rm(join(home, 'jobs'), { recursive: true }); await writeFile(join(home, 'jobs'), '不是目录');
  await assert.rejects(buildView(), { code: 'ENOTDIR' });
});

test('状态修正仍把失联和派发中断写回记录，保留存活任务，不生成网页文件', async t => {
  const home = await registry(t);
  const lost = await save(home, job('lost', { pid: 2147483647 }));
  const queued = await save(home, job('queued', { state: 'queued', started: undefined }));
  const live = await save(home, job('live', { pid: process.pid }));
  const before = await readFile(live, 'utf8');
  await reconcileSafely();
  const lostRecord = JSON.parse(await readFile(lost, 'utf8'));
  const queuedRecord = JSON.parse(await readFile(queued, 'utf8'));
  assert.equal(lostRecord.state, 'lost'); assert.ok(lostRecord.ended); assert.match(lostRecord.error, /看管进程/);
  assert.equal(queuedRecord.state, 'failed'); assert.ok(queuedRecord.ended); assert.match(queuedRecord.error, /派发进程/);
  assert.equal(await readFile(live, 'utf8'), before);
  assert.deepEqual((await readdir(home)).sort(), ['batches', 'jobs']);
  assert.deepEqual(await readdir(join(home, 'jobs/lost')), ['job.json']);
});
