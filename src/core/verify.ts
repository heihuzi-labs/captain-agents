import { spawn } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { hasCode, withLock } from './fsx.ts';
import { paths, jobDir } from './paths.ts';
import { readJob, updateJob, active } from './job.ts';
import { loadProject } from './project.ts';

export type Execution = { exit: number | null; output: string; timedOut: boolean; signal?: string; error?: string };
export type Executor = (file: string, args: string[], cwd: string, timeoutMs: number, onData?: (text: string) => void, env?: NodeJS.ProcessEnv) => Promise<Execution>;
export type VerifyStep = { cmd: string; ok: boolean; exit: number | null; summary: string };
export type Verification = { ok: boolean; at: string; seconds: number; steps: VerifyStep[] };

// 每条命令独立进程组；正常退出也清掉它遗留的后台子进程。
export const execute: Executor = async (file, args, cwd, timeoutMs, onData, env) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('命令超时必须是有效的正数。');
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, error: string | undefined, interrupted: string | undefined;
    const kill = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); }
      catch (e) { if (!hasCode(e, 'ESRCH')) error = `无法停止进程组：${(e as Error).message}`; }
    };
    const onInt = () => { interrupted = 'SIGINT'; kill(); };
    const onTerm = () => { interrupted = 'SIGTERM'; kill(); };
    process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const data = (b: Buffer) => { const text = b.toString('utf8'); output = (output + text).slice(-262144); onData?.(text); };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('error', e => { error = e.message; });
    child.once('exit', kill);
    child.once('close', (exit, signal) => {
      clearTimeout(timer); kill(); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
      resolve({ exit, output, timedOut, ...(interrupted || signal ? { signal: interrupted || signal! } : {}), ...(error ? { error } : {}) });
    });
  });
};
export function testCounts(output: string): { total: number; passed: number; failed: number } | null {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const count = (name: string) => [...plain.matchAll(new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, 'gm'))].at(-1)?.[1];
  const total = count('tests'), passed = count('pass'), failed = count('fail');
  if (total !== undefined && passed !== undefined && failed !== undefined) return { total: +total, passed: +passed, failed: +failed };
  const line = [...plain.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1];
  if (line) {
    const total = line.match(/\((\d+)\)/)?.[1];
    const passed = line.match(/(\d+)\s+passed/)?.[1], failed = line.match(/(\d+)\s+failed/)?.[1];
    if (total && (passed || failed)) return { total: +total, passed: +(passed || 0), failed: +(failed || 0) };
  }
  return null;
}
export function checkFor(value: unknown) {
  const v = value as Verification | undefined;
  if (!v || typeof v.ok !== 'boolean' || !Array.isArray(v.steps)) return null;
  const counts = v.steps.map(s => testCounts(s.summary));
  const failed = v.steps.filter(s => !s.ok);
  const sums = counts.reduce<{ total: number; passed: number; failed: number }>((a, n) => ({ total: a.total + (n?.total || 0), passed: a.passed + (n?.passed || 0), failed: a.failed + (n?.failed || 0) }), { total: 0, passed: 0, failed: 0 });
  return { ok: v.ok, label: v.ok ? (counts.length && counts.every(Boolean) ? `通过 ${sums.passed}/${sums.total}` : `通过 ${v.steps.length} 项`) : `没过 ${sums.failed || failed.length || 1} 项`, note: v.ok ? '' : failed.map(s => s.summary).join('；') };
}
// 沿用带死锁回收的登记锁，但排队不受它的 10 秒上限影响。
export async function withVerifyLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = createHash('sha256').update(await realpath(repo)).digest('hex');
  const dir = join(paths().cache, 'verify-project', key);
  while (true) {
    let acquired = false;
    try { return await withLock(dir, () => { acquired = true; return fn(); }); }
    catch (e) {
      if (acquired || !(e instanceof Error) || !e.message.startsWith('等待文件锁超过 10 秒：')) throw e;
      await sleep(50);
    }
  }
}
export function verifyTimeoutMinutes(value: unknown = 20): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value * 60000 > 2_147_483_647) throw new Error('verifyTimeoutMinutes 必须是有效的正数。');
  return value;
}
export async function executeLogged(cmd: string, cwd: string, minutes: number, fd: FileHandle, run: Executor, logLabel = '验收'): Promise<Execution> {
  // 串联日志写入，保留全量输出；解析只用末尾 256 KiB。
  let pending = Promise.resolve();
  let logError: unknown;
  let result: Execution;
  try { result = await run('/bin/sh', ['-c', cmd], cwd, minutes * 60000, text => {
    pending = pending.then(async () => { if (!logError) await fd.write(text); }).catch(e => { logError = e; });
  }); } catch (e) { result = { exit: null, timedOut: false, output: '', error: (e as Error).message }; }
  await pending;
  if (logError) result.error = `写${logLabel}日志失败：${String(logError)}`;
  return result;
}
export async function verifyCommands(commands: string[], cwd: string, logfile: string, timeoutMinutes = 20, run: Executor = execute, mode: 'w' | 'a' = 'w'): Promise<Verification> {
  const minutes = verifyTimeoutMinutes(timeoutMinutes);
  const started = Date.now(), steps: VerifyStep[] = [];
  const fd = await open(logfile, mode, 0o600);
  try {
    for (const cmd of commands) {
      await fd.write(`\n执行：${cmd}\n`);
      const result = await executeLogged(cmd, cwd, minutes, fd, run);
      const counts = testCounts(result.output);
      const ok = result.exit === 0 && !result.timedOut && !result.signal && !result.error && (!counts || counts.failed === 0);
      const reason = result.timedOut ? `超时（${minutes} 分钟），已停止进程组` : result.error || (result.signal ? `进程被 ${result.signal} 停止` : `退出码 ${result.exit}`);
      const summary = (counts ? `# tests ${counts.total}\n# pass ${counts.passed}\n# fail ${counts.failed}\n` : '') + (ok ? (counts ? '' : '命令通过') : reason);
      steps.push({ cmd, ok, exit: result.exit, summary: summary.trim() });
      await fd.write(`\n结果：${steps.at(-1)!.summary}\n`);
      if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') break;
    }
  } finally { await fd.close(); }
  const result: Verification = { ok: steps.length === commands.length && steps.every(s => s.ok), at: new Date().toISOString(), seconds: (Date.now() - started) / 1000, steps };
  return result;
}
export async function verify(id: string, run: Executor = execute): Promise<Verification> {
  const original = await readJob(id);
  return withVerifyLock(original.repo, async () => {
    const job = await readJob(id);
    if (active(job)) throw new Error('任务还在运行，请等结束后再验收。');
    if (job.cleaned) throw new Error('副本已清理，不能再验收。');
    const project = await loadProject(job.project) as Awaited<ReturnType<typeof loadProject>> & { verifyTimeoutMinutes?: number };
    if (!Array.isArray(project.verify) || !project.verify.length || project.verify.some(c => typeof c !== 'string' || !c.trim())) throw new Error('项目还没有有效的 verify 命令，请先补全项目设置。');
    const result = await verifyCommands(project.verify, job.worktree, join(jobDir(id), 'verify.log'), project.verifyTimeoutMinutes ?? 20, run);
    await updateJob(id, current => { current.verify = result; });
    return result;
  });
}
