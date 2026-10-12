// Windows 上要问系统的三件事，直接调系统接口来做：申请“别因空闲休眠”、读进程列表、把文件夹送进回收站。
// 不启动任何别的程序。原来这三处各在后台起一个系统自带的 PowerShell，杀毒软件把“程序隐藏执行 PowerShell”当成可疑行为拦下来，
// 一拦，防休眠没了，选手也停不掉。每一处的写法都和原来的做法在三台真的 Windows 机器上逐项对过，
// 见 docs/research/windows-native-2026-10-13.md；改动要附新的探针结果（scripts/probe/windows-native.mjs）。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { toolRoot } from './paths.ts';

type Koffi = typeof import('koffi');
export type ProcessRow = { pid: number; parent: number; created: number };

// 调系统接口用的模块（koffi）在安装目录的 node_modules 里，自己目录里有就只用自己的，不听环境变量
// （命令行和桌面应用的主程序都是这种）。平台的后台进程（每件活的看管进程、群和小队的推进进程）跑的是代码快照，
// 快照不带 node_modules：只有这种情况才用起它的一方在环境变量里指的位置（node-runtime.ts 的 backgroundEnvironment）。
export function koffiPath(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync, root = toolRoot): string {
  const own = join(root, 'node_modules', 'koffi');
  return exists(join(own, 'package.json')) ? own : env.XAGENTS_KOFFI || own;
}
let loaded: Koffi | undefined;
function koffi(): Koffi {
  if (loaded) return loaded;
  // 下面读进程列表时按 64 位系统的结构取数（x64 和 ARM64 一样）。
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) throw new Error(`这一步只在 64 位的 Windows 上做（现在是 ${process.platform}-${process.arch}）。`);
  const from = koffiPath();
  // 这个模块不打进桌面应用的主程序，运行时从上面那个目录取。打包前的检查认得这一处，只放行这一处
  // （scripts/check-desktop-bundle.mjs 的 runtimeLoads），并核对安装包的平台目录里有它。
  try { return loaded = createRequire(join(from, 'package.json'))(from) as Koffi; }
  catch (error) { throw new Error(`加载不了调系统接口用的模块（${from}）：${(error as Error).message}。请重新安装派活工作台。`, { cause: error }); }
}

const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1;
let setState: ((flags: number) => number) | undefined;
// 向系统申请“别因空闲休眠”，返回撤掉申请的函数。申请挂在调用它的那个线程上：线程一没（进程退出、被直接结束都算），申请就没了。
// 所以必须在一直活着的主线程上同步调用（现在就是），不能改成放到别的线程去调。
export function holdAwake(): () => void {
  setState ??= koffi().load('kernel32.dll').func('uint32_t __stdcall SetThreadExecutionState(uint32_t flags)') as unknown as NonNullable<typeof setState>;
  // 返回的是上一次的状态，0 表示系统没接受。
  if (!setState((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0)) throw new Error('系统没有接受防休眠的申请。');
  return () => { if (!setState!(ES_CONTINUOUS)) throw new Error('系统没有接受撤掉防休眠的申请。'); };
}

// 系统给的进程列表是一条接一条的记录：每条开头 4 个字节是“下一条在多远”，0 表示最后一条；
// 创建时间在第 0x20 字节（1601 年起的百纳秒数），进程号在 0x50，父进程号在 0x58。length 是系统实际写了多少字节。
// 读不到创建时间的不要（和原来的做法一样）。记录对不上（跳到写过的范围外面、跳得比一条记录还短）就报错：不拿半份名单去判断谁还活着。
const RECORD = 0x60;
export function parseProcessRows(buffer: Buffer, length = buffer.length): ProcessRow[] {
  const end = Math.min(length, buffer.length), rows: ProcessRow[] = [];
  for (let at = 0; ;) {
    if (at + RECORD > end) throw new Error('读取进程列表失败：系统给的名单不完整。');
    const next = buffer.readUInt32LE(at), created = buffer.readBigInt64LE(at + 0x20);
    if (created > 0n) rows.push({ pid: Number(buffer.readBigUInt64LE(at + 0x50)), parent: Number(buffer.readBigUInt64LE(at + 0x58)), created: Number(created / 10000n) - 11644473600000 });
    if (!next) return rows;
    if (next < RECORD) throw new Error('读取进程列表失败：系统给的名单不完整。');
    at += next;
  }
}
const TOO_SMALL = -1073741820;   // 0xC0000004：给的地方不够大
let query: ((cls: number, buffer: Buffer, length: number, returned: number[]) => number) | undefined;
// 进程快照：进程号、父进程号、创建时间（毫秒）。一次系统调用读出全部进程，不用逐个打开，所以别的账户的进程也读得到，
// 也不需要管理员身份。一次两三毫秒。
export function processRows(): ProcessRow[] {
  query ??= koffi().load('ntdll.dll').func('int32_t __stdcall NtQuerySystemInformation(int32_t cls, void *buffer, uint32_t length, _Out_ uint32_t *returned)') as unknown as NonNullable<typeof query>;
  let size = 1 << 20;
  for (let i = 0; i < 6; i++) {
    const buffer = Buffer.alloc(size), returned = [0];
    const status = query(5, buffer, size, returned);
    if (status === 0) return parseProcessRows(buffer, returned[0] || size);
    if (status !== TOO_SMALL) throw new Error(`读取进程列表失败：系统返回 0x${(status >>> 0).toString(16)}`);
    size = Math.max(size * 2, returned[0] + (1 << 16));
  }
  throw new Error('读取进程列表失败：进程太多，名单一直装不下。');
}

const FO_DELETE = 3, RECYCLE_FLAGS = 0x4 | 0x10 | 0x40 | 0x400;   // 不出进度窗、不问、能撤销（进回收站）、出错不弹窗
type FileOperation = { async(op: Record<string, unknown>, done: (error: Error | null, code: number) => void): void };
let fileOperation: FileOperation | undefined;
// 把一个文件夹整个送进回收站。放到别的线程去做，不占着调用它的线程：文件多的时候系统要数一遍，桌面应用的主程序不能跟着卡住。
// 没做完就抛错。
export async function recycleFolder(folder: string): Promise<void> {
  if (!fileOperation) {
    const k = koffi();
    k.struct('SHFILEOPSTRUCTW', { hwnd: 'void *', wFunc: 'uint32_t', pFrom: 'str16', pTo: 'str16', fFlags: 'uint16_t', fAnyOperationsAborted: 'int32_t', hNameMappings: 'void *', lpszProgressTitle: 'str16' });
    fileOperation = k.load('shell32.dll').func('int __stdcall SHFileOperationW(SHFILEOPSTRUCTW *op)') as unknown as FileOperation;
  }
  // 系统要的是“一串路径，最后多一个空字符”：这里自己加一个，另一个是字符串本来的结尾。
  const op = { hwnd: null, wFunc: FO_DELETE, pFrom: folder + '\0', pTo: null, fFlags: RECYCLE_FLAGS, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null };
  const code = await new Promise<number>((done, fail) => fileOperation!.async(op, (error, result) => error ? fail(error) : done(result)));
  if (code !== 0 || existsSync(folder)) throw new Error(`送进回收站没做完（系统返回 ${code}）。请看一下 ${folder} 里还剩什么。`);
}
