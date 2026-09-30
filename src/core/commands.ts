import { join } from 'node:path';
import { lstat, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { active, selectJobs, updateJob, finish } from './job.ts';
import type { Job } from './job.ts';
import { alive, hasCode, writeAtomic } from './fsx.ts';
import { jobDir } from './paths.ts';
import { result } from './workers.ts';
import { saveDiff, changedFiles, removeWorktree } from './worktree.ts';
import { cursorStateDir, grokSessionDirs, jobTmpDir } from './sandbox.ts';
import { isolationOf } from './roster.ts';
import { moveToTrash } from './trash.ts';
import { killGroup, reconcileSafely } from './runner.ts';
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
      if (!current.cleaned) {
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
  // 先检查整批，避免一半删掉后才发现另一半还在跑。
  for (const j of jobs) checkClean(j);
  checkRated(jobs);
  for (const job of jobs) {
    if (job.cleaned) continue;
    let warning = '';
    // 清理完成并释放任务锁后才修正状态，避免重复申请任务锁。
    await updateJob(job.id, async j => {
      checkClean(j);
      checkRated([j]);
      try { j.changedFiles = await changedFiles(j); await saveDiff(j); }
      catch (e) {
        // setup 或 worktree add 失败时可能根本没有副本。
        if (j.state !== 'failed' && j.state !== 'stopped') throw e;
      }
      // 副本还在时先算出 Grok 的会话文件夹（算真实路径要用到副本），删完副本再移走。
      const sessions = isolationOf(j.who) === 'grok' ? await grokSessionsOf(j.worktree) : [];
      await removeWorktree(j);
      if (sessions.length) await moveToTrash(sessions, `Grok会话-${j.id}`).catch(e => { warning = `；没能把 Grok 会话文件夹移进废纸篓：${(e as Error).message}`; });
      await rm(cursorStateDir(j), { recursive: true, force: true });
      // 2026-09-30 之前的 Cursor 状态放在任务目录下。
      await rm(join(jobDir(j.id), 'cursor-state'), { recursive: true, force: true });
      await rm(jobTmpDir(j), { recursive: true, force: true });
      j.cleaned = new Date().toISOString();
    });
    report(`已清理副本和分支，任务记录保留：${job.id}${warning}`);
  }
  await reconcileSafely();
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
