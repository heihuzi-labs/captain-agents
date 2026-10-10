// 小队与项目群共用的续接、运行检查和收尾；启动命令与隔离仍由 workers/runner 负责。
import { access, rename, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from './dispatch.ts';
import { alive, hasCode, readOptional, writeAtomic, writeJson } from './fsx.ts';
import { active, finish, listJobs, readJob, updateJob } from './job.ts';
import type { Job, Usage } from './job.ts';
import { jobDir, paths, toolRoot } from './paths.ts';
import { loadProject } from './project.ts';
import { prepareRun, prunePackages, usePreparedRun } from './run-package.ts';
import { checkChoice } from './policy.ts';
import { checkQuota, ensureQuota } from './quota.ts';
import { isolationOf, vendorOf } from './roster.ts';
import { ensureSelfcheck } from './selfcheck.ts';
import { extraDenyRead, readSettings } from './settings.ts';
import { checkDeepseekLogin, refreshGrokLogin, result, selection, SESSION_RE } from './workers.ts';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sumUsage(rounds: { usage?: Usage }[]): Usage | undefined {
  let read = 0, cached = 0, out = 0, cacheWrite = 0, found = false, write = false;
  for (const round of rounds) {
    if (!round.usage) continue;
    found = true;
    read += round.usage.read; cached += round.usage.cached; out += round.usage.out;
    if (round.usage.cacheWrite !== undefined) { write = true; cacheWrite += round.usage.cacheWrite; }
  }
  if (!found) return undefined;
  return write ? { read, cached, out, cacheWrite } : { read, cached, out };
}

export function sessionFromOutput(who: Job['who'], raw: string): string | undefined {
  const isolation = isolationOf(who);
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | undefined;
    try { const value: unknown = JSON.parse(line); if (object(value)) row = value; } catch { /* 不是 JSON 就跳过 */ }
    if (isolation === 'codex') {
      if (row?.type === 'thread.started' && typeof row.thread_id === 'string' && SESSION_RE.test(row.thread_id)) return row.thread_id;
      continue;
    }
    if (isolation === 'grok') {
      const id = typeof row?.sessionId === 'string' ? row.sessionId : /"sessionId"\s*:\s*"([^"]+)"/.exec(line)?.[1];
      if (id && SESSION_RE.test(id)) return id;
    }
  }
  return undefined;
}

async function renameRound(dir: string, name: string, n: number) {
  const from = join(dir, name);
  const dot = name.lastIndexOf('.');
  const to = join(dir, `${name.slice(0, dot)}-r${n}${name.slice(dot)}`);
  try { await access(from); } catch (e) { if (hasCode(e, 'ENOENT')) return; throw e; }
  try { await access(to); return; } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
  await rename(from, to);
}
// 在任务锁里调用：这一轮已经不在跑。把用时抄进 rounds，并把日志改名为 run-r<n>.log 等。
export async function archiveFinished(job: Job, n: number) {
  if (!job.rounds?.some(round => round.n === n)) {
    if (!job.ended || !job.started) throw new Error(`任务 ${job.id} 还没有第 ${n} 轮的结束记录，没法续接。请查看任务日志。`);
    const usage = job.usage ? { ...job.usage } : undefined;
    (job.rounds ??= []).push({
      n, started: job.started, ended: job.ended, seconds: job.seconds ?? 0, exit: job.exit ?? null,
      ...(usage ? { usage } : {}), state: job.state,
    });
  }
  const dir = jobDir(job.id);
  for (const name of ['run.log', 'report.md', 'final.md', 'stderr.log']) await renameRound(dir, name, n);
  const dest = join(dir, `diff-r${n}.patch`);
  try { await access(dest); }
  catch (e) { if (!hasCode(e, 'ENOENT')) throw e; await writeAtomic(dest, await readOptional(join(dir, 'diff.patch'))); }
}

