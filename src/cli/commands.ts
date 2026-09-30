import { selectJobs, listJobs } from '../core/job.ts';
import { pendingComments } from '../core/comments.ts';
import { reconcileSafely } from '../core/runner.ts';
import { waitForJobs } from '../core/wait.ts';
import type { OwnerAction, WaitIO } from '../core/wait.ts';
import * as commands from '../core/commands.ts';
import { localTime, table, statusTable } from './format.ts';

export async function status(id?: string, all = false) {
  const jobs = await selectJobs(id, all);
  await reconcileSafely();
  console.log(statusTable(jobs));
}
// 退出码：0 活都做完了，1 有出错或失联的，3 主人有新动作（负责人先处理再接着 wait）。
export const OWNER_EXIT = 3;
export function describeAction(a: OwnerAction) {
  const when = localTime(a.at), head = `任务 ${a.id}（${a.title}）`;
  if (a.kind === 'comment') return `${head}：主人留言（${when}）：\n  ${a.text!.replace(/\n/g, '\n  ')}`;
  return `${head}：${a.kind === 'adopt' ? '主人选了用这份' : a.kind === 'drop' ? '主人选了不要了' : '主人请求重做'}（${when}）`;
}
export async function wait(id: string, io?: WaitIO) {
  const result = await waitForJobs(id, io);
  if (result.reason === 'owner') {
    console.log(`主人有新的动作，先处理再接着等：\n${result.fresh.map(describeAction).join('\n')}\n处理完（xagents reply 回复留言，或 xagents handled 标记照办）再运行：xagents wait ${id}`);
    return OWNER_EXIT;
  }
  console.log(statusTable(result.jobs));
  if (result.fresh.length) console.log(`另外，主人有新的动作，请先运行 xagents inbox：\n${result.fresh.map(describeAction).join('\n')}`);
  return result.jobs.some(j => j.state === 'failed' || j.state === 'lost') ? 1 : 0;
}
export const collect = (id: string) => commands.collect(id, console.log);
export const clean = (id?: string, done = false) => commands.clean(id, done, console.log);
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
  console.log(rows.length ? table(['编号', '题目', '主人做了什么', '什么时候'], rows) : '没有等你照办的事');
}
