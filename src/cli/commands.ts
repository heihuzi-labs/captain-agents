import { chatPlain } from './chat.ts';
import { listChats, pendingForLead, readMessages } from '../core/chat.ts';
import { selectJobs, listJobs } from '../core/job.ts';
import type { Job } from '../core/job.ts';
import { pendingComments } from '../core/comments.ts';
import { reconcileSafely } from '../core/runner.ts';
import { waitForJobs, waitForTeam } from '../core/wait.ts';
import type { OwnerAction, WaitIO } from '../core/wait.ts';
import * as commands from '../core/commands.ts';
import { listTeams, pendingOwnerSays, readChannel, teamJobIds } from '../core/team.ts';
import { reasonText } from '../core/team-text.ts';
import { readTeamOrThrow, tryTeam } from './team.ts';
import { localTime, table, statusTable } from './format.ts';

export async function status(id?: string, all = false) {
  if (id && await tryTeam(id)) {
    const jobs: Job[] = [];
    const team = await readTeamOrThrow(id);
    for (const jobId of teamJobIds(team)) {
      try { jobs.push(...(await selectJobs(jobId))); } catch { /* 队员任务可能还没派或已清理。 */ }
    }
    await reconcileSafely();
    console.log(statusTable(jobs));
    return;
  }
  const jobs = await selectJobs(id, all);
  await reconcileSafely();
  console.log(statusTable(jobs));
}
// 退出码：0 活都做完了，1 有出错或失联的，3 主人有新动作（负责人先处理再接着 wait）。
export const OWNER_EXIT = 3;
export const TEAM_LEAD_EXIT = 4;
export function describeAction(a: OwnerAction) {
  const when = localTime(a.at);
  if (a.kind === 'say') return `小队 ${a.id}（${a.title}）：主人在频道里说（${when}）：\n  ${a.text!.replace(/\n/g, '\n  ')}`;
  const head = `任务 ${a.id}（${a.title}）`;
  if (a.kind === 'comment') return `${head}：主人留言（${when}）：\n  ${a.text!.replace(/\n/g, '\n  ')}`;
  return `${head}：${a.kind === 'adopt' ? '主人选了用这份' : a.kind === 'drop' ? '主人选了不要了' : '主人请求重做'}（${when}）`;
}
export async function wait(id: string, io?: WaitIO) {
  if (await tryTeam(id)) return waitTeam(id, io);
  const result = await waitForJobs(id, io);
  if (result.reason === 'owner') {
    console.log(`主人有新的动作，先处理再接着等：\n${result.fresh.map(describeAction).join('\n')}\n处理完（xagents reply 回复留言，或 xagents handled 标记照办）再运行：xagents wait ${id}`);
    return OWNER_EXIT;
  }
  console.log(statusTable(result.jobs));
  if (result.fresh.length) console.log(`另外，主人有新的动作，请先运行 xagents inbox：\n${result.fresh.map(describeAction).join('\n')}`);
  return result.jobs.some(j => j.state === 'failed' || j.state === 'lost') ? 1 : 0;
}
async function waitTeam(id: string, io?: WaitIO) {
  const result = await waitForTeam(id, io);
  if (result.reason === 'owner') {
    console.log(`主人有新的动作，先处理再接着等：\n${result.fresh.map(describeAction).join('\n')}\n处理完再运行：xagents wait ${id}`);
    return OWNER_EXIT;
  }
  const { team } = result;
  if (result.fresh.length) console.log(`另外，主人有新的动作，请先运行 xagents inbox：\n${result.fresh.map(describeAction).join('\n')}`);
  if (team.state === 'ended') {
    console.log(`小队 ${team.id} 已收场。`);
    return 0;
  }
  const reason = team.reason ? reasonText(team.reason) : '';
  console.log(`小队 ${team.id} 在等负责人：${reason}${team.note ? `；备注：${team.note}` : ''}`);
  return TEAM_LEAD_EXIT;
}
export const collect = (id: string) => commands.collect(id, console.log);
export async function clean(id?: string, done = false) {
  const team = id ? await tryTeam(id) : undefined;
  if (team) {
    const jobs: Job[] = [];
    for (const jobId of teamJobIds(team)) jobs.push(...(await selectJobs(jobId)));
    if (!jobs.length) throw new Error('这支队还没有队员任务号，没法清理。');
    await commands.cleanJobs(jobs, console.log);
    return;
  }
  await commands.clean(id, done, console.log);
}
export async function stop(id: string) { console.log(statusTable(await commands.stop(id))); }

export async function inbox() {
  const rows: string[][] = [];
  for (const job of await listJobs()) {
    if (job.decision?.by === 'owner' && !job.decision.handled) {
      rows.push([job.id, job.title, job.decision.kind === 'adopt' ? '主人选了用这份' : '主人选了不要了', localTime(job.decision.at)]);
    }
    if (job.redo?.by === 'owner' && !job.redo.handled) rows.push([job.id, job.title, '主人请求重做', localTime(job.redo.at)]);
    const waiting = pendingComments(job);
    if (waiting.length) rows.push([job.id, job.title, `主人留言待回复：${waiting.map(c => c.text.replace(/\s*\n\s*/g, ' ')).join(' ｜ ')}`, localTime(waiting.at(-1)!.at)]);
  }
  for (const team of await listTeams()) {
    const says = pendingOwnerSays(await readChannel(team.id));
    if (says.length) rows.push([team.id, team.title, `主人在小队频道留言：${says.map(s => s.text.replace(/\s*\n\s*/g, ' ')).join(' ｜ ')}`, localTime(says.at(-1)!.at)]);
  }
  for (const chat of await listChats()) {
    for (const m of pendingForLead(await readMessages(chat.id))) rows.push([chat.id, chat.title, `群聊待处理（${m.from === 'owner' ? '主人' : m.from === 'platform' ? '平台' : m.from}）：${chatPlain(m.text).replace(/\s*\n\s*/g, ' ')}`, localTime(m.at)]);
  }
  console.log(rows.length ? table(['编号', '题目', '待处理的事', '什么时候'], rows) : '没有等你照办的事');
}
