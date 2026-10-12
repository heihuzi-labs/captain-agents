// 两种系统做法不同的地方集中在这里：起进程、停整棵进程树、跑一条外壳命令。
// 别处不再各写各的 process.platform 判断；规则见 docs/design-windows.md 第 5 节。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path, { dirname, join } from 'node:path';

export const isWindows = process.platform === 'win32';

// 只比较路径，不访问文件系统；符号链接由调用方先 realpath。
// 返回空串表示根目录自身，undefined 表示在外面（包括另一个盘符或 UNC 共享）。
export function relativeInside(root: string, candidate: string, implementation = path): string | undefined {
  const rel = implementation.relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${implementation.sep}`) || implementation.isAbsolute(rel) ? undefined : rel;
}
export function samePath(left: string, right: string, implementation = path): boolean {
  return implementation.relative(left, right) === '';
}
export function expandHomePath(value: string, home: string, implementation = path): string {
  return value.startsWith('~/') || value.startsWith(`~${implementation.sep}`) ? implementation.join(home, value.slice(2)) : value;
}

// 起一棵“以后要整棵停掉”的进程树（选手、验收命令、准备命令）。
// macOS：独立进程组，之后按组停。Windows 没有进程组：不脱离父进程（父进程一退，系统会连它一起收走），也不弹控制台窗口。
export const treeSpawn = (): { detached?: true; windowsHide?: true } => isWindows ? { windowsHide: true } : { detached: true };
// 起一个要比自己活得久的后台进程（看管进程、推进进程）。
export const backgroundSpawn = (): { detached: true; windowsHide?: true } => isWindows ? { detached: true, windowsHide: true } : { detached: true };

export type TreeSignal = 'SIGTERM' | 'SIGKILL';
type Row = { pid: number; parent: number; created: number };

// Windows 的进程快照：进程号、父进程号、创建时间（毫秒）。用系统自带的 PowerShell 读，一次约一秒。
const SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" } }';
export function parseSnapshot(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), parent: Number(m[2]), created: Number(m[3]) });
  }
  return rows;
}
function snapshot(): Row[] {
  const file = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(file, ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (r.error || r.status !== 0) throw new Error(`读取进程列表失败：${r.error?.message || (r.stderr || '').trim().slice(0, 300) || `退出码 ${r.status}`}`);
  return parseSnapshot(r.stdout);
}
// 从快照里找出 root 这棵树上还活着的进程（父在前、子在后）。
// Windows 的进程号回收得很快（实测：流水线上一条命令退出一两秒后，它的号就被别的测试的进程拿去用了），
// 所以认进程只看号不行，处处要看创建时间：
// - 子进程一定不比父进程早出生；早出生的只是父进程号被重用后撞上的无关进程。
// - since 是我们起 root 的时间。root 还在跑时，快照里叫这个号的进程要在 since 前 2 秒到后 5 秒之间出生，才认它是我们的 root；
//   更晚出生的是重用这个号的无关进程，更早出生的说明 since 给得不对，两种都不碰它。
// - exitedAt 是我们看到 root 退出的时间。给了它，就绝不碰叫这个号的进程（那只可能是重用者），
//   只收 root 生前留下的子孙：父进程号是它、出生不早于 since、不晚于它退出。
// - 不知道 since 又没给 exitedAt：只能按号认（和 macOS 上按进程组号认是同一种信任）。
const BEFORE = 2000, AFTER = 5000;
export function treeOf(rows: Row[], root: number, since?: number, exitedAt?: number): number[] {
  const byParent = new Map<number, Row[]>();
  for (const row of rows) byParent.set(row.parent, [...(byParent.get(row.parent) ?? []), row]);
  const self = rows.find(row => row.pid === root);
  const out: number[] = [], seen = new Set<number>([root]);
  const walk = (pid: number, born: number, until = Infinity) => {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid) || child.created < born || child.created > until) continue;
      seen.add(child.pid); out.push(child.pid); walk(child.pid, child.created);
    }
  };
  const ours = exitedAt === undefined && self && (since === undefined || (self.created >= since - BEFORE && self.created <= since + AFTER));
  if (ours) { out.push(root); walk(root, self.created); }
  else if (since !== undefined && (exitedAt !== undefined || !self || self.created > since + AFTER)) walk(root, since - BEFORE, Math.min(exitedAt ?? Infinity, self ? self.created : Infinity));
  return out;
}

// 停掉 pid 带出来的整棵进程树；树已经不在了不算错。
// macOS：给进程组发信号（pid 必须是用 treeSpawn 起的组长）。
// Windows：没有“请你退出”的信号，两种信号都是直接结束。since 填起这个进程的时间（毫秒）；
// 已经看到它退出了、只是清它留下的子孙时，再填 exitedAt（看到它退出的时间）。
export function killTree(pid: number | undefined, signal: TreeSignal, since?: number, exitedAt?: number): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (!isWindows) {
    try { process.kill(-pid, signal); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    return;
  }
  for (const target of treeOf(snapshot(), pid, since, exitedAt)) {
    if (target === process.pid) continue;
    try { process.kill(target, 'SIGKILL'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
}

// 跑一条外壳命令（项目登记的验收、准备命令）。两种系统都用 sh，同一条命令两边写法一样。
// Windows 上用 Git 自带的 sh（Git 本来就是必装的）；XAGENTS_SH 可以另指一个。不用 PATH 上的 bash：那可能是 WSL 的入口。
let cachedSh: string | undefined;
export function findSh(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync,
  where: () => string[] = () => (spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)): string {
  if (env.XAGENTS_SH) return env.XAGENTS_SH;
  for (const git of where()) {
    // git.exe 可能在 <Git>\cmd、<Git>\bin 或 <Git>\mingw64\bin 下，往上找到装着 sh 的那一层。
    let dir = dirname(git);
    for (let i = 0; i < 3; i++, dir = dirname(dir)) {
      for (const sh of [join(dir, 'bin', 'sh.exe'), join(dir, 'usr', 'bin', 'sh.exe')]) if (exists(sh)) return sh;
    }
  }
  throw new Error('找不到 Git 自带的 sh。请先安装 Git for Windows，并确认命令行里能运行 git。');
}
export function shell(command: string): { file: string; args: string[] } {
  if (!isWindows) return { file: '/bin/sh', args: ['-c', command] };
  return { file: cachedSh ??= findSh(), args: ['-c', command] };
}
