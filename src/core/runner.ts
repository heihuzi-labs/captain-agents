import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { jobDir } from './paths.ts';
import { updateJob, finish, listJobs } from './job.ts';
import type { Job } from './job.ts';
import { LiveProgress } from './live.ts';
import { writeAtomic, hasCode, readOptional } from './fsx.ts';
import { saveDiff, worktreeMissing } from './worktree.ts';
import { keepAwake } from './awake.ts';
import { SleepMonitor } from './sleeps.ts';
import { readQuotaCache } from './quota.ts';
import { collectRealSteps } from './real.ts';
import { cursorToken } from './workers.ts';
import { workerEnv } from './env.ts';

export function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid || pid <= 0) return;
  try { process.kill(-pid, signal); }
  catch (e) { if (!hasCode(e, 'ESRCH')) throw e; }
}
export async function reconcileSafely() {
  try { await listJobs(true); }
  catch (e) { console.error(`修正任务状态失败：${(e as Error).message}。请运行 xagents status --all 重试。`); }
}
async function watch(id: string, progress: LiveProgress, signal: AbortSignal) {
  const sleeps = new SleepMonitor(id);
  while (!signal.aborted) {
    try { await sleep(2000, undefined, { signal }); }
    catch (e) { if (signal.aborted) return; throw e; }
    if (signal.aborted) return;
    try {
      const slept = await sleeps.sample();
      await progress.sample();
      if (await progress.persist() || slept) await reconcileSafely();
    } catch (e) { console.error(`读取任务进度失败：${(e as Error).message}，下次采集重试。`); }
  }
}
export async function runWorker(id: string) {
  let stopping = false, workerPid: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let job: Job | undefined, progress: LiveProgress | undefined, code: number | null = null, failure: string | undefined;
  const stop = () => {
    stopping = true;
    killGroup(workerPid, 'SIGTERM');
    // 某些选手不响应 SIGTERM，宽限后仍必须收尾整个组。
    timer ??= setTimeout(() => killGroup(workerPid, 'SIGKILL'), 1000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const claimed = await updateJob(id, j => {
      if (j.state !== 'queued') return;
      if (j.stopRequested) { finish(j, 'stopped'); return; }
      j.pid = process.pid; j.started = new Date().toISOString(); j.state = 'running';
    });
    if (claimed.state !== 'running' || claimed.pid !== process.pid) return;
    job = claimed;
    await reconcileSafely();
    if (!job.command) throw new Error('没有保存选手命令，请重新派发。');
    const cmd = job.command, dir = jobDir(id);
    const handles = [];
    const controller = new AbortController();
    let polling: Promise<void> | undefined;
    let releaseAwake: (() => Promise<void>) | undefined;
    try {
      const output = await open(join(dir, 'run.log'), 'w', 0o600); handles.push(output);
      const errors = await open(join(dir, 'stderr.log'), 'w', 0o600); handles.push(errors);
      const input = cmd.stdin === 'prompt' ? await open(join(dir, 'prompt.md'), 'r') : undefined;
      if (input) handles.push(input);
      if (!stopping) {
        // 名字带密钥字样的环境变量不交给选手（规则在 env.ts）；平台设的照给，这件活点名不要的再去掉。
        const env = workerEnv(process.env, cmd.env, cmd.unset);
        // Cursor 的登录在隔离外现取，只放进这次进程的环境，不进任务记录（见 workers.ts 的 cursorToken）。
        // 必须放在上面那步过滤之后：它的名字带 TOKEN，先加再过滤就会被去掉，Cursor 就成了没登录。
        // 替身模式下没指定假的 security 就不取，测试不碰真钥匙串。
        if (cmd.login === 'cursor' && (!process.env.XAGENTS_FAKE_WORKER || process.env.XAGENTS_SECURITY)) env.CURSOR_AUTH_TOKEN = await cursorToken();
        const child = spawn(cmd.file, cmd.args, { cwd: job.worktree, detached: true, env, stdio: [input?.fd ?? 'ignore', output.fd, errors.fd] });
        const spawned = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        workerPid = child.pid;
        const finished = new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        // 马上接上拒绝处理，避免登记过程中 spawn 失败产生未处理拒绝。
        finished.catch(() => {});
        await spawned;
        await updateJob(id, j => { j.workerPid = workerPid; });
        releaseAwake = await keepAwake();
        progress = new LiveProgress(job);
        polling = watch(id, progress, controller.signal);
        if (stopping) stop();
        code = await finished;
      }
    } finally {
      controller.abort();
      await polling;
      await releaseAwake?.();
      if (timer) clearTimeout(timer);
      killGroup(workerPid, 'SIGKILL');
      await Promise.all(handles.map(fd => fd.close()));
    }
  } catch (error) {
    failure = `${(error as Error).message} 请查看任务目录中的日志。`;
  } finally {
    if (timer) clearTimeout(timer);
    killGroup(workerPid, 'SIGKILL');
    const quotaAfter = job ? await readQuotaCache() : null;
    try {
      if (job) {
        progress ??= new LiveProgress(job);
        // 停止、失败也收集已经留下的输出，结束状态最后一次性写入。
        try { await progress.sample(true); }
        catch (e) { console.error(`收尾读取进度失败：${(e as Error).message}`); }
        const dir = jobDir(id);
        const parsed = progress.parser.result(await readOptional(join(dir, 'final.md')));
        await writeAtomic(join(dir, 'report.md'), parsed.report ? parsed.report + '\n' : '');
        if (await worktreeMissing(job)) console.error('副本已不在，没法保存改动。');
        else try { await saveDiff(job); }
        catch (e) { console.error(`保存改动失败：${(e as Error).message}。请运行 collect 重试。`); }
        await updateJob(id, j => {
          Object.assign(j, { quota_after: quotaAfter });
          collectRealSteps(j, parsed.report);
          progress!.apply(j); j.exit = code;
          if (stopping || j.stopRequested) finish(j, 'stopped');
          else finish(j, !failure && code === 0 && parsed.report ? 'done' : 'failed', failure || (code !== 0 ? `选手退出码为 ${code}，请查看 stderr.log 和原始输出。` : !parsed.report ? '选手没有留下报告，请查看原始输出后运行 xagents collect。' : undefined));
        });
      }
    } catch (e) {
      await updateJob(id, j => {
        if (j.state === 'running') {
          Object.assign(j, { quota_after: quotaAfter });
          progress?.apply(j); j.exit = code;
          finish(j, stopping ? 'stopped' : 'failed', stopping ? undefined : `${(e as Error).message} 请查看任务目录中的日志。`);
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      await reconcileSafely();
    }
  }
}