// 验收、真实验收和拍板说的都是“那一轮交上来的东西”。开始新一轮时把它们挪进那一轮的记录，任务记录回到
// “还没验收、还没拍板”——命令行、看板、菜单栏读到的就都是当前这一轮的真实状态，不用各自去猜哪条结果过期了。
// “需要真实验收”这个要求跟着任务走（派活时 --real 要的，或者哪一轮的报告列过检查步骤）：留着，宁可多问一次；
// 步骤和结果清空，等新一轮的报告再填。
export function shelveVerdicts(job: Job, n: number) {
  const round = job.rounds?.find(r => r.n === n);
  if (round) {
    if (job.verify !== undefined) round.verify = job.verify;
    if (job.verifySkip) round.verifySkip = job.verifySkip;
    if (job.realCheck) round.realCheck = job.realCheck;
    if (job.decision) round.decision = job.decision;
  }
  delete job.verify; delete job.verifySkip; delete job.decision;
  if (job.realCheck?.needed) job.realCheck = { needed: true, steps: [] }; else delete job.realCheck;
}

export async function rememberSession(job: Job): Promise<Job> {
  if (job.session) return job;
  const session = sessionFromOutput(job.who, await readOptional(join(jobDir(job.id), 'run.log')));
  if (!session) return job;
  return updateJob(job.id, current => { current.session ??= session; });
}

export async function readReport(job: Job) {
  const text = (await readOptional(join(jobDir(job.id), 'report.md'))).trim();
  return text || (await result(job)).report.trim();
}

export function foldRounds(job: Job) {
  if (job.state === 'queued' || job.state === 'running' || !job.ended || !job.started) return;
  if (!job.rounds?.some(round => round.ended === job.ended)) {
    const n = job.resume?.round ?? ((job.rounds?.at(-1)?.n ?? 0) + 1);
    const usage = job.usage ? { ...job.usage } : undefined;
    (job.rounds ??= []).push({
      n, started: job.started, ended: job.ended, seconds: job.seconds ?? 0, exit: job.exit ?? null,
      ...(usage ? { usage } : {}), state: job.state,
    });
  }
  const rounds = job.rounds ?? [];
  if (!rounds.length) return;
  job.started = rounds[0].started;
  job.seconds = rounds.reduce((sum, round) => sum + round.seconds, 0);
  const usage = sumUsage(rounds);
  if (usage) job.usage = usage; else delete job.usage;
}

export async function killEngine(pid: number | undefined) {
  if (!alive(pid)) return;
  try { process.kill(pid!, 'SIGTERM'); } catch (e) { if (!hasCode(e, 'ESRCH')) throw e; }
  const deadline = Date.now() + 8000;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  if (!alive(pid)) return;
  try { process.kill(pid!, 'SIGKILL'); } catch (e) { if (!hasCode(e, 'ESRCH')) throw e; }
}

export async function resumeMember(job: Job, round: number, promptBody: string): Promise<boolean> {
  // 看管进程写完结束状态后还有收尾工作；锁外给它退出的时间，不能拿着它需要的锁等它。
  const deadline = Date.now() + 8000;
  while (!active(job) && alive(job.pid) && Date.now() < deadline) await sleep(25);
  let cli = '';
  let start = false;
  await updateJob(job.id, async current => {
    if (current.resume?.round === round && (current.state === 'queued' || current.state === 'running')) return;
    if (current.state === 'queued' || current.state === 'running') throw new Error(`任务 ${current.id} 还在跑，不能叫醒下一轮。请等它结束或先 stop。`);
    if (current.cleaned || current.slimmed || current.worktreeRemoved) throw new Error(`任务 ${current.id} 已清理，不能续接。`);
    if (alive(current.workerPid) || alive(current.setupPid)) throw new Error(`任务 ${current.id} 仍有选手进程，请先停止。`);
    if (alive(current.pid)) throw new Error(`任务 ${current.id} 的上一轮看管进程还没退出，不能续接。`);
    // 联网总开关是主人的底线。成员的联网状态固定在第一次派活那一刻（开着联网派的，续接也带着联网）；
    // 主人后来把总开关关了，就不能照旧叫醒它。只收紧、不放宽：关着时派的成员，开关打开后续接仍然不联网。
    if (current.network === true && !(await readSettings()).networkAllowed)
      throw new Error(`这位成员是联网开着时派的，主人现在已关掉联网总开关，不能照旧续接。请负责人换一位新成员（新建一个群，或重新派活）。`);
    const project = await loadProject(current.project);
    if (project.repo !== current.repo) throw new Error('项目的仓库登记已经改变，不能给旧成员换运行包。');
    const resume = { round, prompt: `prompt-r${round}.md` };
    const prepared = await prepareRun(current, promptBody, { ...project, denyReadHome: await extraDenyRead() }, resume);
    // 准备失败不归档日志、不动验收和任务状态，也绝不使用旧包启动。
    await writeAtomic(join(jobDir(current.id), resume.prompt), promptBody);
    await archiveFinished(current, round - 1);
    shelveVerdicts(current, round - 1);
    usePreparedRun(current, prepared);
    cli = prepared.entry;
    current.resume = resume;
    current.state = 'queued';
    current.queuedBy = process.pid;
    delete current.ended; delete current.exit; delete current.error; delete current.stopRequested; delete current.usage;
    start = true;
  });
  if (!start) return false;
  try { const fresh = await readJob(job.id); await launch(fresh, cli); await prunePackages(fresh).catch(() => {}); }
  catch (e) {
    await updateJob(job.id, j => { if (j.state === 'queued') finish(j, 'failed', e instanceof Error ? e.message : String(e)); });
    throw e;
  }
  return true;
}

