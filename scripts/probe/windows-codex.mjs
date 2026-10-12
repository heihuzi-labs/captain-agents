// Windows 上 Codex 自带隔离的探针（docs/design-windows.md 第 4 节的依据）。只在 Windows 上跑，不需要登录 Codex。
// 用法：node scripts/probe/windows-codex.mjs <codex.exe> <结果.json>
// 外层（本文件不带参数 --inner 时）在隔离外准备目录、测试文件、监听口和命名管道，再用
// `codex sandbox` 在各种设置下跑内层（同一个文件带 --inner），把内层报回的结果汇总成一份 JSON。
// 内层只报“成没成”和错误码，不输出文件内容、变量值。测试条目和目录都是随机名，结束后清掉。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = 'XAGENTS_WINDOWS_PROBE:';
const SECRET_WORDS = ['KEY', 'TOKEN', 'SECRET', 'PASS', 'CREDENTIAL', 'AUTH', 'COOKIE', 'PRIVATE'];

function run(file, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try { child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ exit: null, error: String(e.message), stdout: '', stderr: '', ms: 0 }); return; }
    let stdout = '', stderr = '', timedOut = false, error;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-200_000); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-200_000); });
    child.once('error', e => { error = e.message; });
    child.once('close', exit => {
      clearTimeout(timer);
      resolve({ exit, stdout, stderr, ms: Date.now() - started, ...(timedOut ? { timedOut } : {}), ...(error ? { error } : {}) });
    });
  });
}

// ---------- 内层：在隔离里跑 ----------
async function inner(spec) {
  const out = {};
  const code = e => e?.code || e?.message || 'error';
  const attempt = async (name, fn) => {
    try { out[name] = { ok: true, ...(await fn()) }; }
    catch (e) { out[name] = { ok: false, code: code(e) }; }
  };
  const writeNew = async dir => {
    const file = path.join(dir, `probe-${randomUUID()}.txt`);
    await fs.writeFile(file, 'probe', { flag: 'wx' });
    await fs.rm(file, { force: true }).catch(() => {});
    return {};
  };
  const connect = (options, ms = 4000) => new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, ms);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({}); });
    socket.once('error', e => { clearTimeout(timer); reject(e); });
  });

  // 隔离里的专用账户查不了 os.userInfo()（实测报 ENOMEM），所以每一项单独取、取不到就记下错误码。
  const safe = fn => { try { return fn(); } catch (e) { return `!${code(e)}`; } };
  out.identity = { user: safe(() => os.userInfo().username), envUser: process.env.USERNAME ?? null, home: safe(() => os.homedir()), envProfile: process.env.USERPROFILE ?? null,
    cwd: safe(() => process.cwd()), temp: process.env.TEMP ?? null, tmp: process.env.TMP ?? null, tmpdir: safe(() => os.tmpdir()), codexHome: process.env.CODEX_HOME ?? null };
  out.envSecretNames = Object.keys(process.env).filter(name => SECRET_WORDS.some(w => name.toUpperCase().includes(w))).sort();
  out.envNames = Object.keys(process.env).sort();

  for (const [name, dir] of Object.entries(spec.write)) await attempt(`write:${name}`, () => writeNew(dir));
  for (const [name, file] of Object.entries(spec.read)) await attempt(`read:${name}`, async () => { await (await fs.open(file, 'r')).close(); return {}; });
  for (const [name, dir] of Object.entries(spec.list)) await attempt(`list:${name}`, async () => ({ entries: (await fs.readdir(dir)).length }));
  await attempt('overwrite:outside-file', async () => { await (await fs.open(spec.outsideFile, 'r+')).close(); return {}; });
  await attempt('hardlink:outside-file', async () => {
    const link = path.join(spec.write.tmp, `link-${randomUUID()}`);
    await fs.link(spec.outsideFile, link);
    await fs.rm(link, { force: true }).catch(() => {});
    return {};
  });
  await attempt('net:internet', () => connect({ host: '1.1.1.1', port: 443 }));
  await attempt('net:listener', () => connect({ host: '127.0.0.1', port: spec.port }));
  await attempt('net:listener-v6', () => connect({ host: '::1', port: spec.port6 }));
  await attempt('pipe:outer', () => connect({ path: spec.pipe }));
  await attempt('net:listen-local', () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => server.close(() => resolve({})));
  }));
  for (const [name, command] of Object.entries(spec.commands)) {
    const r = await run(command[0], command.slice(1), { timeout: 20_000 });
    out[`cmd:${name}`] = { ok: r.exit === 0, exit: r.exit, ...(r.error ? { code: r.error } : {}), head: (r.stdout || r.stderr).trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 300) };
  }
  // 凭据库：外面放了一个随机名的测试条目，这里只看列不列得出它的名字。
  const listed = await run('cmdkey.exe', ['/list'], { timeout: 20_000 });
  out['credential:list'] = { ok: listed.exit === 0, exit: listed.exit, seesProbe: listed.stdout.includes(spec.credential) };
  console.log(MARK + JSON.stringify(out));
}

