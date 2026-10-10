import { nodeCommand, nodeRunner, externalEnvironment } from './node-runtime.ts';
import { readSettings } from './settings.ts';
import { checkChoice } from './policy.ts';
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
import { cursorToken, resumeCommand, selection } from './workers.ts';
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
  let fatalFailure: string | undefined;
  const message = (error: unknown) => {
    try { return String(error instanceof Error ? error.message : error).slice(0, 2000); }
    catch { return '未知异常'; }
  };
  const addFailure = (text: string) => { failure = failure ? `${failure} ${text}` : text; };
  const killWorker = () => {
    try { killGroup(workerPid, 'SIGKILL'); }
    catch (error) { addFailure(`停止选手进程组失败：${message(error)}`); }
  };
  let wakeFatal!: () => void;
  const fatalSignal = new Promise<void>(resolve => { wakeFatal = resolve; });
  // 事件处理器必须同步杀组，并接住自身的清理错误，不能再产生未处理拒绝。
  const fatal = (kind: string, error: unknown) => {
    fatalFailure ??= `看管进程${kind}：${message(error)}`;
    process.exitCode = 1;
    killWorker();
    wakeFatal();
  };
  const uncaught = (error: Error) => fatal('未捕获异常', error);
  const unhandled = (error: unknown) => fatal('未处理拒绝', error);
  const stop = () => {
    stopping = true;
    if (fatalFailure) { killWorker(); return; }
    killGroup(workerPid, 'SIGTERM');
    // 某些选手不响应 SIGTERM，宽限后仍必须收尾整个组。
    timer ??= setTimeout(() => killGroup(workerPid, 'SIGKILL'), 1000);
  };
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', unhandled);
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
    checkChoice((await readSettings()).workers, selection(`${job.who}:${job.effort}${job.fast ? ':fast' : ''}`));
    await reconcileSafely();
    if (!job.command) throw new Error('没有保存选手命令，请重新派发。');
    // 第 2 轮起：command 已由共用准备函数按本轮平台重建，这里只做既有的续接变形。
    const cmd = job.resume ? resumeCommand(job) : job.command, dir = jobDir(id);
    const handles = [];
    const controller = new AbortController();
    let polling: Promise<void> | undefined;
    let releaseAwake: (() => Promise<void>) | undefined;
    try {
      const output = await open(join(dir, 'run.log'), 'w', 0o600); handles.push(output);
      const errors = await open(join(dir, 'stderr.log'), 'w', 0o600); handles.push(errors);
      const input = cmd.stdin === 'prompt' ? await open(join(dir, job.resume?.prompt ?? 'prompt.md'), 'r') : undefined;
      if (input) handles.push(input);
      if (!stopping && !fatalFailure) {
        // 名字带密钥字样的环境变量不交给选手（规则在 env.ts）；平台设的照给，这件活点名不要的再去掉。
        const env = externalEnvironment(workerEnv(process.env, cmd.env, cmd.unset));
        // Cursor 的登录在隔离外现取，只放进这次进程的环境，不进任务记录（见 workers.ts 的 cursorToken）。
        // 必须放在上面那步过滤之后：它的名字带 TOKEN，先加再过滤就会被去掉，Cursor 就成了没登录。
        // 替身模式下没指定假的 security 就不取，测试不碰真钥匙串。
        if (cmd.login === 'cursor' && (!process.env.XAGENTS_FAKE_WORKER || process.env.XAGENTS_SECURITY)) env.CURSOR_AUTH_TOKEN = await cursorToken();
        if (stopping || fatalFailure) return;
        // srt 和测试替身用平台 Node；外部选手直接启动，不带 Electron 开关。
        const launch = cmd.file === nodeRunner().file ? nodeCommand(cmd.args, env) : { ...cmd, env };
        const child = spawn(launch.file, launch.args, { cwd: job.worktree, detached: true, env: launch.env, stdio: [input?.fd ?? 'ignore', output.fd, errors.fd] });
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
        // 在主流程等选手退出期间也及时接住采集任务的拒绝。
        polling.catch(unhandled);
        if (stopping) stop();
        code = await Promise.race([finished, fatalSignal.then(() => null)]);
      }
    } finally {
      // 清理最先停止选手；后续日志、采集或防休眠出错也不能遗留后台选手。
      if (timer) clearTimeout(timer);
      killWorker();
      controller.abort();
      const cleanups = [Promise.race([polling, fatalSignal]), Promise.resolve().then(() => releaseAwake?.()), ...handles.map(fd => fd.close())];
      for (const result of await Promise.allSettled(cleanups)) {
        if (result.status === 'rejected') addFailure(`看管收尾失败：${message(result.reason)}`);
      }
    }
  } catch (error) {
    addFailure(`${message(error)} 请查看任务目录中的日志。`);
  } finally {
    if (timer) clearTimeout(timer);
    killWorker();
    let quotaAfter: Awaited<ReturnType<typeof readQuotaCache>> = null;
    try {
      quotaAfter = job ? await readQuotaCache() : null;
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
          if (fatalFailure) finish(j, 'failed', [fatalFailure, failure].filter(Boolean).join(' '));
          else if (stopping || j.stopRequested) finish(j, 'stopped');
          else finish(j, !failure && code === 0 && parsed.report ? 'done' : 'failed', failure || (code !== 0 ? `选手退出码为 ${code}，请查看 stderr.log 和原始输出。` : !parsed.report ? '选手没有留下报告，请查看原始输出后运行 xagents collect。' : undefined));
        });
      }
    } catch (e) {
      await updateJob(id, j => {
        if (j.state === 'running') {
          Object.assign(j, { quota_after: quotaAfter });
          progress?.apply(j); j.exit = code;
          if (fatalFailure) finish(j, 'failed', [fatalFailure, failure, message(e)].filter(Boolean).join(' '));
          else finish(j, stopping ? 'stopped' : 'failed', stopping ? undefined : [failure, `${message(e)} 请查看任务目录中的日志。`].filter(Boolean).join(' '));
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await reconcileSafely();
        // 连收尾阶段出现的致命错误也必须覆盖已写入的成功/停止状态。
        if (job && fatalFailure) await updateJob(id, j => {
          finish(j, 'failed', [fatalFailure, failure].filter(Boolean).join(' '));
        });
      } finally {
        process.off('SIGTERM', stop); process.off('SIGINT', stop);
        process.off('uncaughtException', uncaught); process.off('unhandledRejection', unhandled);
      }
    }
  }
}
