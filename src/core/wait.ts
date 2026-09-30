import { setTimeout as sleep } from 'node:timers/promises';
import { active, listJobs, selectJobs } from './job.ts';
import type { Job } from './job.ts';
import { pendingComments } from './comments.ts';
import { reconcileSafely } from './runner.ts';

// 主人在应用里做的、负责人还没处理的事：留言、用这份 / 不要了、重做。和 xagents inbox 用同一套判定。
export type OwnerAction = { id: string; title: string; key: string; kind: 'comment' | 'adopt' | 'drop' | 'redo'; text?: string; at: string };
export function ownerActions(jobs: Job[]): OwnerAction[] {
  const out: OwnerAction[] = [];
  for (const job of jobs) {
    const base = { id: job.id, title: job.title };
    if (job.decision?.by === 'owner' && !job.decision.handled) out.push({ ...base, key: `${job.id}:decision:${job.decision.at}`, kind: job.decision.kind, at: job.decision.at });
    if (job.redo?.by === 'owner' && !job.redo.handled) out.push({ ...base, key: `${job.id}:redo:${job.redo.at}`, kind: 'redo', at: job.redo.at });
    for (const c of pendingComments(job)) out.push({ ...base, key: `${job.id}:comment:${c.at}`, kind: 'comment', text: c.text, at: c.at });
  }
  return out;
}
export type WaitIO = { list(): Promise<Job[]>; select(id: string): Promise<Job[]>; refresh(): Promise<void>; sleep(ms: number): Promise<void> };
const real: WaitIO = { list: () => listJobs(), select: id => selectJobs(id), refresh: reconcileSafely, sleep: ms => sleep(ms) };
export type WaitResult =
  | { reason: 'finished'; jobs: Job[]; fresh: OwnerAction[] }
  | { reason: 'owner'; jobs: Job[]; fresh: OwnerAction[] };
// 等指定的活结束，同时盯着主人的新动作：开始等之前已经在待办里的不算，之后新出现的（任何任务上）立刻返回。
// 活已经结束时，以“活结束”为准，顺带带回同时出现的新动作。
export async function waitForJobs(id: string, io: WaitIO = real, pollMs = 2000): Promise<WaitResult> {
  const known = new Set(ownerActions(await io.list()).map(a => a.key));
  while (true) {
    const jobs = await io.select(id);
    await io.refresh();
    const fresh = ownerActions(await io.list()).filter(a => !known.has(a.key));
    if (!jobs.some(active)) return { reason: 'finished', jobs, fresh };
    if (fresh.length) return { reason: 'owner', jobs, fresh };
    await io.sleep(pollMs);
  }
}
