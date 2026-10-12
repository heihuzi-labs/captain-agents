// 探针：平台在 Windows 上有三处要在后台启动系统自带的 PowerShell（防休眠、读进程列表、送进回收站）。
// 杀毒软件会把“程序隐藏执行 PowerShell”当成可疑行为拦下来。这里量的是：不启动任何别的程序，
// 用 koffi 直接调系统接口，三件事做不做得成，结果和现在的 PowerShell 做法是不是一样（docs/design-windows.md 第 13 节）。
//   一、加载：koffi 在这个运行时里装不装得上（平台的 Node、应用自己的程序以 Node 方式运行，都要量）。
//   二、防休眠：SetThreadExecutionState 之后系统的申请名单里有没有我们；撤掉、或者进程被结束以后还在不在。
//   三、进程列表：NtQuerySystemInformation 读出来的进程号、父进程号、创建时间，和 PowerShell 读出来的逐项对。
//   四、回收站：SHFileOperationW 送进去的文件夹，回收站里找不找得到；和现在的做法各做一遍对照。
// 用来对照的那几步仍然用 PowerShell（只在探针里）。会在回收站里留下两个很小的空文件夹。
// 用法：node scripts/probe/windows-native.mjs <结果文件>        环境里设 XA_KOFFI_FROM 时从那个文件夹加载模块
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resultFile = process.argv[2] && path.resolve(process.argv[2]);
if (!resultFile) { console.error('用法：windows-native.mjs <结果文件>'); process.exit(2); }
if (process.platform !== 'win32') { console.error('这个探针只在 Windows 上跑。'); process.exit(2); }

const self = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
// XA_KOFFI_FROM：从指定的文件夹加载模块（量装好的应用时，指到应用里的 resources/platform/node_modules/koffi）。
const loadKoffi = () => process.env.XA_KOFFI_FROM ? createRequire(path.join(process.env.XA_KOFFI_FROM, 'package.json'))(process.env.XA_KOFFI_FROM) : require('koffi');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ps = (command, env = process.env) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1;

