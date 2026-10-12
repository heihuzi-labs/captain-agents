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

// 调系统接口用的模块（koffi）在安装目录的 node_modules 里。群和小队的推进进程跑的是代码快照，快照不带 node_modules：
// 和 srt 一样，由起它的一方用环境变量告诉它模块在哪（wake.ts 的 engineEnvironment）。
export const koffiPath = (env: NodeJS.ProcessEnv = process.env): string => env.XAGENTS_KOFFI || join(toolRoot, 'node_modules', 'koffi');
let loaded: Koffi | undefined;
function koffi(): Koffi {
  if (loaded) return loaded;
  // 下面读进程列表时按 64 位系统的结构取数（x64 和 ARM64 一样）。
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) throw new Error(`这一步只在 64 位的 Windows 上做（现在是 ${process.platform}-${process.arch}）。`);
  const from = koffiPath();
  // 不叫 require：桌面应用的主程序是打成一个文件的，这个模块不打进去，运行时从上面那个目录取。
  try { return loaded = createRequire(join(from, 'package.json'))(from) as Koffi; }
  catch (error) { throw new Error(`加载不了调系统接口用的模块（${from}）：${(error as Error).message}。请重新安装派活工作台。`, { cause: error }); }
}

const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1;
let setState: ((flags: number) => number) | undefined;
// 向系统申请“别因空闲休眠”，返回撤掉申请的函数。申请挂在提出它的进程上：进程一没（哪怕是被直接结束），申请就没了。
export function holdAwake(): () => void {
  setState ??= koffi().load('kernel32.dll').func('uint32_t __stdcall SetThreadExecutionState(uint32_t flags)') as unknown as NonNullable<typeof setState>;
  // 返回的是上一次的状态，0 表示系统没接受。
  if (!setState((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0)) throw new Error('系统没有接受防休眠的申请。');
  return () => { setState!(ES_CONTINUOUS); };
}

const TOO_SMALL = -1073741820;   // 0xC0000004：给的地方不够大
let query: ((cls: number, buffer: Buffer, length: number, returned: number[]) => number) | undefined;
// 进程快照：进程号、父进程号、创建时间（毫秒）。一次系统调用读出全部进程，不用逐个打开，所以别的账户的进程也读得到，
// 也不需要管理员身份。一次两三毫秒。读不到创建时间的不要（和原来的做法一样）。
export function processRows(): ProcessRow[] {
  query ??= koffi().load('ntdll.dll').func('int32_t __stdcall NtQuerySystemInformation(int32_t cls, void *buffer, uint32_t length, _Out_ uint32_t *returned)') as unknown as NonNullable<typeof query>;
  let size = 1 << 20, buffer = Buffer.alloc(0), status = TOO_SMALL;
  for (let i = 0; i < 6 && status === TOO_SMALL; i++) {
    buffer = Buffer.alloc(size);
    const returned = [0];
    status = query!(5, buffer, size, returned);
    size = Math.max(size * 2, returned[0] + (1 << 16));
  }
  if (status !== 0) throw new Error(`读取进程列表失败：系统返回 0x${(status >>> 0).toString(16)}`);
  const rows: ProcessRow[] = [];
  // 每一条开头是“下一条在多远”，0 表示最后一条；创建时间在第 0x20 字节（1601 年起的百纳秒数），进程号在 0x50，父进程号在 0x58。
  for (let at = 0; at + 0x60 <= buffer.length;) {
    const next = buffer.readUInt32LE(at), created = buffer.readBigInt64LE(at + 0x20);
    if (created > 0n) rows.push({ pid: Number(buffer.readBigUInt64LE(at + 0x50)), parent: Number(buffer.readBigUInt64LE(at + 0x58)), created: Number(created / 10000n) - 11644473600000 });
    if (!next) break;
    at += next;
  }
  return rows;
}

const FO_DELETE = 3, RECYCLE_FLAGS = 0x4 | 0x10 | 0x40 | 0x400;   // 不出进度窗、不问、能撤销（进回收站）、出错不弹窗
let fileOperation: ((op: Record<string, unknown>) => number) | undefined;
// 把一个文件夹整个送进回收站。没成功就抛错，东西还在原处。
export function recycleFolder(folder: string): void {
  if (!fileOperation) {
    const k = koffi();
    k.struct('SHFILEOPSTRUCTW', { hwnd: 'void *', wFunc: 'uint32_t', pFrom: 'str16', pTo: 'str16', fFlags: 'uint16_t', fAnyOperationsAborted: 'int32_t', hNameMappings: 'void *', lpszProgressTitle: 'str16' });
    fileOperation = k.load('shell32.dll').func('int __stdcall SHFileOperationW(SHFILEOPSTRUCTW *op)') as unknown as NonNullable<typeof fileOperation>;
  }
  // 系统要的是“一串路径，最后多一个空字符”：这里自己加一个，另一个是字符串本来的结尾。
  const code = fileOperation!({ hwnd: null, wFunc: FO_DELETE, pFrom: folder + '\0', pTo: null, fFlags: RECYCLE_FLAGS, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null });
  if (code !== 0 || existsSync(folder)) throw new Error(`送进回收站没成功（系统返回 ${code}）。东西还在 ${folder}`);
}
