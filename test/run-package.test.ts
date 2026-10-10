import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { context, root } from './helpers.ts';
import { prepareRun, prunePackages, usePreparedRun } from '../src/core/run-package.ts';
import { command, resumeCommand, selection } from '../src/core/workers.ts';
import { codexPermissions, sandbox } from '../src/core/sandbox.ts';
import { jobDir } from '../src/core/paths.ts';
import { createJob, readJob, updateJob } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { resumeMember } from '../src/core/wake.ts';

const session = '01234567-89ab-cdef-0123-456789abcdef';
const resume = { round: 2, prompt: 'prompt-r2.md' };
async function setup(t: TestContext, who: Job['who'] = 'codex', extra: Partial<Job> = {}) {
  const c = await context(t, false);
  const keys = ['XAGENTS_HOME', 'XAGENTS_FAKE_WORKER'];
  const saved = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = c.env[key]!; });
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  const job: Job = { ...selection(`${who}:high`), id: '1010-package', batch: 'batch', project: '测试',
    repo: c.repo, worktree: c.repo, branch: 'xa/test', base: 'base', mode: 'read-only',
    kind: '审查', title: '测试', summary: '测试运行包', state: 'done', created: 'T0', started: 'T0', ended: 'T1', session, ...extra };
  const first = await prepareRun(job, '第一轮', { denyReadExtra: ['old-secret'], denyReadHome: ['xa-old-secret'] });
  usePreparedRun(job, first);
  return { ...c, job, first };
}

for (const who of ['codex', 'grok'] as const) {
  test(`${who} 每轮命令等于当前生成器的结果再做原续接变形，只读保持，命令与包逐轮留痕`, async t => {
    const { job, first } = await setup(t, who);
    const second = await prepareRun(job, '第二轮', { denyReadExtra: ['new-secret'], denyReadHome: ['xa-new-secret'] }, resume);
    const fresh = await command(job, '第二轮', second.isolation, join(jobDir(job.id), second.runtime));
    assert.deepEqual(second.command, fresh);
    assert.deepEqual(second.actual, resumeCommand({ ...job, command: fresh, resume }));
    assert.notDeepEqual(second.command, first.command);
    assert.deepEqual(second.isolation, { denyReadExtra: ['old-secret', 'new-secret'], denyReadHome: ['xa-old-secret', 'xa-new-secret'] });
    if (who === 'codex') {
      assert.ok(second.actual.args.includes(codexPermissions(job, second.isolation)));
      assert.ok(second.actual.args.includes('resume')); assert.ok(!second.actual.args.includes('-C'));
      assert.match(second.actual.args.find(a => a.startsWith('permissions.xa='))!, /extends=":read-only"/);
    } else {
      const settings = JSON.parse(await readFile(join(jobDir(job.id), second.runtime, 'sandbox.json'), 'utf8'));
      assert.deepEqual(settings, await sandbox(job, second.isolation));
      assert.ok(!settings.filesystem.allowWrite.includes(job.worktree));
    }
    usePreparedRun(job, second);
    assert.deepEqual(job.launches, [
      { round: 1, runtime: first.runtime, command: first.actual },
      { round: 2, runtime: second.runtime, command: second.actual },
    ]);
    const manifest = JSON.parse(await readFile(join(jobDir(job.id), second.runtime, 'launch.json'), 'utf8'));
    assert.deepEqual(manifest.actual, second.actual);
    assert.equal(await readFile(join(jobDir(job.id), first.runtime, 'launch.json'), 'utf8'),
      JSON.stringify({ round: 1, command: first.command, actual: first.actual, isolation: first.isolation }, null, 2) + '\n');
  });

  test(`${who} 旧任务没有额外禁读输入记录，也从旧有效权限恢复后取并集`, async t => {
    const { job } = await setup(t, who);
    delete job.isolation; delete job.launches;
    const oldCommand = structuredClone(job.command);
    const next = await prepareRun(job, '第二轮', { denyReadExtra: ['new-secret'], denyReadHome: ['xa-new-secret'] }, resume);
    assert.ok(next.isolation.denyReadExtra.includes('old-secret'));
    assert.ok(next.isolation.denyReadHome.includes('xa-old-secret'));
    usePreparedRun(job, next);
    assert.deepEqual(job.launches![0].command, oldCommand);
    assert.deepEqual(job.launches!.map(r => r.round), [1, 2]);
  });
}

