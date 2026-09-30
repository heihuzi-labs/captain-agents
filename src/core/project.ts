import { realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { paths, safeName } from './paths.ts';
import { readJson, writeJson, withLock } from './fsx.ts';
import { git } from './worktree.ts';
import type { ProjectCheck } from './project-check.ts';
import type { VerifyStep } from './verify.ts';
import { listJobs } from './job.ts';
import { writeSettings } from './settings.ts';
import { hasCode } from './fsx.ts';

// check：最近一次接入体检；baseline：完整体检时在干净副本里跑出的验收底子。
export type Project = { name: string; label?: string; repo: string; worktreeRoot: string; setup: string[]; verify: string[]; denyReadExtra: string[]; rules?: string;
  check?: ProjectCheck; baseline?: { at: string; ok: boolean; steps: VerifyStep[] } };
export function relativePath(path: string) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..') || path === '.') throw new Error(`路径必须在仓库内且不能包含 ..：${path}。请填写相对路径。`);
  return path;
}
export async function loadProject(name: string): Promise<Project> {
  const p = await readJson<Pick<Project, 'repo'> & Partial<Project>>(join(paths().projects, `${safeName(name)}.json`));
  return { setup: [], verify: [], denyReadExtra: [], worktreeRoot: '.claude/worktrees', ...p, name };
}
export async function listProjects() {
  return Promise.all((await readdir(paths().projects)).filter(n => n.endsWith('.json')).sort().map(n => loadProject(n.slice(0, -5))));
}
// 给主人看的显示名（界面上的字要中文，项目名常是英文代号）：1–20 字，不含控制字符。
export function checkLabel(label: string) {
  const n = [...label.trim()].length;
  if (!n || n > 20 || /[\u0000-\u001f\u007f-\u009f]/u.test(label)) throw new Error('显示名请写 1–20 字，不能含控制字符。');
  return label.trim();
}
// 只改显示名，登记的其他内容（体检结果、验收底子等）原样保留。
export async function setProjectLabel(name: string, label: string) {
  safeName(name); const clean = checkLabel(label);
  return withLock(paths().projects, async () => {
    const file = join(paths().projects, `${name}.json`);
    const current = await readJson<Record<string, unknown>>(file).catch(() => { throw new Error(`没有登记叫 ${name} 的项目，先用 xagents project add 登记。`); });
    await writeJson(file, { ...current, label: clean });
    return clean;
  });
}
export async function addProject(name: string, repo: string, options: Partial<Project>) {
  safeName(name);
  const root = await realpath((await git(resolve(repo), ['rev-parse', '--show-toplevel'])).trim());
  const worktreeRoot = relativePath(options.worktreeRoot || '.claude/worktrees');
  for (const path of options.denyReadExtra || []) relativePath(path);
  const p: Project = { name, repo: root, worktreeRoot, setup: options.setup || [], verify: options.verify || [], denyReadExtra: options.denyReadExtra || [] };
  if (options.rules) p.rules = await realpath(resolve(options.rules));
  if (options.label !== undefined) p.label = checkLabel(options.label);
  await withLock(paths().projects, () => writeJson(join(paths().projects, `${name}.json`), p));
  return p;
}
export async function findProject(name?: string, cwd = process.cwd()) {
  if (name) return loadProject(name);
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  const common = await realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const matches: Project[] = [];
  for (const p of await listProjects()) {
    if (await realpath(p.repo) === root) matches.push(p);
    else {
      const other = await realpath((await git(p.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
      if (other === common) matches.push(p);
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? '同一个仓库登记了多个项目，请用 --project 指定名字。' : '当前仓库还没登记，请先运行 xagents project add <名字> <仓库路径>。');
  return matches[0];
}
export async function worktreePath(project: Project, id: string) {
  relativePath(project.worktreeRoot);
  for (const extra of project.denyReadExtra) relativePath(extra);
  const target = resolve(project.repo, project.worktreeRoot, `xa-${id}`);
  // 对已有父目录做 realpath，拒绝借符号链接把副本开到仓库外。
  let current = project.repo;
  for (const segment of relative(project.repo, target).split('/').slice(0, -1)) {
    current = join(current, segment);
    const resolved = await realpath(current).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return current; throw e; });
    const rel = relative(project.repo, resolved);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('副本目录通过符号链接指向了仓库外，请修改 --worktree-root。');
  }
  return target;
}

// 归档或取消归档一个项目：什么都不删，只记进设置的 archivedProjects。
// 项目不必登记过，任务里出现过的也行；名单里没有的名字用人话报错。重复归档、重复取消结果一样，不报错。
export async function setArchived(name: string, archived: boolean): Promise<boolean> {
  safeName(name);
  const jobs = await listJobs().catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; });
  const known = new Set([...(await listProjects()).map(p => p.name), ...jobs.map(job => job.project).filter(Boolean)]);
  if (!known.has(name)) throw new Error(`没有叫 ${name} 的项目。用 xagents project list 看登记过的项目。`);
  // 在设置的锁里读当前名单再改，两个项目同时归档也不会丢。
  await writeSettings(current => ({ archivedProjects: archived ? [...current.archivedProjects, name] : current.archivedProjects.filter(n => n !== name) }));
  return archived;
}
