import type { Job } from '../core/job.ts';
import { git } from '../core/worktree.ts';
import { quote } from '../core/decide.ts';

export async function decisionMessage(job: Job): Promise<string> {
  const { id } = job;
  const { kind, note } = job.decision!;
  const lines = [`已${kind === 'adopt' ? '采用' : '放弃'} ${id}${note ? `：${note}` : ''}`];
  if (kind === 'adopt' && job.decision!.merged) {
    lines.push(`已记下合并提交 ${job.decision!.merged.slice(0, 12)}，不需要再按副本合并。`);
    return lines.join('\n');
  }
  if (kind === 'adopt') {
    try {
      const newer = Number((await git(job.repo, ['rev-list', '--count', `${job.base}..refs/heads/main`])).trim());
      if (newer > 0) lines.push('main 已有副本起点之后的改动，请先对齐、处理冲突并重新验收，再合并。');
    } catch { lines.push('无法确认 main 与副本起点的关系，请负责人先核对。'); }
    lines.push('以下命令只供负责人审阅后手动执行；提交前检查暂存内容，并遵守项目的批准要求：',
      `git -C ${quote(job.worktree)} status --short`,
      `git -C ${quote(job.worktree)} add -A`,
      `git -C ${quote(job.worktree)} diff --cached`,
      `git -C ${quote(job.worktree)} commit -m ${quote(`采用任务 ${id}`)}`,
      `git -C ${quote(job.repo)} switch main`,
      `git -C ${quote(job.repo)} merge -- ${quote(`xa/${id}`)}`);
  }
  return lines.join('\n');
}