// ---------- 外层：在隔离外准备并汇总 ----------
const toml = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function outer(codex, resultFile) {
  if (process.platform !== 'win32') throw new Error('这份探针只在 Windows 上跑。');
  const self = fileURLToPath(import.meta.url);
  const id = randomUUID().slice(0, 8);
  const home = os.homedir();
  const result = { at: new Date().toISOString(), os: `${os.type()} ${os.release()} ${os.version()}`, arch: process.arch, node: process.version, user: os.userInfo().username, cases: {} };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xagents-probe-'));
  const base = await fs.realpath(temp);
  const worktree = path.join(base, 'worktree'), tmp = path.join(base, 'job-tmp'), codexHome = path.join(base, 'codex-home');
  const outside = path.join(base, 'outside');
  for (const dir of [worktree, tmp, codexHome, outside]) await fs.mkdir(dir);
  const outsideFile = path.join(outside, 'existing.txt'); await fs.writeFile(outsideFile, 'outside');
  // 家目录里：一个不在禁读名单上的普通文件，一个探针专用的“密钥”目录（权限表里禁读）。
  const plain = path.join(home, `xagents-probe-plain-${id}.txt`); await fs.writeFile(plain, 'plain');
  const secretDir = path.join(home, `.xagents-probe-secret-${id}`); await fs.mkdir(secretDir);
  const secret = path.join(secretDir, 'secret.txt'); await fs.writeFile(secret, 'secret');
  // 盘符根下三个文件夹，分别允许“所有人”“已登录用户”“本机用户组”修改，看隔离挡不挡得住。
  const shared = {};
  for (const [name, sid] of [['everyone', '*S-1-1-0'], ['authenticated', '*S-1-5-11'], ['users', '*S-1-5-32-545']]) {
    const dir = path.join(path.parse(home).root, `xagents-probe-${name}-${id}`);
    await fs.mkdir(dir);
    const r = await run('icacls.exe', [dir, '/grant', `${sid}:(OI)(CI)M`]);
    shared[name] = { dir, granted: r.exit === 0 };
  }
  const credential = `xagents-probe-${id}`;
  const cred = await run('cmdkey.exe', [`/generic:${credential}`, '/user:probe', `/pass:${randomUUID()}`]);
  result.credentialCreated = cred.exit === 0;

  const server = net.createServer(s => s.destroy()), server6 = net.createServer(s => s.destroy()), pipeServer = net.createServer(s => s.destroy());
  const pipe = `\\\\.\\pipe\\xagents-probe-${id}`;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await new Promise(r => server6.listen(0, '::1', r)).catch(() => {});
  await new Promise(r => pipeServer.listen(pipe, r));

  const spec = {
    write: { worktree, tmp, home, outside, 'user-temp': path.join(home, 'AppData', 'Local', 'Temp'), 'windows-temp': path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp'),
      public: path.join(path.parse(home).root, 'Users', 'Public'), programdata: process.env.ProgramData || 'C:\\ProgramData', 'drive-root': path.parse(home).root,
      'startup-folder': path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), 'codex-home': codexHome,
      'shared-everyone': shared.everyone.dir, 'shared-authenticated': shared.authenticated.dir, 'shared-users': shared.users.dir },
    read: { 'home-plain': plain, 'home-secret': secret, 'outside-file': outsideFile, self },
    list: { home, 'home-secret-dir': secretDir, appdata: path.join(home, 'AppData', 'Roaming'), localappdata: path.join(home, 'AppData', 'Local'),
      'credentials-roaming': path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials'), 'credentials-local': path.join(home, 'AppData', 'Local', 'Microsoft', 'Credentials'),
      'protect-roaming': path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Protect'), 'codex-home': codexHome, worktree },
    outsideFile, port: server.address().port, port6: server6.address()?.port ?? 1, pipe, credential,
    commands: { node: [process.execPath, '--version'], git: ['git.exe', '--version'], whoami: ['whoami.exe'], 'whoami-groups': ['whoami.exe', '/groups', '/fo', 'csv', '/nh'] },
  };
  const specFile = path.join(worktree, 'spec.json'); await fs.writeFile(specFile, JSON.stringify(spec));
  const probe = path.join(worktree, 'probe.mjs'); await fs.copyFile(self, probe);

  const env = { ...process.env, CODEX_HOME: codexHome, TEMP: tmp, TMP: tmp, TMPDIR: tmp, XAGENTS_PROBE_API_KEY: randomUUID() };
  const version = await run(codex, ['--version'], { env });
  result.codex = (version.stdout || version.stderr).trim();

  const profile = (extend, extra = '') =>
    `permissions.xa={extends="${extend}",filesystem={${[[secretDir, 'deny'], [':tmpdir', 'read'], [tmp, 'write']].map(([p, v]) => `${toml(p)}="${v}"`).join(',')}}${extra}}`;
  const envPolicy = `shell_environment_policy.exclude=[${SECRET_WORDS.map(w => `"*${w}*"`).join(',')}]`;
  const innerCommand = ['--', process.execPath, probe, '--inner', specFile];
  const brief = r => ({ exit: r.exit, ms: r.ms, ...(r.timedOut ? { timedOut: true } : {}), ...(r.error ? { error: r.error } : {}), stdout: r.stdout.replace(new RegExp(`^${MARK}.*$`, 'm'), '').trim().slice(-3000), stderr: r.stderr.trim().slice(-3000) });
  const sandboxCase = async (name, mode, args) => {
    const r = await run(codex, [...(mode ? ['-c', `windows.sandbox="${mode}"`] : []), 'sandbox', ...args, ...innerCommand], { cwd: worktree, env, timeout: 180_000 });
    const line = r.stdout.split(/\r?\n/).find(l => l.startsWith(MARK));
    let probes = null;
    try { probes = line ? JSON.parse(line.slice(MARK.length)) : null; } catch { /* 留空，原始输出在 run 里 */ }
    result.cases[name] = { mode, args, run: brief(r), probes };
    console.log(`[${name}] 退出码 ${r.exit}，${probes ? '拿到探针结果' : '没有探针结果'}，用时 ${r.ms} 毫秒`);
  };

  try {
    // 不在隔离里跑一遍，作对照：下面每一项在隔离外本来是什么结果。
    const plainRun = await run(process.execPath, [probe, '--inner', specFile], { cwd: worktree, env });
    const plainLine = plainRun.stdout.split(/\r?\n/).find(l => l.startsWith(MARK));
    result.cases['outside-sandbox'] = { run: brief(plainRun), probes: plainLine ? JSON.parse(plainLine.slice(MARK.length)) : null };

    // 没装隔离时直接用，会怎样（是否弹窗、是否报错、是否悄悄降级）。
    await sandboxCase('before-setup:elevated', 'elevated', ['-P', ':workspace', '-C', worktree]);
    const setup = await run(codex, ['sandbox', 'setup', '--elevated', '--current-user'], { cwd: worktree, env, timeout: 300_000 });
    result.setup = brief(setup);
    console.log(`[setup] 退出码 ${setup.exit}，用时 ${setup.ms} 毫秒`);
    result.setupFiles = await fs.readdir(codexHome, { recursive: true }).catch(e => [String(e.code)]);
    result.configAfterSetup = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8').catch(() => null);

    await sandboxCase('elevated:workspace-builtin', 'elevated', ['-P', ':workspace', '-C', worktree]);
    await sandboxCase('elevated:xa-write', 'elevated', ['-P', 'xa', '-C', worktree, '-c', profile(':workspace'), '-c', envPolicy]);
    await sandboxCase('elevated:xa-readonly', 'elevated', ['-P', 'xa', '-C', worktree, '-c', profile(':read-only'), '-c', envPolicy]);
    await sandboxCase('elevated:xa-network-on', 'elevated', ['-P', 'xa', '-C', worktree, '-c', profile(':workspace', ',network={enabled=true}'), '-c', envPolicy]);
    // 换一个空的 Codex 文件夹（DeepSeek 就是这样）：隔离还认不认，要不要再装一次。
    const otherHome = path.join(base, 'codex-home-2'); await fs.mkdir(otherHome);
    const saved = env.CODEX_HOME; env.CODEX_HOME = otherHome;
    await sandboxCase('elevated:other-codex-home', 'elevated', ['-P', 'xa', '-C', worktree, '-c', profile(':workspace'), '-c', envPolicy]);
    const setup2 = await run(codex, ['sandbox', 'setup', '--elevated', '--current-user'], { cwd: worktree, env, timeout: 300_000 });
    result.setupOtherHome = brief(setup2);
    await sandboxCase('elevated:other-codex-home-after-setup', 'elevated', ['-P', 'xa', '-C', worktree, '-c', profile(':workspace'), '-c', envPolicy]);
    env.CODEX_HOME = saved;
    // 装过第二个文件夹以后，第一个还好不好用（两个文件夹共用同一对专用账户）。
    await sandboxCase('elevated:first-home-again', 'elevated', ['-P', 'xa', '-C', worktree, '-c', profile(':workspace'), '-c', envPolicy]);
    // 对照：另外两种做法和“什么都不写”。只为记录它们为什么不能用。
    await sandboxCase('unelevated:xa-write', 'unelevated', ['-P', 'xa', '-C', worktree, '-c', profile(':workspace'), '-c', envPolicy]);
    await sandboxCase('unset:xa-write', null, ['-P', 'xa', '-C', worktree, '-c', profile(':workspace'), '-c', envPolicy]);
    result.sandboxLogs = {};
    for (const name of await fs.readdir(path.join(codexHome, '.sandbox')).catch(() => [])) {
      if (name.endsWith('.log')) result.sandboxLogs[name] = (await fs.readFile(path.join(codexHome, '.sandbox', name), 'utf8').catch(() => '')).slice(-5000);
    }
    const users = await run('net.exe', ['user']);
    result.localUsers = users.stdout.split(/\s+/).filter(name => /sandbox/i.test(name));
  } finally {
    server.close(); server6.close(); pipeServer.close();
    await run('cmdkey.exe', [`/delete:${credential}`]);
    for (const file of [plain]) await fs.rm(file, { force: true }).catch(() => {});
    for (const dir of [secretDir, ...Object.values(shared).map(s => s.dir)]) await fs.rm(dir, { recursive: true, force: true }).catch(e => { result.cleanupErrors = [...(result.cleanupErrors ?? []), `${dir}: ${e.code}`]; });
    await fs.writeFile(resultFile, JSON.stringify(result, null, 2));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(e => console.log(`临时目录没删干净：${e.code}`));
  }
}

const args = process.argv.slice(2);
if (args[0] === '--inner') await inner(JSON.parse(await fs.readFile(args[1], 'utf8')));
else if (args.length === 2) await outer(path.resolve(args[0]), path.resolve(args[1]));
else { console.error('用法：node scripts/probe/windows-codex.mjs <codex.exe> <结果.json>'); process.exitCode = 2; }