// 子进程的两种角色（探针自己起自己）。
if (process.argv[3] === 'awake-child') {
  // 申请防休眠，说一声，然后一直等着被结束。
  const koffi = loadKoffi();
  const set = koffi.load('kernel32.dll').func('uint32_t __stdcall SetThreadExecutionState(uint32_t flags)');
  set((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0);
  console.log('set');
  setInterval(() => {}, 1000);
} else if (process.argv[3] === 'tree-child') {
  // 一棵三层的进程树：自己、子、孙，各报一次进程号。
  const depth = Number(process.argv[4]);
  if (depth > 0) spawn(process.execPath, [self, resultFile, 'tree-child', String(depth - 1)], { stdio: 'inherit', windowsHide: true });
  console.log(`pid ${process.pid} ${process.ppid}`);
  setInterval(() => {}, 1000);
} else setImmediate(main);   // 等这个文件后面的常量都定义完再开始

async function main() {
  const result = { at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, release: os.release(), node: process.versions.node,
    electron: process.versions.electron ?? null, program: path.basename(process.execPath), checks: {} };
  const check = async (name, run) => {
    try { result.checks[name] = await run(); }
    catch (error) { result.checks[name] = { ok: false, error: String(error?.stack ?? error).slice(0, 900) }; }
  };
  // 是不是管理员身份（完整性级别“高”）：流水线上是，主人的电脑上平时不是。
  // 记下令牌里的完整性级别那一行和管理员组那一行（管理员组“只用于拒绝”就是没有管理员权限）。
  const groups = (spawnSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout || '').split(/\r?\n/);
  result.token = { label: groups.find(l => l.includes('S-1-16-'))?.slice(0, 160) ?? null, admins: groups.find(l => l.includes('S-1-5-32-544'))?.slice(0, 200) ?? null };
  result.elevated = /S-1-16-(12288|16384)/.test(result.token.label ?? '') && !/deny only/i.test(result.token.admins ?? '');

  let koffi = null;
  await check('load', () => {
    koffi = loadKoffi();
    return { ok: true, version: koffi.version, from: process.env.XA_KOFFI_FROM ? '装好的应用里' : path.relative(process.cwd(), require.resolve('koffi')) };
  });
  if (koffi) {
    await check('awake', () => awake(koffi));
    await check('processes', () => processes(koffi));
    await check('recycle', () => recycle(koffi));
  }
  result.ok = Object.values(result.checks).every(c => c.ok);
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(result.ok ? '通过：三件事都不用启动别的程序就做成了，结果和现在的做法一致。' : '没过：看上面的结果。');
  process.exit(result.ok ? 0 : 1);
}

// 系统的“谁在申请别休眠”名单里，SYSTEM 这一栏有没有这个程序。读名单要管理员身份。
function requests() {
  const r = spawnSync('powercfg', ['/requests'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = r.stdout || '', at = text.indexOf('SYSTEM:'), end = text.indexOf('AWAYMODE:');
  const section = at < 0 ? '' : text.slice(at, end < 0 ? undefined : end);
  return { readable: r.status === 0 && at >= 0, listed: section.toLowerCase().includes(path.basename(process.execPath).toLowerCase()), section: section.trim().slice(0, 300) };
}
async function awake(koffi) {
  const set = koffi.load('kernel32.dll').func('uint32_t __stdcall SetThreadExecutionState(uint32_t flags)');
  const out = { before: requests() };
  // 另一个进程申请，然后被直接结束：申请应当跟着没了（看管进程意外退出时就是这种情况）。
  const child = spawn(process.execPath, [self, resultFile, 'awake-child'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  await new Promise((done, fail) => { child.stdout.once('data', done); child.once('error', fail); child.once('exit', () => fail(new Error('申请防休眠的子进程自己退出了'))); setTimeout(() => fail(new Error('子进程 30 秒没有回话')), 30_000); });
  out.childHolding = requests().listed;
  child.removeAllListeners('exit'); child.kill('SIGKILL');
  await new Promise(done => child.once('close', done));
  await sleep(500);
  out.afterChildKilled = requests().listed;
  // 自己申请、自己撤掉。
  out.previous = set((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0);
  await sleep(200);
  const holding = requests();
  out.holding = holding.listed; out.holdingSection = holding.section;
  out.cleared = set(ES_CONTINUOUS);
  await sleep(200);
  out.afterClear = requests().listed;
  // 返回值是上一次的状态，0 表示调用失败。名单读不了（不是管理员）时只能看返回值。
  out.ok = out.previous !== 0 && out.cleared !== 0 && (!out.before.readable || (!out.before.listed && out.childHolding && !out.afterChildKilled && out.holding && !out.afterClear));
  return out;
}

// 一次系统调用读出全部进程：进程号、父进程号、创建时间（毫秒）。不用逐个打开进程，所以别的账户的进程也读得到。
// 只认 64 位系统上的结构（x64 和 ARM64 一样）：创建时间在第 0x20 字节，进程号在 0x50，父进程号在 0x58。
function nativeSnapshot(koffi) {
  const query = koffi.load('ntdll.dll').func('int32_t __stdcall NtQuerySystemInformation(int32_t cls, void *buffer, uint32_t length, _Out_ uint32_t *returned)');
  let size = 1 << 20, buffer, status;
  for (let i = 0; i < 6; i++) {
    buffer = Buffer.alloc(size);
    const returned = [0];
    status = query(5, buffer, size, returned);
    if (status !== -1073741820) break;   // 0xC0000004：给的地方不够大
    size = Math.max(size * 2, returned[0] + (1 << 16));
  }
  if (status !== 0) throw new Error(`NtQuerySystemInformation 返回 0x${(status >>> 0).toString(16)}`);
  const rows = [];
  for (let at = 0; ;) {
    const next = buffer.readUInt32LE(at), created = buffer.readBigInt64LE(at + 0x20);
    rows.push({ pid: Number(buffer.readBigUInt64LE(at + 0x50)), parent: Number(buffer.readBigUInt64LE(at + 0x58)), created: created > 0n ? Number(created / 10000n) - 11644473600000 : 0 });
    if (!next) break;
    at += next;
  }
  return rows;
}
// 现在的做法（src/core/platform.ts 的 SNAPSHOT）。
const SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" } }';
function powershellSnapshot() {
  const r = ps(SNAPSHOT);
  if (r.status !== 0) throw new Error(`PowerShell 读进程列表失败：${(r.stderr || '').trim().slice(0, 300)}`);
  return r.stdout.split(/\r?\n/).map(l => /^(\d+) (\d+) (\d+)$/.exec(l.trim())).filter(Boolean).map(m => ({ pid: Number(m[1]), parent: Number(m[2]), created: Number(m[3]) }));
}
async function processes(koffi) {
  const since = Date.now();
  const tree = spawn(process.execPath, [self, resultFile, 'tree-child', '2'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const pids = [];
  try {
    await new Promise((done, fail) => {
      let text = '';
      tree.stdout.on('data', d => { text += d; for (const m of text.matchAll(/pid (\d+) (\d+)\r?\n/g)) if (!pids.some(p => p.pid === Number(m[1]))) pids.push({ pid: Number(m[1]), parent: Number(m[2]) }); if (pids.length === 3) done(); });
      tree.once('error', fail); setTimeout(() => fail(new Error(`进程树 30 秒没起齐，只看到 ${pids.length} 个`)), 30_000);
    });
    let t = performance.now();
    const native = nativeSnapshot(koffi);
    const nativeMs = Math.round(performance.now() - t);
    t = performance.now();
    const old = powershellSnapshot();
    const powershellMs = Math.round(performance.now() - t);
    const again = nativeSnapshot(koffi);   // 两头各读一次：中间这一秒里出生或退出的进程不算差别
    const byPid = new Map(native.map(r => [r.pid, r])), stable = new Set(again.filter(r => byPid.get(r.pid)?.created === r.created).map(r => r.pid));
    const differ = [];
    let compared = 0;
    for (const row of old) {
      const mine = byPid.get(row.pid);
      if (!mine || !stable.has(row.pid)) continue;
      compared++;
      if (mine.parent !== row.parent || Math.abs(mine.created - row.created) > 1) differ.push({ powershell: row, native: mine });
    }
    // 我们自己起的三个进程：都读得到，父子关系对，创建时间落在起它们的那一刻附近（和平台认进程用的窗口一样：前 2 秒到后 5 秒）。
    const ours = pids.map(p => ({ ...p, native: byPid.get(p.pid) ?? null, powershell: old.find(r => r.pid === p.pid) ?? null }));
    const oursOk = ours.every(p => p.native && p.native.parent === p.parent && p.native.created >= since - 2000 && p.native.created <= Date.now() + 5000 && p.powershell && Math.abs(p.native.created - p.powershell.created) <= 1);
    return { ok: oursOk && differ.length === 0 && compared > 20, nativeCount: native.length, powershellCount: old.length, compared, differ: differ.slice(0, 5), differCount: differ.length,
      withoutTime: native.filter(r => !r.created).map(r => r.pid), onlyPowershell: old.filter(r => !byPid.has(r.pid)).length, nativeMs, powershellMs, ours };
  } finally {
    // 收掉那棵树（探针里用系统自带的命令，不是要量的东西）。
    spawnSync('taskkill', ['/T', '/F', '/PID', String(tree.pid)], { windowsHide: true });
  }
}

// 回收站里现在有哪些名字（探针里对照用）。
const recycled = () => (ps('(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Name }').stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
// 更直接的证据：这个盘的回收站目录里，属于当前账户的条目有几个（每送进去一样东西，系统记一个 $I 开头的文件）。
function binEntries(drive) {
  const sid = /S-1-5-21-[\d-]+/.exec(spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout || '')?.[0];
  if (!sid) return null;
  try { return fs.readdirSync(path.join(drive, '$Recycle.Bin', sid)).filter(n => n.startsWith('$I')).length; }
  catch (error) { return error.code === 'ENOENT' ? 0 : null; }
}
function folder(name) {
  const dir = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '说明.txt'), '探针留下的，可以删。');
  return dir;
}
async function recycle(koffi) {
  const FO_DELETE = 3, FLAGS = 0x4 | 0x10 | 0x40 | 0x400;   // 不出进度窗、不问、能撤销（进回收站）、出错不弹窗
  const struct = koffi.struct('SHFILEOPSTRUCTW', { hwnd: 'void *', wFunc: 'uint32_t', pFrom: 'str16', pTo: 'str16', fFlags: 'uint16_t', fAnyOperationsAborted: 'int32_t', hNameMappings: 'void *', lpszProgressTitle: 'str16' });
  const remove = koffi.load('shell32.dll').func('int __stdcall SHFileOperationW(SHFILEOPSTRUCTW *op)');
  const out = { structSize: koffi.sizeof(struct) };
  // 新做法。路径后面要跟两个空字符：自己加一个，另一个是字符串本来的结尾。名字里带中文和空格（主人看到的文件夹名就是这样的）。
  const mine = folder('派活工作台-探针 新做法'), drive = path.parse(mine).root;
  out.entriesBefore = binEntries(drive);
  out.returned = remove({ hwnd: null, wFunc: FO_DELETE, pFrom: mine + '\0', pTo: null, fFlags: FLAGS, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null });
  out.gone = !fs.existsSync(mine);
  out.entriesAfter = binEntries(drive);
  // 现在的做法（src/core/trash.ts 的 RECYCLE），对照。
  const theirs = folder('派活工作台-探针 现在的做法');
  const old = ps("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:XA_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')", { ...process.env, XA_RECYCLE_PATH: theirs });
  out.oldExit = old.status; out.oldGone = !fs.existsSync(theirs);
  out.entriesAfterOld = binEntries(drive);
  const names = recycled();
  out.inBin = names.includes(path.basename(mine)); out.oldInBin = names.includes(path.basename(theirs));
  // 不存在的路径：应当报错（返回值不是 0），不弹窗、不卡住。
  out.missingReturned = remove({ hwnd: null, wFunc: FO_DELETE, pFrom: path.join(os.tmpdir(), `xa-no-such-${Date.now()}`) + '\0', pTo: null, fFlags: FLAGS, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null });
  // 进没进回收站只和现在的做法比：机器上没有回收站可用时两边都进不去，那是环境的事。
  out.ok = out.returned === 0 && out.gone && out.missingReturned !== 0 && out.inBin === out.oldInBin
    && (out.entriesBefore === null || out.entriesAfter - out.entriesBefore === out.entriesAfterOld - out.entriesAfter);
  return out;
}
