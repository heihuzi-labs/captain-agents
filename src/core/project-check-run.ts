import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, safeName } from './paths.ts';
import type { Project } from './project.ts';
import { worktreePath } from './project.ts';
import { addWorktree, git, removeWorktree, setupCommands } from './worktree.ts';
import { withLock } from './fsx.ts';
import { execute, executeLogged, verifyCommands, verifyTimeoutMinutes } from './verify.ts';
import type { Executor, VerifyStep } from './verify.ts';

import type { CheckItem } from './project-check.ts';

// 清掉以前被中断的体检留下的临时副本和分支（只认 xa-check/ 前缀）。调用方持有本项目的体检锁，所以此刻没有别的体检在用它们。
export async function cleanStaleChecks(repo: string) {
  const entries = (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  for (let i = 0; i < entries.length; i++) {
    const branch = entries[i].startsWith('branch refs/heads/xa-check/') ? entries[i].slice('branch refs/heads/'.length) : '';
    if (!branch) continue;
    let j = i; while (j > 0 && !entries[j].startsWith('worktree ')) j--;
    if (entries[j].startsWith('worktree ')) await removeWorktree({ repo, worktree: entries[j].slice('worktree '.length), branch });
  }
  await git(repo, ['worktree', 'prune']);
  for (const branch of (await git(repo, ['branch', '--list', 'xa-check/*', '--format=%(refname:short)'])).split('\n').map(b => b.trim()).filter(Boolean)) {
    await git(repo, ['branch', '-D', branch]);
  }
}

type Dynamic = { items: CheckItem[]; baseline?: { at: string; ok: boolean; steps: VerifyStep[] } };
// 同一项目同一时间只跑一次体检；开始前先清掉被中断的体检留下的东西。
export async function dynamicChecks(project: Project, run: Executor = execute): Promise<Dynamic> {
  return withLock(join(paths().cache, 'check-locks', safeName(project.name)), async () => {
    await cleanStaleChecks(project.repo);
    return runChecks(project, run);
  });
}

async function runChecks(project: Project, run: Executor): Promise<Dynamic> {
  const stamp = `${Date.now()}-${randomUUID()}`;
  const directory = join(paths().cache, 'checks');
  const logfile = join(directory, `${safeName(project.name)}-${stamp}.log`);
  const minutes = verifyTimeoutMinutes((project as Project & { verifyTimeoutMinutes?: number }).verifyTimeoutMinutes ?? 20);
  const copy = { repo: project.repo, base: 'HEAD', branch: `xa-check/${stamp}`, worktree: await worktreePath(project, `check-${stamp}`) };
  await mkdir(directory, { recursive: true });
  try {
    // add 也放在 try 内：Git 即使只建出了分支，finally 也会清理。
    await addWorktree(copy);
    const setupItem: CheckItem = { id: 'setup', title: '准备副本', status: 'ok', detail: project.setup.length ? `准备命令全部通过。日志：${logfile}` : '没有装依赖的命令' };
    await setupCommands(project.setup, logfile, async (cmd, fd) => {
      const result = await executeLogged(cmd, copy.worktree, minutes, fd, run, '准备');
      const ok = result.exit === 0 && !result.timedOut && !result.signal && !result.error;
      const reason = result.timedOut ? `超时（${minutes} 分钟），已停止进程组` : result.error || (result.signal ? `进程被 ${result.signal} 停止` : '');
      await fd.write(`\n结果：${ok ? '命令通过' : `退出码 ${result.exit}${reason ? `，${reason}` : ''}`}\n`);
      if (!ok) {
        setupItem.status = 'fail';
        setupItem.detail = `命令「${cmd}」没通过，退出码 ${result.exit}${reason ? `，${reason}` : ''}。日志：${logfile}`;
        setupItem.fix = '修正项目 setup 命令后重新体检。';
      }
      return ok;
    });
    const verifyItem: CheckItem = { id: 'verify', title: '验收底子', status: 'warn', detail: '没有验收命令，交回的活只能靠人看' };
    const items = [setupItem, verifyItem];
    if (setupItem.status === 'fail') {
      verifyItem.detail = '准备副本失败，未运行验收，尚无验收底子。';
      return { items };
    }
    if (!project.verify.length) return { items };
    const { at, ok, steps } = await verifyCommands(project.verify, copy.worktree, logfile, minutes, run, 'a');
    verifyItem.status = ok ? 'ok' : 'warn';
    const failed = steps.filter(step => !step.ok);
    verifyItem.detail = ok ? `验收命令全部通过。日志：${logfile}` : `全新副本里验收有 ${failed.length} 项没过：${failed.map(step => `${step.cmd}：${step.summary}`).join('；')}。日志：${logfile}`;
    // 新副本和主目录不一样（比如有要先编译的包、生成的文件），这种“没过”常常是准备步骤不全，不是项目本来就坏。
    if (!ok) verifyItem.fix = '先看日志：如果在你的主目录里能通过，多半是全新副本少了构建或生成步骤，把它加进 setup 后重新体检；主目录里也不过，那就是现在的底子，派活时记住它。';
    return { items, baseline: { at, ok, steps } };
  } finally {
    await removeWorktree(copy);
  }
}
