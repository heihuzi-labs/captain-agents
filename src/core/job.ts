import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, jobDir, safeName } from './paths.ts';
import { readJson, writeJson, withLock, alive, hasCode } from './fsx.ts';

import { isWho } from './roster.ts';
import type { Who } from './roster.ts';
import type { RoundRecord } from './team.ts';
export type { Who };
export type State = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'lost';
export type Usage = { read: number; cached: number; out: number; cacheWrite?: number };
// unset：启动前从继承的环境里去掉的变量（比如 DeepSeek 的活不能带上主人环境里别家的钥匙）。
// login：启动前由看管进程在隔离外取来、只放进选手进程环境的登录（不写进任务记录），见 workers.ts 的 cursorToken。
export type Command = { file: string; args: string[]; env: Record<string, string>; unset?: string[]; login?: 'cursor'; stdin: 'prompt' | 'ignore'; output: 'run.log' };
export type Activity = { at: string; kind: 'cmd' | 'edit' | 'read' | 'say'; text: string };
// 每一步的时间（看管进程边读边记）：steps 是调用工具的步数，toolSeconds 是工具在跑的时间（重叠的只算一次，扣掉休眠）。
export type Timing = { steps: number; toolSeconds: number };
export type Comment = { by: 'owner' | 'lead'; text: string; at: string; handled?: string };
export type Rating = {
  score?: 1 | 2 | 3 | 4 | 5;
  good?: string; improve?: string; tags: string[]; external?: string;
  at: string; by: 'lead';
  previous?: Omit<Rating, 'previous'>[];
};
export type Job = {
  id: string; batch: string; project: string; repo: string; base: string; worktree: string; branch: string;
  who: Who; model: string; effort: string; fast?: true; mode: 'read-only' | 'workspace-write'; kind: string; title: string; summary: string;
  state: State; created: string; started?: string; ended?: string; seconds?: number; exit?: number | null;
  pid?: number; workerPid?: number; setupPid?: number; queuedBy?: number; command?: Command; error?: string; usage?: Usage;
  cleaned?: string; stopRequested?: boolean; decision?: { kind: 'adopt' | 'drop'; note?: string; at: string; by: 'owner' | 'lead'; handled?: string; merged?: string }; verify?: unknown;
  // 负责人写明“这件活不用跑验收命令”的理由（xagents verify --skip）。再跑一次验收，它就让位给真实的结果。
  verifySkip?: { reason: string; at: string };
  worktreeRemoved?: string; // 副本和分支已删除的时间，后续清理失败时供重试使用。
  // 删除副本前解析出的会话路径，清理中断后仍能找到真实路径对应的会话。
  pendingGrokSessions?: string[];
  redo?: { at: string; by: 'owner'; handled?: string };
  sleeps?: { from: string; to: string }[];
  comments?: Comment[];
  rating?: Rating;
  realCheck?: {
    needed: boolean; steps: string[];
    result?: { ok: boolean; note: string; shots: string[]; at: string; by: 'lead' };
    skipped?: { reason: string; at: string };
  };
  activity?: Activity[]; lastActivityAt?: string; changedFiles?: number;
  timing?: Timing;
  // 派活时的联网快照；缺省就是关，之后的设置变更不影响本任务。
  network?: true;
  // 自动清理旧日志后记下：什么时候、腾出多少字节、移走了哪些文件（相对任务目录）。
  slimmed?: { at: string; bytes: number; files: string[] };
  // 小队里的队员（docs/design-team.md）。有它的活由小队推进，看板画在小队卡里，不单独成卡。
  team?: { id: string; role: 'writer' | 'reviewer' };
  // 项目群里的成员（docs/design-team.md 第 16 节）：这件活是某位选手在这个群里的“席位”，每被 @ 一次就续接一轮；
  // 副本是群共用的，清理这件活时不删副本（群收起后由 xagents chat clean 删）。
  chat?: { id: string };
  // 这位选手在自家程序里的会话号（第 1 轮结束后从输出里取），叫醒时用它续接。
  session?: string;
  // 每轮独立运行包；只有整包准备成功才在任务锁里切换。切换成功后只留当前和上一轮的包（run-package.ts 的 prunePackages）。
  runtime?: string;
  isolation?: { denyReadExtra: string[]; denyReadHome: string[] };
  // 包内也保存命令；这里从第一轮起记下每轮实际启动的命令（续接已经变形）。
  launches?: { round: number; runtime: string; command: Command }[];
  // 第 2 轮起有：看管进程按它把 command 改成续接（workers.ts 的 resumeCommand），提示词读 prompt 这个文件（任务目录里的文件名）。
  resume?: { round: number; prompt: string };
  // 已经做完的各轮（叫醒下一轮前抄下来）；当前这一轮仍在 started/ended/usage 等字段里。
  rounds?: RoundRecord[];
};
export type Batch = { id: string; kind: string; title: string; summary: string; started: string; base: string; jobs: string[] };
export const active = (job: Job) => job.state === 'queued' || job.state === 'running';
export const readJob = (id: string): Promise<Job> => readJson(join(jobDir(id), 'job.json'));
export async function createJob(job: Job) {
  await withLock(jobDir(job.id), async () => {
    try { await readJob(job.id); throw new Error(`任务 ${job.id} 已存在，请重新派发。`); }
    catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
    await writeJson(join(jobDir(job.id), 'job.json'), job);
  });
}
export async function updateJob(id: string, fn: (job: Job) => void | Promise<void>) {
  return withLock(jobDir(id), async () => {
    const job = await readJob(id);
    await fn(job);
    await writeJson(join(jobDir(id), 'job.json'), job);
    return job;
  });
}
// 所有“读 → 改 → 写”的入口共用：任务不存在时给中文错误。
export async function changeJob(id: string, edit: (job: Job) => void): Promise<Job> {
  if (typeof id !== 'string') throw new Error('请填写有效的任务号。');
  try { return await updateJob(id, edit); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new Error(`找不到任务 ${id}。请先运行 xagents status --all。`);
    throw error;
  }
}
export function finish(job: Job, state: State, error?: string) {
  job.state = state;
  job.ended = new Date().toISOString();
  job.seconds = Math.max(0, (Date.parse(job.ended) - Date.parse(job.started || job.created)) / 1000);
  if (error) job.error = error; else delete job.error;
}
// 只判断，不改任务、不写文件；进程探针可替换，供状态修正和只读视图共用。
export function interruption(job: Job, isAlive = alive): { state: State; error?: string } | undefined {
  if (job.state === 'queued' && !isAlive(job.pid) && !isAlive(job.queuedBy)) {
    return job.stopRequested ? { state: 'stopped' } : { state: 'failed', error: '派发进程在启动前退出了。请先 stop 收尾准备进程，再 clean 并重新派发。' };
  }
  if (job.state === 'running' && !isAlive(job.pid)) {
    return job.stopRequested ? { state: 'stopped' } : { state: 'lost', error: '看管进程已经不在。请检查日志，停止残留选手后再收集或清理。' };
  }
}
export async function reconcile(job: Job) {
  if (!interruption(job)) return job;
  return updateJob(job.id, current => {
    const interrupted = interruption(current);
    if (interrupted) finish(current, interrupted.state, interrupted.error);
  });
}
export async function listJobs(fixLost = false): Promise<Job[]> {
  const entries = await readdir(paths().jobs, { withFileTypes: true });
  const jobs: Job[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    let j: Job;
    try { j = await readJob(e.name); }
    catch (error) {
      if (hasCode(error, 'ENOENT') || error instanceof SyntaxError) continue;
      throw error;
    }
    // 单条损坏不拖垮整份登记处；旧记录可以没有 summary 等新增字段。
    if (!j || j.id !== e.name || typeof (j.started || j.created) !== 'string'
      || !['queued', 'running', 'done', 'failed', 'stopped', 'lost'].includes(j.state)
      || !isWho(j.who)) continue;
    try { jobs.push(fixLost ? await reconcile(j) : j); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
  return jobs.sort((a, b) => (b.started || b.created).localeCompare(a.started || a.created) || a.id.localeCompare(b.id));
}
export async function selectJobs(id?: string, all = false): Promise<Job[]> {
  if (!id) return (await listJobs(true)).filter(j => all || !j.cleaned);
  safeName(id);
  try { return [await reconcile(await readJob(id))]; }
  catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
  let batch: Batch;
  try { batch = await readJson(join(paths().batches, `${id}.json`)); }
  catch (e) { if (hasCode(e, 'ENOENT')) throw new Error(`找不到任务或批号 ${id}。请先运行 xagents status --all。`); throw e; }
  return Promise.all(batch.jobs.map(async jid => reconcile(await readJob(jid))));
}