test('切换成功后只留当前和上一轮的运行包，更早的删掉；不认识的目录不碰', async t => {
  const { job, first } = await setup(t);
  const second = await prepareRun(job, '第二轮', { denyReadExtra: [], denyReadHome: [] }, resume); usePreparedRun(job, second);
  const third = await prepareRun({ ...job, resume }, '第三轮', { denyReadExtra: [], denyReadHome: [] }, { round: 3, prompt: 'prompt-r3.md' }); usePreparedRun(job, third);
  const root = join(jobDir(job.id), 'runtime');
  await writeFile(join(root, 'keep-me.txt'), '不是平台建的包');
  await prunePackages(job);
  const left = (await readdir(root)).sort();
  assert.deepEqual(left, ['keep-me.txt', second.runtime.slice('runtime/'.length), third.runtime.slice('runtime/'.length)].sort());
  assert.ok(!left.includes(first.runtime.slice('runtime/'.length)));
  assert.deepEqual(job.launches!.map(l => l.round), [1, 2, 3]);
});

// 2026-10-10 真实探针抓到：联网开着时权限表结尾多一段 network，旧的解析把它吞进条目里，真实成员一律续接不了。
for (const who of ['codex', 'grok'] as const) {
  test(`${who} 联网开着派的任务：旧权限能完整核对，续接照常，联网状态不变`, async t => {
    const { job } = await setup(t, who, { network: true, mode: 'workspace-write' });
    if (who === 'codex') assert.match(job.command!.args.find(a => a.startsWith('permissions.xa='))!, /,network=\{enabled=true\}\}$/);
    const second = await prepareRun(job, '第二轮', { denyReadExtra: ['new-secret'], denyReadHome: [] }, resume);
    assert.ok(second.isolation.denyReadExtra.includes('old-secret')); assert.ok(second.isolation.denyReadExtra.includes('new-secret'));
    if (who === 'codex') {
      const table = second.actual.args.find(a => a.startsWith('permissions.xa='))!;
      assert.match(table, /extends=":workspace"/); assert.match(table, /,network=\{enabled=true\}\}$/); assert.match(table, /new-secret"="deny"/);
    }
  });
}

test('旧权限无法完整识别、旧禁读被读例外覆盖、网络不符，一律拒绝且不切换旧包', async t => {
  const { job } = await setup(t);
  const original = structuredClone(job);
  const position = job.command!.args.findIndex(arg => arg.startsWith('permissions.xa='));
  for (const policy of ['permissions.xa={unknown=true}',
    job.command!.args[position].replace(`${JSON.stringify(join(homedir(), '.codex/tmp'))}="read"`, `${JSON.stringify(join(homedir(), '.codex/tmp'))}="deny"`),
    job.command!.args[position].slice(0, -1) + ',network={enabled=true}}']) {
    job.command!.args[position] = policy;
    const before = structuredClone(job);
    await assert.rejects(prepareRun(job, '第二轮', { denyReadExtra: [] }, resume), /运行包准备失败.*无法确认旧隔离约束/);
    assert.deepEqual(job, before);
    assert.deepEqual(await readdir(join(jobDir(job.id), 'runtime')), [original.runtime!.split('/').at(-1)]);
  }
});

test('srt 未知规则、旧禁写丢失、新增可写位置都不能悄悄放行', async t => {
  const { job } = await setup(t, 'grok');
  const file = join(jobDir(job.id), job.runtime!, 'sandbox.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const settings of [{ ...original, unknown: true },
    { ...original, filesystem: { ...original.filesystem, denyWrite: [...original.filesystem.denyWrite, '/extra-old-deny'] } },
    { ...original, filesystem: { ...original.filesystem, allowWrite: [] } }]) {
    await writeFile(file, JSON.stringify(settings));
    await assert.rejects(prepareRun(job, '第二轮', { denyReadExtra: [] }, resume), /运行包准备失败.*无法确认旧隔离约束/);
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(settings));
  }
});

test('缺会话号时准备失败，旧包与命令不变，半份包被清走', async t => {
  const { job } = await setup(t, 'grok');
  delete job.session;
  const before = structuredClone(job);
  await assert.rejects(prepareRun(job, '第二轮', { denyReadExtra: [] }, resume), /运行包准备失败.*会话号/);
  assert.deepEqual(job, before);
  assert.deepEqual(await readdir(join(jobDir(job.id), 'runtime')), [job.runtime!.split('/').at(-1)]);
});

test('任务锁内确认上一轮看管进程已退出，存活时不准备下一轮', async t => {
  const { job } = await setup(t);
  await createJob({ ...job, pid: process.pid });
  try {
    await assert.rejects(resumeMember(job, 2, '第二轮'), /上一轮看管进程还没退出/);
    assert.deepEqual(await readJob(job.id), { ...job, pid: process.pid });
  } finally {
    // helpers 清理不能把测试进程当作看管进程停止。
    await updateJob(job.id, current => { delete current.pid; });
  }
});
