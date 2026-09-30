import { changeJob } from './job.ts';
import type { Comment, Job } from './job.ts';

export const COMMENT_MAX = 500;
// 主人给负责人留言：去掉首尾空白后 1–500 字，只允许换行这一种控制字符。
export function cleanComment(text: unknown): string {
  if (typeof text !== 'string') throw new Error('留言要写成文字。');
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) throw new Error('留言不能是空的。');
  if ([...clean].length > COMMENT_MAX) throw new Error(`留言最多 ${COMMENT_MAX} 字。`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(clean)) throw new Error('留言里不能有控制字符（换行可以）。');
  return clean;
}
// 主人的留言里，负责人还没处理的：没有 handled 记号，也没有被之后的负责人留言回复过。
export function pendingComments(job: Pick<Job, 'comments'>): Comment[] {
  const list = job.comments ?? [], last = list.findLastIndex(c => c.by === 'lead');
  return list.filter((c, i) => c.by === 'owner' && !c.handled && i > last);
}
// 待负责人回复：最后一条留言来自主人，并且负责人还没处理。
export const awaitingReply = (job: Pick<Job, 'comments'>) => {
  const last = job.comments?.at(-1);
  return last?.by === 'owner' && !last.handled;
};
// 负责人回复或标记已处理时，把主人此前的留言都记上处理时间（和 decision、redo 的 handled 一样）。
export function markCommentsHandled(job: Pick<Job, 'comments'>, now: string) {
  for (const c of job.comments ?? []) if (c.by === 'owner') c.handled ??= now;
}
export async function addComment(id: string, text: string, by: 'owner' | 'lead'): Promise<Job> {
  if (by !== 'owner' && by !== 'lead') throw new Error('留言的人只能是主人或负责人。');
  const clean = cleanComment(text);
  return changeJob(id, job => {
    const at = new Date().toISOString();
    if (by === 'lead') markCommentsHandled(job, at);
    (job.comments ??= []).push({ by, text: clean, at });
  });
}
