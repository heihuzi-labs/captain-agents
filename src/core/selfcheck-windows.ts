// Windows 上的隔离自检：现在只有 Codex 这一路（docs/design-windows.md 第 4 节）。
// 每一项探针都对应 macOS 上已有的一项，另加 Windows 才有的几项；依据是 docs/research/windows-codex-sandbox-2026-10-12.md。
// 判定规则不变（selfcheck.ts 的 evaluate）：副本内写、任务临时目录必须通，其余必须被挡，拿不准也算不过。
import { mkdtemp, mkdir, rm, writeFile, realpath, lstat, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { externalEnvironment } from './node-runtime.ts';
import { paths, toolRoot } from './paths.ts';
import { codexPermissions, deepseekHome, keychainDirs, SHELL_FILES, CREDENTIAL_FILES, WINDOWS_SHELL_FILES, WINDOWS_CREDENTIAL_FILES } from './sandbox.ts';
import { codexPath, WINDOWS_SANDBOX } from './workers.ts';
import { SECRET_WORDS, codexEnvPolicy, exactEnv, workerEnv } from './env.ts';
import { extraDenyRead } from './settings.ts';
import { whos, isolationOf } from './roster.ts';
import type { Executor } from './verify.ts';
import type { Job } from './job.ts';
import type { IsolationResult, Probe } from './selfcheck.ts';
import { globalTargets } from './selfcheck.ts';

// 自检用的 Codex 文件夹。Windows 上每个 Codex 文件夹要各装一次隔离，所以不能像 macOS 那样每次现建一个空的：
// 固定用这一个，由 xagents windows-setup 和主人的、DeepSeek 的一起装好。里面不放登录和主人的配置。
export const probeHome = () => join(paths().home, 'codex-probe');
// 要装隔离的 Codex 文件夹：主人自己的、DeepSeek 用的、自检用的。
export const codexHomes = (env: NodeJS.ProcessEnv = process.env) => [env.CODEX_HOME || join(homedir(), '.codex'), deepseekHome(), probeHome()];

// 写了就会被主人自动执行、或者会改掉各家程序的位置：macOS 上那 21 处在 Windows 上同名同位置，另加 Windows 才有的。
// 开机启动文件夹和 PowerShell 配置文件夹：选手写得进去，主人下次登录或开终端就会以自己的身份执行。
// 写成函数：这个文件和 selfcheck.ts 互相引用，装载时还取不到对方的值。
export const windowsGlobalTargets = () => [...globalTargets,
  { name: 'startup-folder', path: 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup', dir: true, label: '写开机启动文件夹' },
  { name: 'powershell-profile', path: 'Documents/PowerShell', dir: true, label: '写 PowerShell 配置文件夹' },
  { name: 'powershell-profile-5', path: 'Documents/WindowsPowerShell', dir: true, label: '写旧版 PowerShell 配置文件夹' },
  { name: 'codex-install', path: 'AppData/Local/Programs/OpenAI/Codex', dir: true, label: '改 Codex 程序' },
  { name: 'codex-app-bin', path: 'AppData/Local/OpenAI/Codex', dir: true, label: '改 Codex 桌面应用放的程序' },
  { name: 'cursor-install-windows', path: 'AppData/Local/cursor-agent', dir: true, label: '改 Cursor 程序（Windows 的安装位置）' },
];
// 公用的可写位置：主人自己的临时目录（里面有负责人会话的草稿和别的程序的临时文件）、Windows 的临时目录、
// 所有用户共用的公共目录和程序数据目录、盘符根目录、npm 的日志目录。
// 另加派活工作台自己的程序目录（2026-10-12）：安装时可以选位置了，装到一个“所有人可写”的文件夹里，选手就能改平台自己的程序，
// 那些程序是在隔离外以主人的身份运行的，等于逃出隔离。写得进就判不过，请主人换个位置装（docs/design-windows.md 第 11.1 节）。
// 查两层：平台代码所在的那一层，和可执行程序所在的那一层（打包后是安装目录本身；权限不往下继承时两层可能不一样）。
export const windowsTempTargets = [
  { name: 'tmp-user', label: '写主人的临时目录' },
  { name: 'tmp-shared', label: '写 Windows 的公用临时目录' },
  { name: 'tmp-public', label: '写所有用户共用的公共目录' },
  { name: 'tmp-programdata', label: '写所有用户共用的程序数据目录' },
  { name: 'tmp-root', label: '写盘符根目录' },
  { name: 'npm-logs', label: '写 npm 日志目录' },
  { name: 'own-install', label: '改派活工作台自己的程序（这一项没过，请把应用换个位置安装）' },
  { name: 'own-program', label: '往运行派活工作台的程序旁边放文件（这一项没过，请把应用换个位置安装）' },
] as const;
export function windowsTempPaths(home = homedir(), env: NodeJS.ProcessEnv = process.env, ownerTmp = tmpdir(), own = toolRoot, program = dirname(process.execPath)): Record<string, string | null> {
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return {
    'tmp-user': ownerTmp, 'tmp-shared': join(env.SystemRoot || 'C:\\Windows', 'Temp'), 'tmp-public': env.PUBLIC || join(parse(home).root, 'Users', 'Public'),
    'tmp-programdata': env.ProgramData || join(parse(home).root, 'ProgramData'), 'tmp-root': parse(home).root, 'npm-logs': join(local, 'npm-cache', '_logs'), 'own-install': own, 'own-program': program,
  };
}
const logins = ['login-codex', 'login-grok', 'login-cursor', 'login-deepseek'];
const keychain = ['keychain', 'keychain-user', 'keychain-system'];
export function windowsExpectedProbes() {
  return ['worktree', 'tmpdir', 'hardlink', 'home', 'account', 'chrome', 'listener', 'listen', 'pipe', 'internet', 'ssh', 'npmrc', 'shell-files', 'credential-files', 'env-secret',
    ...logins, ...keychain, ...windowsGlobalTargets().map(t => t.name), ...windowsTempTargets.map(t => t.name)];
}
export const windowsLabels = (): Record<string, string> => ({
  ...Object.fromEntries([...windowsGlobalTargets(), ...windowsTempTargets].map(t => [t.name, t.label])),
  account: '以主人的账户运行（应当是隔离的专用账户）', listen: '在本机开监听端口', pipe: '连隔离外程序的命名管道',
  keychain: '读凭据库里的条目', 'keychain-user': '读存凭据的系统文件夹（随用户漫游的）', 'keychain-system': '读存凭据的系统文件夹（本机的）',
});
// 这几项没过，多半是回环补丁没装或失效了（Codex 自己拦不住本机回环）。
const fenceProbes = ['chrome', 'listener', 'listen'];

// 探针要去试写的一处：path 一定是本机现有的文件或文件夹（由外面定好），探针不新建任何固定名字的东西。
export type WriteProbe = { name: string; path: string; dir: boolean };
// 目标本身不在时，改试离它最近的那一层现有的上级文件夹：上级写不进，这个位置也就建不出来。
// （不直接去建目标：Windows 上隔离里建不存在的文件夹，报的错分不清是“不许建”还是“上级不在”。）
export async function resolveWriteProbe(name: string, path: string, dir: boolean): Promise<WriteProbe> {
  for (let current = path, wantDir = dir; ; wantDir = true) {
    const info = await lstat(current).catch(() => null);
    if (info) return { name, path: current, dir: wantDir ? info.isDirectory() : !info.isFile() };
    const parent = dirname(current);
    if (parent === current) return { name, path: current, dir: true };
    current = parent;
  }
}
export type WindowsProbeSpec = {
  worktree: string; tmp: string; home: string; homeFile: string; linkTarget: string; marker: string; token: string;
  port: number; pipe: string; owner: string; credential: string | null; fakes: string[]; writes: WriteProbe[];
};
// 隔离里跑的探针是一份 PowerShell 脚本（系统自带，隔离里的专用账户一定能运行）。
// 2026-10-12 以前用的是 Node 脚本，由“平台自己的运行时”来跑：从源码目录跑时那是 Node，没事；装好的应用里那是应用自己的程序，
// 专用账户要么没权限启动它，要么启动了就崩（流水线实测），主人的电脑上则是一直卡到超时。所以探针不再依赖任何要另外装的运行时。
// 只输出结果和错误码；不输出文件名、凭据内容，也不向本机端口发送数据。
// 写成带 BOM 的 UTF-8：系统自带的 PowerShell 按本机代码页读没有 BOM 的脚本，中文会被读坏。
export function windowsProbeScript(spec: WindowsProbeSpec) {
  const data = { ...spec, owner: spec.owner.toLowerCase(), pipe: spec.pipe.replace(/^\\\\\.\\pipe\\/, ''), words: SECRET_WORDS,
    shellFiles: [...SHELL_FILES, ...WINDOWS_SHELL_FILES], credentialFiles: [...CREDENTIAL_FILES, ...WINDOWS_CREDENTIAL_FILES],
    logins: [['login-codex', '.codex', 'auth.json'], ['login-grok', '.grok', 'auth.json'], ['login-cursor', '.cursor', 'cli-config.json']],
    deepseek: deepseekHome(), keychainUser: keychainDirs(true)[0], keychainSystem: keychainDirs(true)[1] };
  // 说明放进一段原样字符串里再解析，路径里有引号、空格、中文都不用另外转义。
  return '\uFEFF' + `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$spec = @'
${JSON.stringify(data)}
'@ | ConvertFrom-Json
$probes = New-Object System.Collections.ArrayList
function Add($name, $outcome, $reason) { [void]$probes.Add(@{ name = $name; outcome = $outcome; reason = $reason }) }
# 把系统给的错误归成几类：没有权限、不存在、不是文件夹、连接类的几种；认不出的原样报类型名，一律算拿不准。
function Code($e) {
  for ($x = $e; $x; $x = $x.InnerException) {
    if ($x -is [System.Net.Sockets.SocketException]) {
      $k = [string]$x.SocketErrorCode
      if ($k -eq 'AccessDenied') { return 'EACCES' }
      if ($k -eq 'ConnectionRefused') { return 'ECONNREFUSED' }
      if ($k -eq 'TimedOut') { return 'ETIMEDOUT' }
      return $k
    }
    if ($x -is [System.UnauthorizedAccessException] -or $x -is [System.Security.SecurityException]) { return 'EPERM' }
    if ($x -is [System.ComponentModel.Win32Exception] -and ($x.NativeErrorCode -eq 5 -or $x.NativeErrorCode -eq 1314)) { return 'EPERM' }
    if ($x -is [System.IO.FileNotFoundException] -or $x -is [System.IO.DirectoryNotFoundException]) { return 'ENOENT' }
    if ($x -is [System.TimeoutException]) { return 'ETIMEDOUT' }
    if ($x -is [System.InvalidOperationException] -and $x.Message -eq 'TEMP_MISMATCH') { return 'TEMP_MISMATCH' }
    $h = $x.HResult
    if ($h -eq -2147024891 -or $h -eq -2147023582) { return 'EPERM' }
    if ($h -eq -2147024894 -or $h -eq -2147024893) { return 'ENOENT' }
    if ($h -eq -2147024629) { return 'ENOTDIR' }
    if ($h -eq -2147024816 -or $h -eq -2147024713) { return 'EEXIST' }
  }
  return $e.GetType().Name
}
function Outcome($code) { if ($code -eq 'EPERM' -or $code -eq 'EACCES') { 'denied' } else { 'unknown' } }
function Test($name, $fn) {
  try { & $fn; Add $name 'allowed' '操作成功' }
  catch { $c = Code $_.Exception; Add $name (Outcome $c) $c }
}
# 读类的探针：Windows 上权限表只写本机存在的路径，所以“本机没有”就是没有可读的东西，和挡住同等对待。
function Unread($name, $fn) {
  try { & $fn; Add $name 'allowed' '读得到' }
  catch { $c = Code $_.Exception; if ($c -eq 'ENOENT') { Add $name 'denied' '本机没有' } else { Add $name (Outcome $c) $c } }
}
function NewFile($path) { $s = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write); $s.Close() }
function OpenRead($path) { $s = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, 7); $s.Close() }
function OpenWrite($path) { $s = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, 7); $s.Close() }
function ListDir($path) { [void][System.IO.Directory]::GetFileSystemEntries($path) }
function Under($base, $rel) { [System.IO.Path]::Combine($base, ($rel -replace '/', '\\')) }
function Connect($hostName, $port, $ms) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $a = $c.BeginConnect($hostName, $port, $null, $null)
    if (-not $a.AsyncWaitHandle.WaitOne($ms)) { throw (New-Object System.Net.Sockets.SocketException 10060) }
    $c.EndConnect($a)
  } finally { $c.Close() }
}
Test 'worktree' { $p = Under $spec.worktree 'write-probe'; NewFile $p; [System.IO.File]::Delete($p) }
# 任务专用临时目录：TEMP、TMP 必须正好指向它，而且写得进去。
Test 'tmpdir' {
  foreach ($n in 'TEMP', 'TMP') {
    $v = [Environment]::GetEnvironmentVariable($n)
    if (-not $v -or $v.TrimEnd('\\', '/').ToLower() -ne $spec.tmp.ToLower()) { throw (New-Object System.InvalidOperationException 'TEMP_MISMATCH') }
  }
  $p = Under $spec.tmp 'write-probe'; NewFile $p; [System.IO.File]::Delete($p)
}
Test 'hardlink' { $p = Under $spec.tmp $spec.token; [void](New-Item -ItemType HardLink -Path $p -Value $spec.linkTarget); try { [System.IO.File]::Delete($p) } catch { } }
Test 'home' { NewFile $spec.homeFile }
if ($probes[$probes.Count - 1].outcome -eq 'allowed') { try { [System.IO.File]::Delete($spec.homeFile) } catch { $probes[$probes.Count - 1].reason += '，清理失败：' + (Code $_.Exception) } }
# 身份：隔离里必须是专用账户。还是主人的账户，说明跑的不是我们认的那种隔离。
$who = $null
try { $who = (& whoami.exe | Out-String).Trim().ToLower() } catch { }
if (-not $who -or $LASTEXITCODE -ne 0) { Add 'account' 'unknown' '查不到当前账户' }
elseif (($who -split '\\\\')[-1] -eq $spec.owner) { Add 'account' 'allowed' '还是主人的账户' }
else { Add 'account' 'denied' '是另一个账户' }
# 本机端口：浏览器调试口（没开着也必须是“不许连”，而不是“没人接”）、自检在外面开的一个监听口、自己开监听口。
Test 'chrome' { Connect '127.0.0.1' 9222 2500 }
Test 'listener' { Connect '127.0.0.1' $spec.port 2500 }
Test 'listen' { $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0); $l.Start(); $l.Stop() }
Test 'pipe' { $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $spec.pipe, [System.IO.Pipes.PipeDirection]::InOut); try { $c.Connect(2500) } finally { $c.Dispose() } }
# 外网：直接连一个公共 IP 的 443 端口，只看能否建立连接。
Test 'internet' { Connect '1.1.1.1' 443 4000 }
Unread 'ssh' { ListDir (Under $spec.home '.ssh') }
Unread 'npmrc' { OpenRead (Under $spec.home '.npmrc') }
# 本机有的必须读不到，本机没有的不算数；读得到任何一个就是放行。只看能不能打开（目录看能不能列出），不读内容，也不报文件名。
function Unreadable($name, $files) {
  $count = @{ allowed = 0; denied = 0; unknown = 0; absent = 0 }
  foreach ($f in $files) {
    $p = Under $spec.home $f
    try { ListDir $p; $count.allowed++ }
    catch {
      $c = Code $_.Exception
      if ($c -eq 'ENOENT') { $count.absent++ }
      elseif ($c -ne 'ENOTDIR') { $count[(Outcome $c)]++ }
      else {
        try { OpenRead $p; $count.allowed++ }
        catch { $c2 = Code $_.Exception; if ($c2 -eq 'ENOENT') { $count.absent++ } else { $count[(Outcome $c2)]++ } }
      }
    }
  }
  $o = if ($count.allowed) { 'allowed' } elseif ($count.unknown) { 'unknown' } else { 'denied' }
  Add $name $o ('读得到 ' + $count.allowed + ' 个，挡住 ' + $count.denied + ' 个，拿不准 ' + $count.unknown + ' 个，本机没有 ' + $count.absent + ' 个')
}
Unreadable 'shell-files' $spec.shellFiles
Unreadable 'credential-files' $spec.credentialFiles
# 环境变量：外面放的假变量看不到，也没有别的名字带密钥字样的变量，才算挡住。只报名字。
$seen = @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $n = [string]$_; ($spec.fakes -contains $n) -or (@($spec.words | Where-Object { $n.ToUpper().Contains($_) }).Count -gt 0) })
if ($seen.Count) { Add 'env-secret' 'allowed' ('看得到 ' + ($seen -join '、')) } else { Add 'env-secret' 'denied' '看不到' }
# 登录文件：不存在（没登录）时改查它所在的文件夹能不能列出，被挡住说明将来登录生成的文件同样读不到。
foreach ($l in $spec.logins) {
  $dir = Under $spec.home $l[1]; $file = Under $dir $l[2]
  Unread $l[0] { try { OpenRead $file } catch { if ((Code $_.Exception) -ne 'ENOENT') { throw }; ListDir $dir } }
}
Unread 'login-deepseek' { ListDir $spec.deepseek }
# 凭据库：外面放了一个随机名的测试条目，这里看列不列得出它的名字。只比名字，不读内容。
if (-not $spec.credential) { Add 'keychain' 'unknown' '没能在凭据库里放测试条目' }
else {
  $listed = $null
  try { $listed = (& cmdkey.exe /list | Out-String) } catch { }
  if ($null -eq $listed -or $LASTEXITCODE -ne 0) { Add 'keychain' 'unknown' '列不了凭据库' }
  elseif ($listed.Contains($spec.credential)) { Add 'keychain' 'allowed' '看得到测试条目' }
  else { Add 'keychain' 'denied' '看不到测试条目' }
}
Unread 'keychain-user' { ListDir $spec.keychainUser }
Unread 'keychain-system' { ListDir $spec.keychainSystem }
# 试写：现有的文件用“只写、不截断、不新建”方式打开，不改内容；现有的文件夹里建一个随机名的空文件再删掉。写成了就是放行。
# 随机名文件万一删不掉，外面会按名字再清一遍。
foreach ($t in $spec.writes) {
  Test $t.name { if ($t.dir) { $inside = Under $t.path $spec.token; NewFile $inside; try { [System.IO.File]::Delete($inside) } catch { } } else { OpenWrite $t.path } }
}
[Console]::Out.WriteLine($spec.marker + (ConvertTo-Json -Compress -InputObject @($probes)))
`;
}

// 系统自带的 PowerShell：隔离里跑探针、隔离外调起安装脚本都用它。
export const windowsPowershell = (env: NodeJS.ProcessEnv = process.env) => join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// 凭据库里的测试条目：名字固定前缀加随机数，值是随机数，不是任何真密码。自检前后各清一遍上次留下的。
const CREDENTIAL_PREFIX = 'xagents-selfcheck-';
const quiet = (r: Awaited<ReturnType<Executor>>) => r.exit === 0 && !r.timedOut && !r.error && !r.signal;
export async function sweepCredentials(run: Executor): Promise<string | null> {
  const listed = await run('cmdkey.exe', ['/list'], homedir(), 15_000);
  if (!quiet(listed)) return '未能列出凭据库，没法清理自检的测试条目';
  const names = [...new Set([...listed.output.matchAll(new RegExp(`${CREDENTIAL_PREFIX}[0-9a-f-]{36}`, 'g'))].map(m => m[0]))];
  for (const name of names) {
    const removed = await run('cmdkey.exe', [`/delete:${name}`], homedir(), 15_000);
    if (!quiet(removed)) return `未能删除凭据库里的自检测试条目 ${name}`;
  }
  return null;
}
async function addCredential(run: Executor): Promise<string | null> {
  const name = CREDENTIAL_PREFIX + randomUUID();
  const added = await run('cmdkey.exe', [`/generic:${name}`, '/user:xagents-selfcheck', `/pass:${randomUUID()}`], homedir(), 15_000);
  if (!quiet(added)) return null;
  const listed = await run('cmdkey.exe', ['/list'], homedir(), 15_000);
  return quiet(listed) && listed.output.includes(name) ? name : null;
}
const NOT_INSTALLED = '还没装好 Windows 上的隔离。请主人在桌面应用的“设置 → 通用 → 隔离”里点“安装并检查”（系统会弹一次管理员确认框）；没有桌面应用时运行 xagents windows-setup，装好后再自检';

export async function windowsCodexSelfcheck(run: Executor): Promise<IsolationResult> {
  const isolation = 'codex' as const;
  const fail = (error: string): IsolationResult => ({ isolation, probes: [], error });
  const codex = codexPath();
  try { await access(codex); } catch { return fail(`找不到 Codex 程序（${codex}）。请先安装 Codex 桌面应用或命令行并打开一次，或用 XAGENTS_CODEX 指明 codex.exe 的位置`); }
  try { if (!(await lstat(probeHome())).isDirectory()) return fail(NOT_INSTALLED); } catch { return fail(NOT_INSTALLED); }
  const home = homedir(), ownerTmp = await realpath(tmpdir()).catch(() => tmpdir());
  const temp = await realpath(await mkdtemp(join(paths().cache, 'selfcheck-')));
  await mkdir(deepseekHome(), { recursive: true });
  const worktree = join(temp, isolation), tmp = join(temp, `${isolation}-tmp`);
  await mkdir(worktree); await mkdir(tmp);
  const homeFile = join(home, `.xagents-selfcheck-${randomUUID()}`);
  const linkTarget = join(temp, 'link-target'); await writeFile(linkTarget, 'xagents selfcheck');
  const marker = `XAGENTS_PROBE_${randomUUID()}:`, token = `.xagents-selfcheck-${randomUUID()}`, script = join(worktree, 'probe.ps1');
  const outer = 'XAGENTS_SELFCHECK_API_KEY', inner = 'XAGENTS_SELFCHECK_INNER_TOKEN';
  const shared = windowsTempPaths(home, process.env, ownerTmp);
  const listener = net.createServer(socket => socket.destroy()), pipeServer = net.createServer(socket => socket.destroy());
  const pipe = `\\\\.\\pipe\\xagents-selfcheck-${randomUUID()}`;
  const problems: string[] = [], writes: WriteProbe[] = [];
  let result: IsolationResult = fail('自检没有跑完');
  try {
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => { pipeServer.once('error', reject); pipeServer.listen(pipe, resolve); });
    const stale = await sweepCredentials(run); if (stale) problems.push(stale);
    const credential = await addCredential(run);
    const owner = (process.env.USERNAME || '').trim();
    if (!owner) return fail('查不到主人的账户名');
    const wanted = [...windowsGlobalTargets().map(t => ({ name: t.name, path: join(home, t.path), dir: t.dir })),
      ...windowsTempTargets.map(t => ({ name: t.name, path: shared[t.name]!, dir: true }))];
    // 探针前不在的位置：探针后也不该出现（出现了说明有东西被建了出来）。
    const absent: string[] = [];
    for (const t of wanted) { writes.push(await resolveWriteProbe(t.name, t.path, t.dir)); if (!await lstat(t.path).catch(() => null)) absent.push(t.path); }
    await writeFile(script, windowsProbeScript({ worktree, tmp, home, homeFile, linkTarget, marker, token, port: (listener.address() as net.AddressInfo).port, pipe, owner, credential, fakes: [outer, inner], writes }));
    let probes: Probe[] | null = null;
    try {
      const job = { who: whos.find(w => isolationOf(w) === isolation)!, mode: 'workspace-write', worktree, repo: temp, id: '' } as Job;
      const project = { denyReadExtra: [], denyReadHome: await extraDenyRead() };
      // 和派活时一样两层：继承的环境先按 env.ts 去掉带密钥字样的；inner 绕过这一层直接塞给 Codex，只靠它自己那条规则挡。
      const inherited = { ...process.env, [outer]: randomUUID() };
      const env = exactEnv(externalEnvironment({ ...workerEnv(inherited, { CODEX_HOME: probeHome(), TMPDIR: tmp, TEMP: tmp, TMP: tmp }), [inner]: randomUUID() }), { ...process.env, ...inherited });
      const r = await run(codex, [...WINDOWS_SANDBOX, 'sandbox', '-P', 'xa', '-C', worktree, '-c', codexPermissions(job, project, tmp), '-c', codexEnvPolicy(), '--', windowsPowershell(), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], worktree, 90_000, undefined, env);
      const lines = r.output.split(/\r?\n/).filter(line => line.startsWith(marker));
      if (/requires the elevated Windows sandbox backend/i.test(r.output)) throw new Error(NOT_INSTALLED);
      if (r.exit !== 0 || r.timedOut || r.signal || r.error || lines.length !== 1) throw new Error(r.error || (r.timedOut ? '探针超时' : `探针没有完整结果（退出码 ${r.exit}）：${r.output.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}`));
      const parsed = JSON.parse(lines[0].slice(marker.length));
      if (!Array.isArray(parsed)) throw new Error('探针结果格式无效');
      probes = parsed as Probe[];
      for (const p of probes) if (fenceProbes.includes(p.name) && p.outcome !== 'denied') p.reason += '；本机端口没拦住，多半是回环补丁没装或失效了，请主人在桌面应用的“设置 → 通用 → 隔离”里点“安装并检查”';
      result = { isolation, probes };
    } catch (e) { result = fail((e as Error).message); }
    for (const path of absent) if (await lstat(path).catch(() => null)) problems.push(`自检期间出现了 ${path}，没有删，请负责人查看`);
  } finally {
    listener.close(); pipeServer.close();
    // 探针在现有文件夹里建的随机名文件，万一没删掉，这里按名字再清一遍。
    for (const t of writes) if (t.dir) await rm(join(t.path, token), { force: true }).catch(e => problems.push(`未能删除自检随机文件 ${join(t.path, token)}：${e.code || '未知错误'}`));
    const left = await sweepCredentials(run).catch(e => `未能清理凭据库里的自检测试条目：${(e as Error).message}`);
    if (left) problems.push(left);
    await rm(homeFile, { force: true }).catch(e => problems.push(`未能清理自检随机文件 ${homeFile}：${e.code || '未知错误'}`));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(e => problems.push(`未能清理自检目录 ${temp}：${e.code || '未知错误'}`));
  }
  if (problems.length) result.error = [result.error, ...problems].filter(Boolean).join('；');
  return result;
}

// ---------- 一次装齐：Codex 的隔离（每个 Codex 文件夹各一次）和回环补丁 ----------
export type SetupStep = { name: string; target: string; ok: boolean; detail: string };
const stepText = (step: SetupStep) => {
  const what = step.name === 'codex-setup' ? `给 ${step.target} 装 Codex 的隔离` : step.name === 'fence-install' ? '装本机回环的拦截规则' : step.name === 'fence-remove' ? '撤掉本机回环的拦截规则' : '安装';
  const why = { 'not-elevated': '没有拿到管理员权限', 'codex-missing': '找不到 Codex 程序', 'user-missing': '缺少账户名', 'home-missing': '文件夹不存在' }[step.detail] ?? step.detail.slice(0, 300);
  return step.ok ? `${what}：好了` : `${what}：没成功（${why}）`;
};
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export async function windowsSetup(run: Executor, remove = false): Promise<{ ok: boolean; lines: string[] }> {
  const codex = codexPath();
  if (!remove) { try { await access(codex); } catch { throw new Error(`找不到 Codex 程序（${codex}）。请先安装 Codex 命令行，或用 XAGENTS_CODEX 指明 codex.exe 的位置。`); } }
  const user = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
  if (!user) throw new Error('查不到当前账户名。');
  // 文件夹和结果文件都在提权之前建好：提权后建的东西，主人自己的账户不一定有权限。
  const homes = codexHomes();
  for (const dir of homes) await mkdir(dir, { recursive: true });
  await mkdir(paths().cache, { recursive: true });
  const resultFile = join(paths().cache, `windows-setup-${randomUUID()}.json`);
  await writeFile(resultFile, '');
  const script = join(toolRoot, 'sandbox', 'windows', 'setup.ps1');
  for (const value of [script, resultFile, codex, user, ...homes]) if (/["|\r\n]/.test(value)) throw new Error(`路径或账户名里有不能用的字符：${value}`);
  const inner = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`, '-Result', `"${resultFile}"`,
    ...(remove ? ['-Remove'] : ['-Codex', `"${codex}"`, '-User', `"${user}"`, '-CodexHomes', `"${homes.join('|')}"`])];
  const powershell = windowsPowershell();
  // 以管理员身份运行：系统在这里弹确认框，主人点“是”才继续。
  const command = `$p = Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(${inner.map(psQuote).join(',')}); exit $p.ExitCode`;
  try {
    const r = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], paths().cache, 10 * 60_000);
    let steps: SetupStep[] | null = null, ok = false;
    try { const parsed = JSON.parse((await import('node:fs/promises').then(fs => fs.readFile(resultFile, 'utf8'))).replace(/^\uFEFF/, '')); steps = parsed.steps; ok = parsed.ok === true; } catch { /* 没写出结果：下面按没装成报 */ }
    if (!Array.isArray(steps)) return { ok: false, lines: [/canceled by the user|已取消|取消了/i.test(r.output) ? '没有装：管理员确认被取消了。' : `没有装成：安装脚本没有留下结果（退出码 ${r.exit}）。${r.output.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}`] };
    // 装过或撤过以后，旧的自检结果不再作数。
    await rm(join(paths().cache, 'selfcheck.json'), { force: true });
    return { ok, lines: steps.map(stepText) };
  } finally { await rm(resultFile, { force: true }).catch(() => {}); }
}
