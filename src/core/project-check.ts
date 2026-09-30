import { readdir, stat } from 'node:fs/promises';
import { dynamicChecks } from './project-check-run.ts';
import { join, relative, resolve, sep } from 'node:path';
import { paths, safeName } from './paths.ts';
import { readJson, writeJson, withLock } from './fsx.ts';
import { git } from './worktree.ts';
import { loadProject, relativePath } from './project.ts';
import type { Project } from './project.ts';
import type { VerifyStep } from './verify.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type CheckItem = {
  id: string;            // 稳定的英文键：git、clean、ignored、secrets、setup、verify
  title: string;         // 人话标题
  status: CheckStatus;   // ok 正常、warn 注意（能派活但要知道）、fail 不行（派活会出问题）
  detail: string;        // 人话说明，一两句，写事实
  fix?: string;          // 怎么修，一句话，能照着做
};
export type ProjectCheck = { at: string; seconds: number; items: CheckItem[]; ok: boolean };
export type Baseline = { at: string; ok: boolean; steps: VerifyStep[] };
export type DynamicResult = { items: CheckItem[]; baseline?: Baseline };
export type DynamicChecks = (project: Project) => Promise<DynamicResult>;

const item = (id: string, title: string, status: CheckStatus, detail: string, fix?: string): CheckItem => ({ id, title, status, detail, ...(fix ? { fix } : {}) });
const MAX_LISTED = 10;

// 名字只用来判断是不是疑似密钥文件，文件内容一律不读。
const secretName = (name: string) => {
  const n = name.toLowerCase();
  if (n === '.env.example' || n === '.env.sample') return false;
  return n === '.env' || n.startsWith('.env.') || /\.(pem|key|p12)$/.test(n) || (n.startsWith('id_rsa') && !n.endsWith('.pub'))
    || /^credentials.*\.json$/.test(n) || /^service-account.*\.json$/.test(n) || n === '.npmrc' || n === '.netrc';
};
const shell = (text: string) => /^[\p{L}\p{N}_@%+=:,./-]+$/u.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
const cleanDeny = (path: string) => path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

async function findSecrets(project: Project) {
  const skipRoot = resolve(project.repo, project.worktreeRoot);
  const denied = project.denyReadExtra.map(cleanDeny);
  const found: string[] = [];
  const walk = async (dir: string, top: boolean) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (top) throw e; return; }   // 子目录读不了就跳过，项目根读不了要报出来
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) { if (full !== skipRoot) await walk(full, false); continue; }
      if (secretName(entry.name)) found.push(relative(project.repo, full).split(sep).join('/'));
    }
  };
  await walk(project.repo, true);
  return found.filter(path => !denied.some(d => path === d || path.startsWith(`${d}/`))).sort();
}

// 让主人能照抄：把现有登记原样带上，再加新的禁读路径（重新登记会整份覆盖）。
function addCommand(project: Project, extra: string[]) {
  const parts = ['xagents', 'project', 'add', shell(project.name), shell(project.repo)];
  if (project.worktreeRoot !== '.claude/worktrees') parts.push('--worktree-root', shell(project.worktreeRoot));
  for (const c of project.setup) parts.push('--setup', shell(c));
  for (const c of project.verify) parts.push('--verify', shell(c));
  for (const p of [...project.denyReadExtra, ...extra]) parts.push('--deny-read', shell(p));
  if (project.rules) parts.push('--rules', shell(project.rules));
  return parts.join(' ');
}

async function gitCheck(project: Project): Promise<CheckItem> {
  const title = '是 git 仓库并且有提交';
  const dir = await stat(project.repo).catch(() => null);
  if (!dir?.isDirectory()) return item('git', title, 'fail', `找不到项目目录：${project.repo}`, '确认目录还在；搬了位置就用 xagents project add 重新登记');
  try { await git(project.repo, ['rev-parse', '--is-inside-work-tree']); }
  catch { return item('git', title, 'fail', `这个目录不是 git 仓库：${project.repo}`, '在项目目录里运行 git init，并做第一次提交'); }
  try { await git(project.repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); }
  catch { return item('git', title, 'fail', '仓库里还没有任何提交，派活要从提交开出副本', '先做一次提交：git add -A && git commit -m "初始提交"'); }
  const branch = (await git(project.repo, ['branch', '--show-current'])).trim();
  return branch ? item('git', title, 'ok', `当前分支 ${branch}`)
    : item('git', title, 'warn', '现在不在任何分支上（停在某一个提交），派活默认从这个提交开始', '想从某个分支开始，先 git switch 过去');
}

