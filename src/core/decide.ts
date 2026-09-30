import { changeJob as change, active, readJob } from './job.ts';
import { git } from './worktree.ts';
import type { Job } from './job.ts';
import { markCommentsHandled } from './comments.ts';

export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// merged：负责人已经在副本之外把这件活合进去了（比如先清理了副本、或合并时另做了修改），给出合并提交号来记采用结论。
// 只允许负责人采用时用；提交必须真实存在于项目仓库。它不绕过真实验收等其他把关。
export async function decide(id: string, kind: 'adopt' | 'drop', note: string | undefined, by: 'owner' | 'lead', merged?: string): Promise<Job> {
  if (kind !== 'adopt' && kind !== 'drop') throw new Error('决定只能是采用或放弃。');
  if (by !== 'owner' && by !== 'lead') throw new Error('拍板的人只能是主人或负责人。');
  if (note !== undefined && (typeof note !== 'string' || [...note].length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(note))) {
    throw new Error('结论最多 200 字，不能含控制字符。');
  }
  let commit: string | undefined;
  if (merged !== undefined) {
    if (by !== 'lead' || kind !== 'adopt') throw new Error('--merged 只能在负责人采用时用。');
    if (typeof merged !== 'string' || !/^[0-9a-f]{7,40}$/i.test(merged)) throw new Error('--merged 请填写合并提交号（7–40 位十六进制）。');
    const repo = (await readJob(id)).repo;
    try { commit = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${merged}^{commit}`])).trim(); }
    catch { throw new Error(`项目仓库里找不到提交 ${merged}，请核对后再记。`); }
  }
  return change(id, job => {
    if (active(job)) throw new Error('任务还没结束，请先 wait 或 stop。');
    // 在锁里拒绝：界面上过时的确认不能盖掉已经写下的结论。
    if (by === 'owner' && job.decision) throw new Error('这件活已经有结论了，不用再选。');
    const owner = by === 'lead' && job.decision?.by === 'owner' ? job.decision : undefined;
    const choice = owner?.kind ?? kind;
    if (by === 'lead' && choice === 'adopt' && job.realCheck?.needed && !job.realCheck.result?.ok && !job.realCheck.skipped) {
      throw new Error(`这件活需要真实环境验收，还没做（或没过）。先用 xagents real ${id} --pass 记下结果，或 --skip 写明为什么不需要。`);
    }
    if (choice === 'adopt' && job.cleaned && !commit) throw new Error(`副本已清理，无法按副本采用。如果已经在副本之外合并了，用 xagents adopt ${id} --merged <合并提交号> --note "结论" 记下。`);
    const now = new Date().toISOString();
    job.decision = owner
      ? { ...owner, note, by, handled: owner.handled ?? now }
      : { kind: choice, note, at: now, by };
    if (commit) job.decision.merged = commit;
  });
}

export async function requestRedo(id: string): Promise<Job> {
  return change(id, job => {
    if (active(job)) throw new Error('任务还没结束，请先 wait 或 stop，再请求重做。');
    // 旧记录缺 by 时按负责人处理，和决定字段的约定一致。
    if (job.decision && (job.decision.by ?? 'lead') === 'lead') throw new Error('负责人已经有结论了，不能再请求重做。');
    if (job.redo && !job.redo.handled) throw new Error('已经有一条还没照办的重做请求。');
    job.redo = { at: new Date().toISOString(), by: 'owner' };
  });
}

export async function markHandled(id: string): Promise<Job> {
  return change(id, job => {
    const now = new Date().toISOString();
    if (job.decision?.by === 'owner') job.decision.handled ??= now;
    if (job.redo?.by === 'owner') job.redo.handled ??= now;
    markCommentsHandled(job, now);
  });
}
