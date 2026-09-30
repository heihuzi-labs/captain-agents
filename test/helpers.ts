import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { View } from '../src/core/view-types.ts';
import type { Job } from '../src/core/job.ts';

export const root = resolve(import.meta.dirname, '..');
export const fixture = join(root, 'test/fixtures/worker.ts');
export async function until<T>(fn: () => Promise<T>, accept: (value: T) => boolean = Boolean, timeout = 12000): Promise<T> {
  const end = Date.now() + timeout;
  while (true) {
    const value = await fn();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`等待条件超时，最后结果：${JSON.stringify(value)}`);
    await sleep(25);
  }
}
export async function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
export async function context(t: TestContext, repository = true) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'xagents-test-')));
  const home = join(temp, 'registry'), repo = join(temp, 'repo with spaces');
  await mkdir(home); await mkdir(repo);
  await mkdir(join(temp, 'user-home'));
  const env = { ...process.env, XAGENTS_TRASH: join(temp, 'trash'), XAGENTS_HOME: home, XAGENTS_CAFFEINATE: join(temp, 'no-caffeinate'), XAGENTS_FAKE_WORKER: fixture, XAGENTS_APPLICATIONS: join(temp, 'Applications'), XAGENTS_MAX_RUNNING: '6', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  delete env.XAGENTS_SRT;
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = repo) => exec(process.execPath, [join(root, 'src/cli/cli.ts'), ...args], cwd, { ...env, ...(['guide', 'connect'].includes(args[0]) ? { HOME: join(temp, 'user-home') } : {}), ...extra });
  const git = async (args: string[]) => {
    const r = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], repo, env);
    assert.equal(r.code, 0, r.stderr); return r.stdout.trim();
  };
  const jobs = async (): Promise<Job[]> => {
    const names = await readdir(join(home, 'jobs')).catch(() => []);
    const rows = await Promise.all(names.filter(n => !n.startsWith('.')).map(async n => {
      try { return JSON.parse(await readFile(join(home, 'jobs', n, 'job.json'), 'utf8')); } catch { return null; }
    }));
    return rows.filter(Boolean);
  };
  t.after(async () => {
    for (const job of await jobs()) {
      try { if (job.setupPid) process.kill(-job.setupPid, 'SIGKILL'); } catch {}
      try { if (job.workerPid) process.kill(-job.workerPid, 'SIGKILL'); } catch {}
      try { if (job.pid) process.kill(job.pid, 'SIGTERM'); } catch {}
    }
    await sleep(150);
    for (const job of await jobs()) { try { if (job.pid) process.kill(job.pid, 'SIGKILL'); } catch {} }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let base = '';
  if (repository) {
    await git(['init', '-b', 'main']);
    await writeFile(join(repo, 'base.txt'), '起点\n');
    await git(['add', 'base.txt']);
    const tree = await git(['write-tree']);
    base = await git(['commit-tree', tree, '-m', '测试起点']);
    await git(['update-ref', 'refs/heads/main', base]);
  }
  const task = join(temp, 'task.md'); await writeFile(task, '本题只运行测试替身。\n');
  const add = (extra: string[] = []) => cli(['project', 'add', '测试', repo, '--worktree-root', '.worktrees', ...extra]);
  return { temp, home, repo, env, cli, git, jobs, task, add, base };
}

// 在独立进程读取指定测试登记处，避免并发测试互相覆盖环境变量。
export async function desktopView(home: string): Promise<View> {
  const result = await exec(process.execPath, ['--input-type=module', '-e',
    "import { buildView } from './src/core/view.ts'; console.log(JSON.stringify(await buildView()));"], root,
    { ...process.env, XAGENTS_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as View;
}