export async function wakeGate(choice: ReturnType<typeof selection>, project?: string): Promise<{ reason: 'blocked'; note: string } | null> {
  try {
    const settings = await readSettings();
    checkChoice(settings.workers, choice);
    if (project && settings.archivedProjects.includes(project)) throw new Error(`项目 ${project} 已归档，请先取消归档。`);
    checkQuota(await ensureQuota(), [choice], false, settings.limits.quotaStop);
    if (!process.env.XAGENTS_FAKE_WORKER) {
      await ensureSelfcheck();
      if (isolationOf(choice.who) === 'grok') await refreshGrokLogin();
      if (vendorOf(choice.who) === 'deepseek') await checkDeepseekLogin();
    }
    const temporaryMax = Number(process.env.XAGENTS_MAX_RUNNING ?? settings.limits.maxRunning);
    if (!Number.isInteger(temporaryMax) || temporaryMax < 1) throw new Error('XAGENTS_MAX_RUNNING 必须是正整数，请修正环境变量。');
    const max = Math.min(settings.limits.maxRunning, temporaryMax);
    const running = (await listJobs(true)).filter(active);
    if (running.length + 1 > max) return { reason: 'blocked', note: `同时最多跑 ${max} 件，现在已有 ${running.length} 件在跑或排队。请等空出来，或先停掉别的任务，再加一轮。` };
  } catch (e) {
    return { reason: 'blocked', note: e instanceof Error ? e.message : String(e) };
  }
  return null;
}

// 推进进程还要派新成员，快照必须带原隔离模板；只复制平台代码，不从群副本取代码。
// refresh：群是长期留着的，推进进程每次启动都换成平台现在的代码（平台修了什么，旧群下次被叫醒就用得上）；
// 调用方要保证这时没有推进进程在跑（chat-engine.ts 在群的锁里先确认）。小队是一次性的，照旧只拍一次。
export async function engineSnapshot(dir: string, name: 'chat-entry.ts' | 'team-entry.ts', refresh = false) {
  const runtime = join(dir, 'runtime'), entry = join(runtime, 'src/core', name);
  if (refresh) await rm(runtime, { recursive: true, force: true });
  else try { await access(entry); return entry; } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
  await mkdir(runtime, { recursive: true });
  for (const part of ['src', 'sandbox', 'rules.md', 'package.json']) {
    await cp(join(toolRoot, part), join(runtime, part), { recursive: true,
      filter: source => source !== join(toolRoot, 'src/core', name) });
  }
  const pkg = JSON.parse(await readFile(join(toolRoot, 'package.json'), 'utf8')) as { version?: string };
  await writeJson(join(dir, 'versions.json'), { node: process.version, tool: pkg.version, snapshotted: new Date().toISOString() });
  // 入口最后写，半份快照不会被下一次启动当作完整快照。
  await cp(join(toolRoot, 'src/core', name), entry);
  return entry;
}
export function engineEnvironment() {
  // srt 留在安装目录；快照里的 gate 仍按原 srtPath 检查，不修改启动参数或模板。
  return { ...process.env, XAGENTS_HOME: paths().home,
    XAGENTS_SRT: process.env.XAGENTS_SRT || join(toolRoot, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js') };
}
