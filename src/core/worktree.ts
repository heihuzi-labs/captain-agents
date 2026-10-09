import { spawn } from 'node:child_process';
import { open, mkdir, lstat, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hasCode, writeAtomic } from './fsx.ts';
import { jobDir } from './paths.ts';
import type { Job } from './job.ts';
import { updateJob } from './job.ts';

export async function git(repo: string, args: string[], allowed = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', code => allowed.includes(code!) ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`Git 操作失败：${Buffer.concat(err).toString('utf8').trim()}。请检查仓库路径、分支和副本状态后重试。`)));
  });
}
export async function addWorktree(job: Pick<Job, 'repo' | 'worktree' | 'branch' | 'base'>) {
  await mkdir(dirname(job.worktree), { recursive: true });
  await git(job.repo, ['worktree', 'add', '-b', job.branch, job.worktree, job.base]);
}
// 返回 false 可中止后续命令；派活仍由原来的锁和进程登记控制取消。
export async function setupCommands(commands: string[], logfile: string, step: (command: string, fd: FileHandle) => Promise<void | boolean>) {
  const fd = await open(logfile, 'a', 0o600);
  try {
    for (const command of commands) {
      await fd.write(`\n执行：${command}\n`);
      if (await step(command, fd) === false) return;
    }
  } finally { await fd.close(); }
}
export async function setup(job: Job, commands: string[], logfile: string) {
  await setupCommands(commands, logfile, async (command, fd) => {
    let finished: Promise<void> | undefined, pid: number | undefined;
    try {
      await updateJob(job.id, j => {
        if (j.state !== 'queued') return;
        const child = spawn('/bin/sh', ['-c', command], { cwd: job.worktree, detached: true, stdio: ['ignore', fd.fd, fd.fd] });
        j.setupPid = pid = child.pid;
        finished = new Promise<void>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`准备副本失败（${signal || code}），请查看 ${logfile}，修正项目 setup 后重新派发。`)));
        });
        finished.catch(() => {});
      });
      if (!finished) return false;
      await finished;
    } finally {
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (!hasCode(e, 'ESRCH')) throw e; } }
      await updateJob(job.id, j => { delete j.setupPid; });
    }
  });
}
export async function diff(job: Job) {
  let result = await git(job.worktree, ['diff', '--no-ext-diff', '--no-textconv', job.base, '--']);
  const files = (await git(job.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of files) {
    const full = join(job.worktree, file);
    // 不跟随新文件中的符号链接去读取副本外的内容。
    if ((await lstat(full)).isSymbolicLink()) {
      const quoted = JSON.stringify(`b/${file}`);
      result += `diff --git ${JSON.stringify(`a/${file}`)} ${quoted}\nnew file mode 120000\n--- /dev/null\n+++ ${quoted}\n@@ -0,0 +1 @@\n+${await readlink(full)}\n\\ No newline at end of file\n`;
    } else {
      result += await git(job.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', file], [0, 1]);
    }
  }
  return result;
}
export async function changedFiles(job: Job) {
  const status = await git(job.worktree, ['status', '--porcelain', '--untracked-files=all']);
  return status.split('\n').filter(Boolean).length;
}
// 副本被外面删掉后再进去跑 git 只会报英文错误，调用方先用它判断。
export async function worktreeMissing(job: Pick<Job, 'worktree'>) {
  try { await lstat(job.worktree); return false; }
  catch (e) { if (hasCode(e, 'ENOENT')) return true; throw e; }
}
export async function saveDiff(job: Job) {
  if (!job.cleaned) await writeAtomic(join(jobDir(job.id), 'diff.patch'), await diff(job));
}
export async function removeWorktree(job: Pick<Job, 'repo' | 'worktree' | 'branch'>) {
  const entries = (await git(job.repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  if (entries.includes(`worktree ${job.worktree}`)) await git(job.repo, ['worktree', 'remove', '--force', job.worktree]);
  else {
    try { await lstat(job.worktree); throw new Error(`目录 ${job.worktree} 仍存在但不属于登记的 Git 副本，请先人工检查。`); }
    catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
  }
  const branches = await git(job.repo, ['branch', '--list', job.branch, '--format=%(refname:short)']);
  if (branches.trim()) await git(job.repo, ['branch', '-D', job.branch]);
}