// 主目录里没提交的改动（不含副本目录）。选手的副本从已提交的代码开出来，看不到这些。派活时也用它把关。
export async function uncommitted(project: Project): Promise<string[]> {
  const root = relativePath(project.worktreeRoot).replace(/\/+$/, '');
  // -z 加 quotePath=false：中文等文件名原样返回；每项是“两位状态 + 空格 + 路径”，改名项后面多跟一个旧路径，跳过。
  const parts = (await git(project.repo, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all', '--', '.', `:(exclude,literal)${root}`])).split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    files.push(parts[i].slice(3));
    if (parts[i][0] === 'R' || parts[i][0] === 'C') i++;
  }
  return files;
}
async function cleanCheck(project: Project): Promise<CheckItem> {
  const lines = await uncommitted(project);
  return lines.length
    ? item('clean', '工作区有没提交的改动', 'warn', `有 ${lines.length} 个文件没提交，选手的副本看不到这些改动`, '先提交或自己收好再派活')
    : item('clean', '工作区是干净的', 'ok', '没有没提交的改动');
}

async function ignoredCheck(project: Project): Promise<CheckItem> {
  const root = relativePath(project.worktreeRoot).replace(/\/+$/, '');
  // 用副本目录下的一个假路径判断，这样“目录名/”写法和逐个副本的写法都认得出来。
  const hit = (await git(project.repo, ['check-ignore', '--', `${root}/xa-check-probe`], [0, 1])).trim();
  return hit
    ? item('ignored', '副本目录已被 git 忽略', 'ok', `${root} 已在忽略名单里，副本不会混进提交`)
    : item('ignored', '副本目录没被 git 忽略', 'warn', `${root} 没被忽略，副本会显示成没跟踪的新文件，容易被误提交`,
      `在 .gitignore 里加一行 ${root}/；只想在本机生效，就把这一行加进 .git/info/exclude`);
}

async function secretsCheck(project: Project): Promise<CheckItem> {
  const found = await findSecrets(project);
  if (!found.length) return item('secrets', '没发现疑似密钥文件', 'ok', '只看文件名，没读任何文件内容');
  const listed = found.slice(0, MAX_LISTED);
  const shown = found.length > MAX_LISTED ? `${listed.join('、')} 等 ${found.length} 个` : listed.join('、');
  return item('secrets', '有疑似密钥的文件', 'warn', `发现疑似密钥文件：${shown}`,
    `把它们设成选手不许读：${addCommand(project, listed)}（重新登记会整份覆盖，已带上现有设置）`);
}

const setupItem = (project: Project) => project.setup.length
  ? item('setup', '有装依赖的命令', 'ok', `登记了 ${project.setup.length} 条，派活时先在副本里跑`)
  : item('setup', '没有装依赖的命令', 'ok', '没登记，副本开好就直接开工');
const verifyItem = (project: Project) => project.verify.length
  ? item('verify', '有验收命令', 'ok', `登记了 ${project.verify.length} 条`)
  : item('verify', '没有验收命令', 'warn', '没有验收命令，交回的活只能靠人看', '登记时加 --verify "测试命令"');

// 只读：不改被检查的仓库（git 走 GIT_OPTIONAL_LOCKS=0，不刷新索引）。
export async function staticChecks(project: Project): Promise<CheckItem[]> {
  const guard = async (id: string, title: string, fn: () => Promise<CheckItem>) => {
    try { return await fn(); }
    catch (e) { return item(id, title, 'warn', `没能检查：${(e as Error).message}`); }
  };
  const first = await gitCheck(project);
  const items = [first];
  if (first.status !== 'fail') {
    items.push(await guard('clean', '工作区状态', () => cleanCheck(project)), await guard('ignored', '副本目录是否被忽略', () => ignoredCheck(project)));
  }
  if ((await stat(project.repo).catch(() => null))?.isDirectory()) items.push(await guard('secrets', '疑似密钥文件', () => secretsCheck(project)));
  items.push(setupItem(project), verifyItem(project));
  return items;
}

// 完整体检里的动态检查放在 K2 的文件里，用到才加载；--quick 完全不碰它。

export async function checkProject(name: string, options: { quick?: boolean } = {}, deps: { dynamic?: DynamicChecks } = {}): Promise<ProjectCheck> {
  safeName(name);
  const project = await loadProject(name);
  const started = Date.now();
  let items = await staticChecks(project);
  let baseline: Baseline | undefined;
  if (!options.quick) {
    const result = await (deps.dynamic || dynamicChecks)(project);
    baseline = result.baseline;
    // 动态检查的同名项（setup、verify）比“有没有登记”更准，直接替换；其余接在后面。
    const before = items;
    items = [...before.map(i => result.items.find(r => r.id === i.id) || i), ...result.items.filter(r => !before.some(i => i.id === r.id))];
  }
  const check: ProjectCheck = { at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 100) / 10, items, ok: !items.some(i => i.status === 'fail') };
  const file = join(paths().projects, `${name}.json`);
  // 在锁里重新读、只改 check（完整体检再改 baseline），别的字段原样保留。
  await withLock(paths().projects, async () => {
    const record = await readJson<Record<string, unknown>>(file);
    record.check = check;
    if (!options.quick) { if (baseline) record.baseline = baseline; else delete record.baseline; }
    await writeJson(file, record);
  });
  return check;
}
