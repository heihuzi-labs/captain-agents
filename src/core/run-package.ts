// 首轮与续接共用：新包独立生成，入口最后写；调用方在任务锁里一次性切换记录。
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson, writeJson } from './fsx.ts';
import type { Command, Job } from './job.ts';
import { jobDir, toolRoot } from './paths.ts';
import { relativePath } from './project.ts';
import { isolationOf } from './roster.ts';
import { codexPermissions, sandbox } from './sandbox.ts';
import type { Isolated } from './sandbox.ts';
import { command, resumeCommand } from './workers.ts';

type Isolation = NonNullable<Job['isolation']>;
type Permission = 'read' | 'write' | 'deny';
type CodexPolicy = { kind: 'codex'; base: string; network: boolean; files: Map<string, Permission> };
type SrtPolicy = { kind: 'srt'; denyRead: string[]; allowWrite: string[]; denyWrite: string[]; network: unknown };
type Policy = CodexPolicy | SrtPolicy;
const fail = (why: string): never => { throw new Error(`无法确认旧隔离约束一条没丢，拒绝续接：${why}`); };
const unique = (items: string[]) => [...new Set(items)];
const absolute = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

// 只识别平台曾生成的这套 TOML 写法；不能完整解析的旧权限表绝不猜测。
// 从头一条一条往后认，认完条目后剩下的必须正好是结尾（带或不带联网那一段）。
// 不用一条大正则去“框”中间：联网开着时结尾多一段，贪婪匹配会把它吞进条目里（2026-10-10 真实探针抓到）。
function codexPolicy(value: string): CodexPolicy {
  const head = /^permissions\.xa=\{extends="(:read-only|:workspace)",filesystem=\{/.exec(value);
  if (!head) return fail('旧 Codex 权限表格式不受支持。');
  const files = new Map<string, Permission>();
  const entry = /("(?:[^"\\\u0000-\u001f]|\\["\\])*")="(read|write|deny)"/y;
  let offset = head[0].length;
  while (value[offset] !== '}') {
    entry.lastIndex = offset;
    const part = entry.exec(value);
    if (!part) return fail('Codex 权限条目无法完整解析。');
    const path = JSON.parse(part[1]) as string;
    if (files.has(path)) return fail('Codex 权限路径重复。');
    files.set(path, part[2] as Permission);
    offset = entry.lastIndex;
    if (value[offset] === ',') { if (value[++offset] === '}') return fail('Codex 权限条目不完整。'); }
    else if (value[offset] !== '}') return fail('Codex 权限条目不完整。');
  }
  const tail = value.slice(offset);
  if (tail !== '}}' && tail !== '},network={enabled=true}}') return fail('Codex 权限表的结尾不是平台生成的样子。');
  return { kind: 'codex', base: head[1], network: tail !== '}}', files };
}
function commandPolicy(cmd: Command): CodexPolicy {
  const values = cmd.args.filter(arg => arg.startsWith('permissions.'));
  if (values.length !== 1 || !cmd.args.includes('default_permissions="xa"')) return fail('找不到唯一的 Codex 权限表。');
  return codexPolicy(values[0]);
}
function srtPolicy(value: unknown): SrtPolicy {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || Object.keys(value).some(k => !['filesystem', 'network'].includes(k)) || !object(value.filesystem))
    return fail('srt 设置包含无法核对的规则。');
  const fs = value.filesystem;
  if (Object.keys(fs).some(k => !['denyRead', 'allowWrite', 'denyWrite'].includes(k))) return fail('srt 文件权限包含未知字段。');
  const list = (key: string) => {
    const rows = fs[key];
    if (!Array.isArray(rows) || !rows.every(p => typeof p === 'string')) return fail(`srt 的 ${key} 不是路径列表。`);
    return rows.map(absolute);
  };
  return { kind: 'srt', denyRead: list('denyRead'), allowWrite: list('allowWrite'), denyWrite: list('denyWrite'), network: value.network };
}
const denied = (policy: Policy) => policy.kind === 'codex'
  ? [...policy.files].filter(([, p]) => p === 'deny').map(([p]) => p) : policy.denyRead;
function contains(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') ? rel : undefined;
}
async function previousPolicy(job: Job): Promise<Policy> {
  if (!job.command) return fail('没有保存上一轮的命令。');
  if (isolationOf(job.who) === 'codex') return commandPolicy(job.command);
  const args = job.command.args, index = args.indexOf('--settings');
  const file = args[index + 1];
  if (index < 0 || !file || !contains(jobDir(job.id), file)) return fail('旧 sandbox.json 不在本任务目录内。');
  return srtPolicy(await readJson(file));
}
async function generatedPolicy(job: Job, isolated: Isolation): Promise<Policy> {
  return isolationOf(job.who) === 'codex'
    ? codexPolicy(codexPermissions(job, isolated, undefined, job.network === true))
    : srtPolicy(await sandbox(job, isolated, undefined, undefined, job.network === true));
}
function noWeaker(old: Policy, next: Policy) {
  if (old.kind === 'codex' && next.kind === 'codex') {
    if (old.base !== next.base || old.network !== next.network) return fail('Codex 只读模式或联网权限发生变化。');
    const rank = { write: 0, read: 1, deny: 2 };
    for (const [path, permission] of old.files) {
      const current = next.files.get(path);
      if (!current || rank[current] < rank[permission]) return fail(`旧权限没有保留：${path}`);
    }
    // 新的 read/write 例外可能穿透旧的父目录禁读；只接受新禁读或已存在的、更严的例外。
    for (const [path, permission] of next.files) {
      if (permission !== 'deny' && !old.files.has(path)) return fail(`出现新的读写例外：${path}`);
    }
  } else if (old.kind === 'srt' && next.kind === 'srt') {
    for (const key of ['denyRead', 'denyWrite'] as const)
      if (old[key].some(path => !next[key].includes(path))) return fail(`srt 的 ${key} 少了旧条目。`);
    if (next.allowWrite.some(path => !old.allowWrite.includes(path))) return fail('srt 新增了可写位置。');
    if (!isDeepStrictEqual(old.network, next.network)) return fail('srt 网络规则发生变化。');
  } else return fail('隔离类型发生变化。');
}
function checkEnvironment(old: Command, next: Command) {
  for (const [key, value] of Object.entries(old.env))
    if (next.env[key] !== value) return fail(`运行环境 ${key} 发生变化。`);
  if (old.unset?.some(key => !next.unset?.includes(key))) return fail('环境变量过滤少了旧条目。');
  const policies = (cmd: Command) => cmd.args.filter(arg => arg.startsWith('shell_environment_policy='));
  if (!isDeepStrictEqual(policies(old), policies(next))) return fail('Codex 环境变量过滤无法证明兼容。');
  for (let i = 0; i < old.args.length; i++) {
    if (old.args[i] === '--disable' && !next.args.some((arg, n) => arg === '--disable' && next.args[n + 1] === old.args[i + 1]))
      return fail(`不再禁用 ${old.args[i + 1]}。`);
  }
}

export type PreparedRun = { runtime: string; entry: string; command: Command; actual: Command; isolation: Isolation; round: number };
export async function prepareRun(job: Job, text: string, project: Isolated, resume?: NonNullable<Job['resume']>): Promise<PreparedRun> {
  const round = resume?.round ?? 1;
  const runtime = join('runtime', `r${round}-${randomUUID()}`), dir = join(jobDir(job.id), runtime);
  try {
    // “平台当前的版本”就是正在跑这段代码的这一份：派活的命令行是安装目录；群的推进进程每次启动都重拍快照（wake.ts 的
    // engineSnapshot），所以它自己就是当时的平台。包从 toolRoot 拍，规则用本进程里的生成器，代码和规则是同一版，不混用。
    // 不按算出来的路径去动态加载别处的模块：桌面应用打包前的检查不允许（scripts/check-desktop-bundle.mjs），也不该在隔离外这样做。
    await mkdir(dir, { recursive: true });
    for (const part of ['src', 'sandbox', 'rules.md', 'package.json']) {
      await cp(join(toolRoot, part), join(dir, part), { recursive: true,
        filter: source => source !== join(toolRoot, 'src/core/worker-entry.ts') });
    }
    const isolation: Isolation = {
      denyReadExtra: unique([...(job.isolation?.denyReadExtra ?? []), ...project.denyReadExtra]),
      denyReadHome: unique([...(job.isolation?.denyReadHome ?? []), ...(project.denyReadHome ?? [])]),
    };
    for (const path of [...isolation.denyReadExtra, ...isolation.denyReadHome]) relativePath(path);
    const previous = resume ? await previousPolicy(job) : undefined;
    if (previous) {
      const current = new Set(denied(await generatedPolicy(job, isolation)));
      // 老任务没有保存额外禁读输入时，从实际生效的旧权限中恢复；仓库与副本两边都加上。
      for (const path of denied(previous)) {
        if (current.has(path)) continue;
        const extra = contains(job.worktree, path) ?? contains(job.repo, path);
        const home = contains(homedir(), path);
        if (extra) isolation.denyReadExtra.push(relativePath(extra));
        else if (home) isolation.denyReadHome.push(relativePath(home));
        else return fail(`旧禁读无法合入当前规则：${path}`);
      }
      isolation.denyReadExtra = unique(isolation.denyReadExtra);
      isolation.denyReadHome = unique(isolation.denyReadHome);
    }
    const settings = isolationOf(job.who) === 'codex' ? undefined : await sandbox(job, isolation, undefined, undefined, job.network === true);
    if (settings) await writeJson(join(dir, 'sandbox.json'), settings);
    const fresh = await command(job, text, isolation, dir);
    if (previous) {
      noWeaker(previous, settings ? srtPolicy(settings) : commandPolicy(fresh));
      checkEnvironment(job.command!, fresh);
    }
    const actual = resume ? resumeCommand({ ...job, command: fresh, resume }) : fresh;
    await writeJson(join(dir, 'versions.json'), { node: process.version,
      tool: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, snapshotted: new Date().toISOString() });
    await writeJson(join(dir, 'launch.json'), { round, command: fresh, actual, isolation });
    const entry = join(dir, 'src/core/worker-entry.ts');
    await cp(join(toolRoot, 'src/core/worker-entry.ts'), entry);
    return { runtime, entry, command: fresh, actual, isolation, round };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`第 ${round} 轮运行包准备失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// 只改锁内的内存记录；updateJob 的原子写把命令、包引用和历史一起发布。
export function usePreparedRun(job: Job, prepared: PreparedRun) {
  const launches = job.launches ??= [];
  if (job.command && !launches.length) {
    // 旧实现从未覆盖第一轮基础命令，历轮只做固定续接变形，可以据此补齐旧命令记录。
    if (!job.runtime) {
      launches.push({ round: 1, runtime: 'runtime', command: structuredClone(job.command) });
      for (let round = 2; round <= (job.resume?.round ?? 1); round++)
        launches.push({ round, runtime: 'runtime', command: resumeCommand({ ...job, resume: { round, prompt: `prompt-r${round}.md` } }) });
    } else launches.push({ round: job.resume?.round ?? 1, runtime: job.runtime,
      command: structuredClone(job.resume ? resumeCommand(job) : job.command) });
  }
  launches.push({ round: prepared.round, runtime: prepared.runtime, command: prepared.actual });
  job.command = prepared.command;
  job.runtime = prepared.runtime;
  job.isolation = prepared.isolation;
}

// 运行包每轮一份（约 0.7MB），群开得久了会越攒越多：切换成功后只留当前和上一轮的，更早的删掉。
// 每一轮实际用过的命令仍记在任务记录的 launches 里，追查不靠旧包。只删平台自己按“r<轮次>-<编号>”建的目录。
export async function prunePackages(job: Pick<Job, 'id' | 'launches'>) {
  const keep = new Set((job.launches ?? []).slice(-2).map(l => l.runtime)), root = join(jobDir(job.id), 'runtime');
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!/^r\d+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name) || keep.has(join('runtime', name))) continue;
    await rm(join(root, name), { recursive: true, force: true });
  }
}
