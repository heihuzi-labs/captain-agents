import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { active, selectJobs, updateJob, finish } from './job.ts';
import type { Job } from './job.ts';
import { alive, hasCode, writeAtomic, removeTree } from './fsx.ts';
import { jobDir } from './paths.ts';
import { result } from './workers.ts';
import { saveDiff, changedFiles, removeWorktree, worktreeMissing } from './worktree.ts';
import { cursorStateDir, grokSessionDirs, jobTmpDir } from './sandbox.ts';
import { isolationOf } from './roster.ts';
import { moveToTrash } from './trash.ts';
import { killGroup, reconcileSafely } from './runner.ts';
import { guardTeamJob } from './team.ts';
import { collectRealSteps } from './real.ts';

export async function collect(id: string, report: (text: string) => void = () => {}) {
  for (const job of await selectJobs(id)) {
    await updateJob(job.id, async current => {
      if (active(current)) throw new Error(`任务 ${job.id} 还在运行，请先 wait 或 stop，再 collect。`);
      if (current.slimmed) throw new Error(`任务 ${job.id}：原始日志已在 ${current.slimmed.at} 自动清理，报告在 report.md，改动在 diff.patch。`);
      const parsed = await result(current);
      if (!parsed.report) throw new Error(`任务 ${job.id} 没有报告，请检查 final.md 或 run.log。`);
      await writeAtomic(join(jobDir(job.id), 'report.md'), parsed.report + '\n');
      collectRealSteps(current, parsed.report);
      current.usage = parsed.usage;
      current.activity = parsed.activity; current.lastActivityAt = parsed.lastActivityAt;
      // 整份日志在同一时间补读，不能拿它回填或覆盖实时采集的 timing。
      if (!current.cleaned && !current.worktreeRemoved && !(await worktreeMissing(current))) {
        current.changedFiles = await changedFiles(current);
        await saveDiff(current);
      }
      // collect 只补救报告缺失，不把失联或人工停止伪装为正常退出。
      if (current.state === 'failed' && current.exit === 0) { current.state = 'done'; delete current.error; }
    });
    report(join(jobDir(job.id), 'report.md'));
  }
  await reconcileSafely();
}
export async function stop(id: string) {
  for (const job of await selectJobs(id)) {
    await updateJob(job.id, j => {
      if (!active(j) && j.state !== 'lost' && !alive(j.setupPid)) return;
      j.stopRequested = true;
      killGroup(j.setupPid, 'SIGKILL');
      if (alive(j.pid)) {
        try { process.kill(j.pid!, 'SIGTERM'); return; }
        catch (e) { if (!hasCode(e, 'ESRCH')) throw e; }
      }
      // 看管进程被杀时选手可能仍在，不能只改一个状态字。
      killGroup(j.workerPid, 'SIGKILL');
      finish(j, 'stopped');
    });
  }
  const deadline = Date.now() + 10_000;
  while ((await selectJobs(id)).some(active)) {
    if (Date.now() >= deadline) throw new Error('停止请求已经发出，但看管进程尚未收尾。请查看 supervisor.log 后再运行 status。');
    await sleep(50);
  }
  await reconcileSafely();
  return selectJobs(id);
}
export async function clean(id?: string, done = false, report: (text: string) => void = () => {}) {
  let jobs = await selectJobs(id);
  if (done) jobs = jobs.filter(j => !active(j) && !j.cleaned && j.decision?.kind !== 'adopt');
  return cleanJobs(jobs, report);
}
// 清一组任务：先检查整批，避免一半删掉后才发现另一半还在跑。小队 running 时先拦下它的队员。
export async function cleanJobs(jobs: Job[], report: (text: string) => void = () => {}) {
  for (const j of jobs) await guardTeamJob(j);
  for (const j of jobs) checkClean(j);
  checkRated(jobs);
  for (const job of jobs) {
    if (job.cleaned) continue;
    let note = '';
    let failure: { error: unknown } | undefined;
    // 清理完成并释放任务锁后才修正状态，避免重复申请任务锁。
    await updateJob(job.id, async j => {
      checkClean(j);
      checkRated([j]);
      try {
        const missing = j.worktreeRemoved || !(await exists(j.worktree));
        if (missing) {
          note = await exists(join(jobDir(j.id), 'diff.patch'))
            ? '；副本已不在，沿用之前存的 diff.patch' : '；副本已不在，没有可存的改动';
        }
        if (!j.worktreeRemoved) {
          if (!missing) {
            try { j.changedFiles = await changedFiles(j); await saveDiff(j); }
            catch (e) {
              // 保留准备失败、人工停止任务原有的清理行为。
              if (j.state !== 'failed' && j.state !== 'stopped') throw e;
            }
          }
          // 真实路径要在副本删除前解析；失败重试时沿用已保存的路径。
          if (!j.chat) {
            if (isolationOf(j.who) === 'grok' && !j.pendingGrokSessions) j.pendingGrokSessions = await grokSessionsOf(j.worktree);
            await removeWorktree(j);
            j.worktreeRemoved = new Date().toISOString();
          }
        }
        const sessions = j.chat ? [] : j.pendingGrokSessions ?? (isolationOf(j.who) === 'grok' ? await grokSessionsOf(j.worktree) : []);
        const remaining = [];
        for (const path of sessions) if (await exists(path)) remaining.push(path);
        // 移不进废纸篓只提醒，不挡住清理，否则任务会一直清不掉。
        if (remaining.length) await moveToTrash(remaining, `Grok会话-${j.id}`).catch(e => { note += `；没能把 Grok 会话文件夹移进废纸篓：${(e as Error).message}`; });
        delete j.pendingGrokSessions;
        await removeTree(cursorStateDir(j));
        // 2026-09-30 之前的 Cursor 状态放在任务目录下。
        await removeTree(join(jobDir(j.id), 'cursor-state'));
        await removeTree(jobTmpDir(j));
        j.cleaned = new Date().toISOString();
      } catch (error) {
        // 回调必须正常返回，才能在锁内保存已经完成的进度；出锁后再报错。
        failure = { error };
      }
    });
    if (failure) throw failure.error;
    report(`${job.chat ? '已清理成员任务，群副本和分支保留' : '已清理副本和分支，任务记录保留'}：${job.id}${note}`);
  }
  await reconcileSafely();
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (e) { if (hasCode(e, 'ENOENT')) return false; throw e; }
}
// Grok 在 ~/.grok/sessions 下给每个副本建一个会话文件夹（派活时只放开它写，见 sandbox.ts）。清理时一起移进废纸篓，
// 用派活时同一个算法算路径，只移确实存在的；算不出来（路径不规范）就不动。
export async function grokSessionsOf(worktree: string) {
  const dirs = await grokSessionDirs(worktree).catch(() => [] as string[]);
  const found: string[] = [];
  for (const dir of dirs) if (await lstat(dir).then(() => true, () => false)) found.push(dir);
  return found;
}
function checkRated(jobs: Job[]) {
  const missing = jobs.filter(j => j.decision && !j.rating);
  if (missing.length) throw new Error(`这些任务已拍板但还没打分：${missing.map(j => j.id).join('、')}。请先 xagents rate <任务号> --score 1-5，再清理。`);
}
function checkClean(j: Job) {
  if (alive(j.setupPid)) throw new Error(`任务 ${j.id} 的准备进程仍在，请先 xagents stop ${j.id}。`);
  if (active(j) || (!j.started && alive(j.queuedBy))) throw new Error(`任务 ${j.id} 仍在运行或准备，请先 stop 并等派发命令退出，再 clean。`);
  if (j.state === 'lost' && alive(j.workerPid)) throw new Error(`任务 ${j.id} 失联后选手可能仍在运行，请先 xagents stop ${j.id}。`);
}
