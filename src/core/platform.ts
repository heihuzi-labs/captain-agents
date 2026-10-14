// 两种系统做法不同的地方集中在这里：起进程、停整棵进程树、跑一条外壳命令。
// 别处不再各写各的 process.platform 判断；规则见 docs/design-windows.md 第 5 节。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { processRows } from './native-windows.ts';
import type { ProcessRow as Row } from './native-windows.ts';

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
// macOS：独立进程组，之后按组停。Windows 没有进程组：不脱离父进程（父进程一退，系统会连它一起收走；但只带走这一个，
// 它自己又起的子孙不会跟着走，见 stillRunning），也不弹控制台窗口。
export const treeSpawn = (): { detached?: true; windowsHide?: true } => isWindows ? { windowsHide: true } : { detached: true };
// 起一个要比自己活得久的后台进程（看管进程、推进进程）。
export const backgroundSpawn = (): { detached: true; windowsHide?: true } => isWindows ? { detached: true, windowsHide: true } : { detached: true };

export type TreeSignal = 'SIGTERM' | 'SIGKILL';
// Windows 的进程快照（进程号、父进程号、创建时间）直接问系统要，不启动别的程序：native-windows.ts 的 processRows。

// 从快照里找出 root 这棵树上还活着的进程（父在前、子在后）。
// Windows 的进程号回收得很快（实测：流水线上一条命令退出一两秒后，它的号就被别的测试的进程拿去用了），
// 所以认进程只看号不行，处处要看创建时间：
// - 子进程一定不比父进程早出生；早出生的只是父进程号被重用后撞上的无关进程。
// - since 是我们起 root 的时间。root 还在跑时，快照里叫这个号的进程要在 since 前 2 秒到后 5 秒之间出生，才认它是我们的 root；
//   更晚出生的是重用这个号的无关进程，更早出生的说明 since 给得不对，两种都不碰它。
// - exitedAt 是我们看到 root 退出的时间。给了它，就绝不碰叫这个号的进程（那只可能是重用者），
//   只收 root 生前留下的子孙：父进程号是它、出生不早于 since、不晚于它退出。
// - bornBy 是另一种上限，给“不知道 root 什么时候退的、只知道这件活什么时候算结束”的情况用：root 已经不在（或号被重用）时，
//   只收出生不晚于它的子孙。root 出生也不能晚于它（否则是重用者）；root 还在而且是我们的，子孙不受这个上限限制。不给这个上限就别去找一件早就结束的活留下的子孙：
//   这么久里用过这个号的无关进程，它们的子进程都会被当成“留下的”。
// - 不知道 since 又没给 exitedAt：只能按号认（和 macOS 上按进程组号认是同一种信任）。
const BEFORE = 2000, AFTER = 5000;
const matchingBirth = (created: number, since?: number) => since === undefined || created >= since - BEFORE && created <= since + AFTER;
// 单个进程的身份判断；纯逻辑供测试构造进程表，也和进程树共用同一套时间容差。
export function processMatches(rows: Row[], pid: number | undefined, since?: number): boolean {
  if (!Number.isInteger(pid) || pid! <= 0) return false;
  const row = rows.find(row => row.pid === pid);
  return !!row && matchingBirth(row.created, since);
}
// 记进程号时一起记系统给的出生时间；macOS 不记。Windows 读不到不能把新记录悄悄降成“按号认”的老记录。
let selfSince: number | undefined;
export function processSince(pid: number | undefined): number | undefined {
  if (!isWindows) return undefined;
  // 自己的出生时间不会变，记一次就够（拿锁时每次都要用，不必每次读整张进程表）。
  if (pid === process.pid && selfSince !== undefined) return selfSince;
  const row = processRows().find(row => row.pid === pid);
  if (!row) throw new Error(`读不到进程 ${pid} 的出生时间，不能登记它。`);
  if (pid === process.pid) selfSince = row.created;
  return row.created;
}
// macOS 和没有出生时间的旧记录完全沿用按号探测（包括 EPERM 算在）；Windows 新记录还要核对出生时间。
export function alive(pid: number | undefined, since?: number): boolean {
  if (!Number.isInteger(pid) || pid! <= 0) return false;
  try { process.kill(pid!, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  return !isWindows || since === undefined || processMatches(processRows(), pid, since);
}

export function treeOf(rows: Row[], root: number, since?: number, exitedAt?: number, bornBy?: number): number[] {
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
  const ours = exitedAt === undefined && self && self.created <= (bornBy ?? Infinity)
    && matchingBirth(self.created, since);
  if (ours) { out.push(root); walk(root, self.created); }
  else if (since !== undefined && (exitedAt !== undefined || !self || self.created > since + AFTER || self.created > (bornBy ?? Infinity))) {
    walk(root, since - BEFORE, Math.min(exitedAt ?? Infinity, bornBy ?? Infinity, self ? self.created : Infinity));
  }
  return out;
}

// 记录里的这个进程号，现在指的还是不是我们当初起的那个进程。
// macOS：进程号很久才回收，只看在不在。Windows：号回收得很快（实测：活结束后记录里留着的选手进程号被别的进程拿去用，
// 平台误以为“选手还在跑”），所以在的话再核对创建时间；since 是当初起它的时间，没有就只能按在不在算。
// leftBy 只在 Windows 上有用：父进程没了，它起的子孙照样活着（实测 2026-10-13：派活进程被直接杀掉时，系统只带走它直接起的
// 那一个，再下一层的还在跑，还占着副本目录）。给了 leftBy（这件活结束的时间，还没结束就给现在），它自己不在了也要看它有没有
// 留下出生不晚于 leftBy 的子孙，有就算还在，stop 才会去收。进程刚结束的头几毫秒里，系统配给它的控制台进程还没退完，也算还在。
// 调用方已经看到 root 退出时给 exitedAt，和 killTree 一样绝不再认同号的进程，只找它退出之前留下的子孙。
export function stillRunning(pid: number | undefined, since?: number, leftBy?: number, exitedAt?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (exitedAt !== undefined && (!isWindows || since === undefined || leftBy === undefined)) return false;
  if (isWindows && since !== undefined && leftBy !== undefined) return treeOf(processRows(), pid, since, exitedAt, leftBy).length > 0;
  return alive(pid, since);
}

// 起选手之前确认停得了它：Windows 上停整棵树要先读得到进程列表。读不到就抛错，看管进程因此不起选手（停不了的选手不启动）。
export function assertTreeControl(): void {
  if (isWindows) processRows();
}

// 停掉 pid 带出来的整棵进程树；树已经不在了不算错。
// macOS：给进程组发信号（pid 必须是用 treeSpawn 起的组长）。
// Windows：没有“请你退出”的信号，两种信号都是直接结束。since 填起这个进程的时间（毫秒）；
// 已经看到它退出了、只是清它留下的子孙时，再填 exitedAt（看到它退出的时间）；没看到它退出、只知道这件活哪一刻算结束的，
// 填 bornBy（见 treeOf）。
export function killTree(pid: number | undefined, signal: TreeSignal, since?: number, exitedAt?: number, bornBy?: number): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (!isWindows) {
    try { process.kill(-pid, signal); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    return;
  }
  for (const target of treeOf(processRows(), pid, since, exitedAt, bornBy)) {
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
// 已知的差别（实测）：Git 的 sh 把命令交给 Windows 程序时，参数里成对的反斜杠会被折成一个，
// 关掉它的“路径转换”（MSYS_NO_PATHCONV、MSYS2_ARG_CONV_EXCL）也一样。所以命令里要写路径时用正斜杠。
export function shell(command: string): { file: string; args: string[] } {
  if (!isWindows) return { file: '/bin/sh', args: ['-c', command] };
  return { file: cachedSh ??= findSh(), args: ['-c', command] };
}
