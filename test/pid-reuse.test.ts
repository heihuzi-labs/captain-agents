import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, isWindows, processSince } from '../src/core/platform.ts';
import { readJson, withLock, writeJson } from '../src/core/fsx.ts';
import { createJob, readJob } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { stop } from '../src/core/commands.ts';
import { ensureHome } from '../src/core/paths.ts';
import { killEngine } from '../src/core/wake.ts';
import { readTeam, teamDir } from '../src/core/team.ts';
import type { Team } from '../src/core/team.ts';
import { reconcileTeam, stopTeam } from '../src/core/team-engine.ts';
import { chatDir, readChat } from '../src/core/chat.ts';
import type { Chat } from '../src/core/chat.ts';
import { reconcileChat, stopChat } from '../src/core/chat-engine.ts';
import { buildView } from '../src/core/view.ts';

const windowsOnly = { skip: !isWindows && 'macOS 按号认进程；重用者排除只在 Windows 上断言' };
async function registry(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'xa-pid-reuse-'));
  const previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  await ensureHome();
  return home;
}
async function bystander(t: TestContext) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await once(child, 'spawn');
  const since = processSince(child.pid);
  return { child, closed, since, old: (since ?? Date.now()) - 3_600_000 };
}

test('文件锁：登记系统出生时间，仍在工作的持锁者和旧记录都不能被回收', async t => {
  const home = await registry(t), ownerFile = join(home, '.lock', 'owner.json');
  await withLock(home, async () => {
    const owner = await readJson<{ pid: number; pidSince?: number }>(ownerFile);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.pidSince, processSince(process.pid));
    await assert.rejects(withLock(home, () => assert.fail('不能抢活锁'), 0), /等待文件锁/);
  });
  await mkdir(join(home, '.lock'));
  await writeJson(ownerFile, { pid: process.pid });
  await assert.rejects(withLock(home, () => assert.fail('旧活锁也不能抢'), 0), /等待文件锁/);
});

test('Windows 文件锁：持锁者和回收者的号被重用，都能回收；旧的活回收标记仍保护锁', windowsOnly, async t => {
  const home = await registry(t), lock = join(home, '.lock');
  const reused = { pid: process.pid, pidSince: processSince(process.pid)! - 3_600_000 };
  for (const reaper of [false, true]) {
    await mkdir(lock);
    await writeJson(join(lock, 'owner.json'), reused);
    if (reaper) await writeJson(join(lock, 'reaping.json'), reused);
    assert.equal(await withLock(home, () => '回收成功', 2000), '回收成功');
  }
  await mkdir(lock);
  await writeJson(join(lock, 'owner.json'), reused);
  await writeJson(join(lock, 'reaping.json'), { pid: process.pid });
  await assert.rejects(withLock(home, () => assert.fail('旧的活回收者不能被抢'), 0), /等待文件锁/);
});

test('停止推进进程：Windows 不杀同号重用者；真正的进程可以停止', async t => {
  const { child, closed, since, old } = await bystander(t);
  if (isWindows) {
    await killEngine(child.pid, old);
    assert.equal(alive(child.pid, since), true, '无关进程仍在');
  }
  await killEngine(child.pid, since);
  await closed;
  assert.equal(alive(child.pid, since), false);
});

test('Windows stop：不杀同号重用者；真正的看管进程不收尾时，5 秒后强制停止', windowsOnly, async t => {
  const home = await registry(t);
  const { child, closed, since, old } = await bystander(t);
  const job: Job = {
    id: 'reused-supervisor', batch: '', project: '测试', repo: home, base: 'base', worktree: home, branch: 'test',
    who: 'codex', model: 'test', effort: 'high', mode: 'read-only', kind: '修复', title: '重用测试', summary: '重用测试',
    state: 'running', created: new Date().toISOString(), pid: child.pid, pidSince: old,
  };
  await createJob(job);
  await stop(job.id);
  assert.equal((await readJob(job.id)).state, 'stopped');
  assert.equal(alive(child.pid, since), true);
  // 这个替身不会读 stopRequested，只有 5 秒后的兜底分支能停它；出生时间对得上才允许动手。
  const live = { ...job, id: 'live-supervisor', pidSince: since };
  await createJob(live);
  await stop(live.id);
  await closed;
  assert.equal((await readJob(live.id)).state, 'stopped');
  assert.equal(alive(child.pid, since), false);
});

test('Windows 小队：重用的推进进程号显示失联、可修正与收场；旧记录继续认活进程', windowsOnly, async t => {
  const home = await registry(t);
  const { child, since, old } = await bystander(t);
  const team: Team = {
    id: 'reused-team', mode: 'pair', project: '测试', repo: home, base: 'base', kind: '修复', title: '重用测试', summary: '重用测试', task: '测试',
    writer: { who: 'codex', effort: 'high' }, reviewer: { who: 'deepseek', effort: 'high' },
    round: 1, phase: 'write', maxRounds: 3, maxMinutes: 60, state: 'running', created: new Date().toISOString(), pid: child.pid, pidSince: old,
  };
  await mkdir(teamDir(team.id), { recursive: true });
  const file = join(teamDir(team.id), 'team.json');
  await writeJson(file, team);
  const before = await readFile(file, 'utf8');
  assert.equal((await buildView()).teams[0].reason, 'lost');
  assert.equal(await readFile(file, 'utf8'), before, '只读视图不改登记');
  assert.equal((await reconcileTeam({ ...team, pidSince: undefined })).state, 'running');
  assert.equal((await reconcileTeam(team)).reason, 'lost');
  await stopTeam(team.id);
  assert.equal((await readTeam(team.id)).state, 'ended');
  assert.equal(alive(child.pid, since), true);
});

test('Windows 群：重用的推进进程号可修正和停止；清除进程号时连出生时间一起清除', windowsOnly, async t => {
  const home = await registry(t);
  const { child, since, old } = await bystander(t);
  const chat: Chat = {
    id: 'reused-chat', project: '测试', repo: home, base: 'base', branch: 'test', worktree: home, title: '重用测试',
    members: [], hopLimit: 4, state: 'open', created: new Date().toISOString(), queue: [], pid: child.pid, pidSince: old,
  };
  await mkdir(chatDir(chat.id), { recursive: true });
  const file = join(chatDir(chat.id), 'chat.json');
  await writeJson(file, chat);
  assert.equal((await reconcileChat({ ...chat, pidSince: undefined })).pid, child.pid, '旧记录仍认活推进进程');
  const fixed = await reconcileChat(chat);
  assert.equal(fixed.pid, undefined); assert.equal(fixed.pidSince, undefined);
  await writeJson(file, chat);
  await stopChat(chat.id);
  const stopped = await readChat(chat.id);
  assert.equal(stopped.pid, undefined); assert.equal(stopped.pidSince, undefined);
  assert.equal(alive(child.pid, since), true);
});
