import { setTimeout as sleep } from 'node:timers/promises';
import { active, listJobs, selectJobs } from './job.ts';
import type { Job } from './job.ts';
import { pendingComments } from './comments.ts';
import { reconcileSafely } from './runner.ts';
import { listTeams, pendingOwnerSays, readChannel, readTeam, reconcileTeam } from './team.ts';
import { listChats, pendingForLead, readMessages } from './chat.ts';
import type { Chat } from './chat.ts';
import type { Team } from './team.ts';

// 主人在应用里做的、负责人还没处理的事：留言、用这份 / 不要了、重做，外加各小队频道里主人的话。
// 和 xagents inbox 用同一套判定。key 只用来在 wait 期间区分“旧事项”和“新出现的事项”。
export type OwnerAction = { id: string; title: string; key: string; kind: 'comment' | 'adopt' | 'drop' | 'redo' | 'say'; text?: string; at: string };
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
// 各小队频道里主人说的、负责人还没处理的话。
export async function teamOwnerActions(teams: Team[]): Promise<OwnerAction[]> {
  const out: OwnerAction[] = [];
  for (const team of teams) {
    for (const m of pendingOwnerSays(await readChannel(team.id))) {
      out.push({ id: team.id, title: team.title, key: `team:${team.id}:say:${m.id}`, kind: 'say', text: m.text, at: m.at });
    }
  }
  return out;
}
export async function chatOwnerActions(chats: Chat[]): Promise<OwnerAction[]> {
  const out: OwnerAction[] = [];
  for (const chat of chats) for (const m of pendingForLead(await readMessages(chat.id))) {
    if (m.from === 'owner' && m.kind === 'say') out.push({ id: chat.id, title: chat.title, key: `chat:${chat.id}:say:${m.id}`, kind: 'say', text: m.text, at: m.at });
  }
  return out;
}
export async function allOwnerActions(jobs: Job[], teams: Team[], chats: Chat[] = []): Promise<OwnerAction[]> {
  return [...ownerActions(jobs), ...await teamOwnerActions(teams), ...await chatOwnerActions(chats)];
}
export type WaitIO = {
  list(): Promise<Job[]>;
  teams?(): Promise<Team[]>;
  chats?(): Promise<Chat[]>;
  select(id: string): Promise<Job[]>;
  refresh(): Promise<void>;
  sleep(ms: number): Promise<void>;
};
const real: WaitIO = {
  list: () => listJobs(), teams: () => listTeams(), chats: () => listChats(), select: id => selectJobs(id), refresh: reconcileSafely, sleep: ms => sleep(ms),
};
export type WaitResult =
  | { reason: 'finished'; jobs: Job[]; fresh: OwnerAction[] }
  | { reason: 'owner'; jobs: Job[]; fresh: OwnerAction[] };
export type TeamWaitResult =
  | { reason: 'settled'; team: Team; fresh: OwnerAction[] }
  | { reason: 'owner'; team: Team; fresh: OwnerAction[] };
// 等指定的活结束，同时盯着主人的新动作：开始等之前已经在待办里的不算，之后新出现的（任何任务或小队上）立刻返回。
// 活已经结束时，以“活结束”为准，顺带带回同时出现的新动作。
export async function waitForJobs(id: string, io: WaitIO = real, pollMs = 2000): Promise<WaitResult> {
  const teams = io.teams ?? (() => Promise.resolve([] as Team[]));
  const known = new Set((await allOwnerActions(await io.list(), await teams(), await (io.chats?.() ?? Promise.resolve([])))).map(a => a.key));
  while (true) {
    const jobs = await io.select(id);
    await io.refresh();
    const fresh = (await allOwnerActions(await io.list(), await teams(), await (io.chats?.() ?? Promise.resolve([])))).filter(a => !known.has(a.key));
    if (!jobs.some(active)) return { reason: 'finished', jobs, fresh };
    if (fresh.length) return { reason: 'owner', jobs, fresh };
    await io.sleep(pollMs);
  }
}
// 等小队不再是 running（lead / ended），期间照旧盯主人的新动作（退出码 3 由调用方定）。
export async function waitForTeam(id: string, io: WaitIO = real, pollMs = 2000): Promise<TeamWaitResult> {
  const teams = io.teams ?? (() => Promise.resolve([] as Team[]));
  const known = new Set((await allOwnerActions(await io.list(), await teams(), await (io.chats?.() ?? Promise.resolve([])))).map(a => a.key));
  while (true) {
    const team = await reconcileTeam(await readTeam(id));
    const fresh = (await allOwnerActions(await io.list(), await teams(), await (io.chats?.() ?? Promise.resolve([])))).filter(a => !known.has(a.key));
    if (team.state !== 'running') return { reason: 'settled', team, fresh };
    if (fresh.length) return { reason: 'owner', team, fresh };
    await io.sleep(pollMs);
  }
}
