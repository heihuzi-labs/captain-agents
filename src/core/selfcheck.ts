import { mkdtemp, mkdir, rm, rmdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { paths } from './paths.ts';
import { readJson, writeJson, hasCode, withLock } from './fsx.ts';
import { sandbox, codexPermissions, deepseekHome, keychainDirs, SHELL_FILES, CREDENTIAL_FILES } from './sandbox.ts';
import { srtPath, securityPath } from './workers.ts';
import { SECRET_WORDS, SRT_OWN_VARS, codexEnvPolicy, exactEnv, workerEnv } from './env.ts';
import { extraDenyRead } from './settings.ts';
import { whos, isolationOf, isolations } from './roster.ts';
import type { Isolation } from './roster.ts';
import { execute } from './verify.ts';
import type { Executor } from './verify.ts';
import type { Job } from './job.ts';
import type { Project } from './project.ts';

export type { Isolation };
export type Probe = { name: string; outcome: 'allowed' | 'denied' | 'unknown'; reason: string; created?: { path: string; dir: boolean; ino: number | null }[] };
export type IsolationResult = { isolation: Isolation; probes: Probe[]; error?: string };
// 探针的做法改了就升版本号：旧版本的缓存即使名字齐全、写着通过，也要重新自检。
// 2：2026-09-30 全局配置探针改为“写成就算放行”、已有文件只写方式打开。
// 3：2026-09-30 加公用临时目录和硬链接探针，选手只能写任务自己的 tmp。
// 4：2026-10-02 加 DeepSeek 登录文件夹探针，三种隔离都要读不到。
// 5：2026-10-02 加钥匙串探针（读测试条目、列两个钥匙串文件夹），三种隔离都要读不到。
// 6：2026-10-02 加环境变量探针：外面放一个名字带 KEY 的假变量，三种隔离里都要看不到，也不许有别的带密钥字样的变量；
//    加终端配置文件和命令历史的禁读探针。
// 7：2026-10-03 加常见登录凭据文件（~/.netrc、~/.git-credentials、~/.docker、~/.kube 等）的禁读探针；
//    钥匙串和环境变量两条并行的修复合并，统一升到这一版（两边各自升过的 5、6 都作废重检）。
const cacheVersion = 7;
export type Selfcheck = { version: typeof cacheVersion; ok: boolean; at: string; note: string; results: IsolationResult[] };
// 自检覆盖选手清单里出现的每一种隔离；新选手沿用已有隔离就自动被覆盖。
const modes: Isolation[] = isolations;
// 各家在隔离外会自动加载、甚至以主人身份执行的全局位置：选手写得进去，主人之后打开这些程序就会中招。
// 三种隔离都要写不进去（别家的也不行）。依据 docs/research/global-config-writes-2026-09-30.md。
export const globalTargets: { name: string; path: string; dir: boolean; label: string }[] = [
  { name: 'cursor-hooks', path: '.cursor/hooks.json', dir: false, label: '写 Cursor 全局钩子' },
  { name: 'cursor-skills', path: '.cursor/skills', dir: true, label: '写 Cursor 全局技能' },
  { name: 'cursor-rules', path: '.cursor/rules', dir: true, label: '写 Cursor 全局规矩' },
  { name: 'cursor-mcp', path: '.cursor/mcp.json', dir: false, label: '写 Cursor 外部连接' },
  { name: 'cursor-config', path: '.cursor/cli-config.json', dir: false, label: '改 Cursor 命令行配置' },
  { name: 'cursor-trust', path: '.cursor/projects', dir: true, label: '写 Cursor 信任标记' },
  { name: 'cursor-install', path: '.local/share/cursor-agent', dir: true, label: '改 Cursor 程序' },
  { name: 'grok-skills', path: '.grok/skills', dir: true, label: '写 Grok 全局技能' },
  { name: 'grok-agents', path: '.grok/AGENTS.md', dir: false, label: '写 Grok 全局规矩文件' },
  { name: 'grok-rules', path: '.grok/rules', dir: true, label: '写 Grok 全局规矩目录' },
  { name: 'grok-hooks', path: '.grok/hooks', dir: true, label: '写 Grok 全局钩子' },
  { name: 'grok-config', path: '.grok/config.toml', dir: false, label: '改 Grok 配置' },
  { name: 'grok-admin', path: '.grok/requirements.toml', dir: false, label: '写 Grok 管理员配置' },
  { name: 'grok-memory', path: '.grok/memory', dir: true, label: '写 Grok 记忆' },
  { name: 'grok-plugins', path: '.grok/installed-plugins', dir: true, label: '写 Grok 插件' },
  { name: 'grok-install', path: '.grok/bin', dir: true, label: '改 Grok 程序' },
  { name: 'grok-sessions', path: '.grok/sessions', dir: true, label: '写 Grok 别处的会话记录' },
  { name: 'grok-login', path: '.grok/auth.json', dir: false, label: '改 Grok 登录文件' },
  { name: 'claude-config', path: '.claude', dir: true, label: '写 Claude 的配置和钩子' },
  { name: 'agents-skills', path: '.agents', dir: true, label: '写公用技能目录' },
  { name: 'codex-config', path: '.codex', dir: true, label: '写 Codex 的配置' },
];
// 公用临时目录：选手只能写任务自己的 tmp（TMPDIR），这些地方三种隔离都要写不进去。
// 负责人会话的草稿和后台输出、srt 的公用临时目录、系统给本用户的临时和缓存目录（别的程序的临时文件、套接字）、npm 日志。
// 依据 docs/research/tmp-writes-2026-09-30.md。路径由外面算好传进探针（getconf 在隔离里不一定能跑）。
export const tempTargets = [
  { name: 'tmp-lead', label: '写负责人会话的临时目录' },
  { name: 'tmp-shared', label: '写公用临时目录 /tmp' },
  { name: 'tmp-srt', label: '写隔离工具的公用临时目录' },
  { name: 'tmp-user', label: '写系统给本用户的临时目录' },
  { name: 'tmp-cache', label: '写系统给本用户的缓存目录' },
  { name: 'npm-logs', label: '写 npm 日志目录' },
] as const;
export type TempPaths = Record<(typeof tempTargets)[number]['name'], string | null>;
export async function tempPaths(run: Executor, cwd: string, home = homedir()): Promise<TempPaths> {
  const conf = async (name: string) => {
    const r = await run('/usr/bin/getconf', [name], cwd, 5000);
    const dir = r.exit === 0 && !r.timedOut && !r.error ? r.output.trim().replace(/\/+$/, '') : '';
    return dir.startsWith('/') ? realpath(dir).catch(() => null) : null;
  };
  return {
    'tmp-lead': `/private/tmp/claude-${process.getuid?.() ?? ''}`, 'tmp-shared': '/private/tmp', 'tmp-srt': '/private/tmp/claude',
    'tmp-user': await conf('DARWIN_USER_TEMP_DIR'), 'tmp-cache': await conf('DARWIN_USER_CACHE_DIR'),
    // 没有 ~/.npm 时建不出 _logs（报“不存在”会误判成拿不准），改查家目录本身：家目录写不进，这一串就都建不出来。
    'npm-logs': await lstat(join(home, '.npm')).then(() => join(home, '.npm/_logs'), () => home),
  };
}
// 钥匙串：读自检临时放进登录钥匙串的测试条目，再列本用户和系统的钥匙串文件夹。三种隔离都要读不到。
// 依据 docs/research/keychain-2026-10-02.md。
const keychainProbes = ['keychain', 'keychain-user', 'keychain-system'];
// 测试条目：随机名、随机值，不是任何真密码；自检前在外面建好并读回核对，结束后删掉。
export type KeychainItem = { account: string; service: string; value: string };
export function expectedProbes(mode: Isolation) {
  // Codex 的登录文件由它在隔离外的主进程读取，所以它的隔离里三家都必须读不到；
  // Grok、Cursor 整个跑在外层隔离里，必须能读自己的登录文件，只要求读不到别家的。
  // DeepSeek 的登录（API 钥匙）放在派活工作台单独的文件夹里，由 Codex 主进程在隔离外读，三种隔离都必须读不到。
  const logins = [...(mode === 'codex' ? ['login-codex', 'login-grok', 'login-cursor'] : mode === 'grok' ? ['login-codex', 'login-cursor'] : ['login-codex', 'login-grok']), 'login-deepseek'];
  return ['worktree', 'tmpdir', 'hardlink', 'home', 'chrome', 'listener', 'internet', 'ssh', 'npmrc', 'shell-files', 'credential-files', 'env-secret', ...logins, ...keychainProbes, ...globalTargets.map(t => t.name), ...tempTargets.map(t => t.name)];
}
// 这两项必须写得进去，其余一律要挡住。
const mustAllow = ['worktree', 'tmpdir'];
const labels: Record<string, string> = { ...Object.fromEntries([...globalTargets, ...tempTargets].map(t => [t.name, t.label])), worktree: '副本内写文件', tmpdir: '任务专用临时目录可写（TMPDIR 指向它）', hardlink: '借硬链接改外面的文件', home: '目录外写文件', chrome: 'Chrome 调试口', listener: '本机监听端口', internet: '外网', ssh: '读 SSH 文件名', npmrc: '读 npm 登录配置', 'login-codex': '读 Codex 登录文件', 'login-grok': '读 Grok 登录文件', 'login-cursor': '读 Cursor 登录文件', 'login-deepseek': '读 DeepSeek 登录文件夹', keychain: '读钥匙串里的密码', 'keychain-user': '读本用户的钥匙串文件夹', 'keychain-system': '读系统的钥匙串文件夹', 'env-secret': '看到带密钥字样的环境变量', 'shell-files': '读终端配置文件和命令历史', 'credential-files': '读常见的登录凭据文件' };
export function evaluate(results: IsolationResult[], at = new Date().toISOString()): Selfcheck {
  const failures: string[] = [];
  for (const isolation of modes) {
    const matches = results.filter(r => r?.isolation === isolation);
    if (matches.length !== 1) { failures.push(`${isolation} 未能自检（结果缺失或重复）`); continue; }
    const r = matches[0];
    if (r.error) { failures.push(`${isolation} 未能自检：${r.error}`); continue; }
    for (const name of expectedProbes(isolation)) {
      const found = Array.isArray(r.probes) ? r.probes.filter(p => p?.name === name) : [];
      const p = found[0];
      if (found.length !== 1 || !p || !['allowed', 'denied', 'unknown'].includes(p.outcome)) { failures.push(`${isolation} ${labels[name]} 缺少有效结果`); continue; }
      if (p.outcome !== (mustAllow.includes(name) ? 'allowed' : 'denied')) failures.push(`${isolation} ${labels[name]} ${p.outcome === 'unknown' ? '拿不准' : '未达到要求'}：${p.reason || '没有原因'}`);
    }
  }
  return { version: cacheVersion, ok: failures.length === 0, at, note: failures.join('；') || '目录外写、公用临时目录、硬链接、各家全局配置、Chrome 调试口、本机端口、外网、读密钥和登录文件、钥匙串、终端配置文件、常见凭据文件、带密钥字样的环境变量都被挡住，副本内可写', results };
}
export function networkOutcome(outcomes: Probe['outcome'][]): Probe['outcome'] {
  if (outcomes.includes('allowed')) return 'allowed';
  return outcomes.length && outcomes.every(o => o === 'denied') ? 'denied' : 'unknown';
}
export function permissionOutcome(code: string): Probe['outcome'] {
  return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown';
}

// 只输出结果和错误码；不输出文件名、凭据内容，也不向本机端口发送数据。
// linkTarget：隔离外一个已有的文件（选手读得到、写不进），用来查能不能在可写目录里给它建硬链接、借此改它。
// keychain：外面建好的钥匙串测试条目；没建成时传 null，钥匙串探针记为拿不准。
// fakes：外面放进环境的假变量名（名字带 KEY 等字样，值是随机数，不是真密钥）；探针只报变量名，不读值。
export function probeSource(mode: Isolation, worktree: string, homeFile: string, port: number | null, marker: string, token: string, temp: TempPaths, tmp: string, linkTarget: string, keychain: KeychainItem | null, fakes: string[]) {
  return `import { writeFile, rm, readdir, open, mkdir, rmdir, stat, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
const probes = [];
const outcome = ${permissionOutcome.toString()};
const combine = ${networkOutcome.toString()};
async function test(name, fn) {
  try { await fn(); probes.push({name, outcome:'allowed', reason:'操作成功'}); }
  catch(e) { probes.push({name, outcome:outcome(e.code), reason:e.code || '未知错误'}); }
}
await test('worktree', async () => { const p = join(${JSON.stringify(worktree)}, 'write-probe'); await writeFile(p, 'probe', {flag:'wx'}); await rm(p); });
// 任务专用临时目录：TMPDIR 必须正好指向它，而且写得进去。
await test('tmpdir', async () => {
  if ((process.env.TMPDIR || '').replace(/\\/+$/, '') !== ${JSON.stringify(tmp)}) throw {code:'TMPDIR_MISMATCH'};
  const p = join(${JSON.stringify(tmp)}, 'write-probe'); await writeFile(p, 'probe', {flag:'wx'}); await rm(p);
});
await test('hardlink', async () => { const p = join(${JSON.stringify(tmp)}, ${JSON.stringify(token)}); await link(${JSON.stringify(linkTarget)}, p); await rm(p).catch(() => {}); });
await test('home', () => writeFile(${JSON.stringify(homeFile)}, 'xagents selfcheck', {flag:'wx'}));
if (probes.at(-1).outcome === 'allowed') await rm(${JSON.stringify(homeFile)}).catch(e => { probes.at(-1).reason += '，清理失败：' + (e.code || '未知错误'); });
function connect(port) { return new Promise((resolve, reject) => {
  const s = net.connect({host:'127.0.0.1', port});
  const done = (e) => { s.destroy(); e ? reject(e) : resolve(); };
  s.once('connect', () => done()); s.once('error', done); s.setTimeout(2500, () => done({code:'ETIMEDOUT'}));
}); }
// srt 通过代理允许自家服务；直连与代理都要挡住，才算不能联网。
async function networkTest(name, host, port, direct) {
  const attempts = [];
  async function attempt(fn) {
    try { await fn(); attempts.push({outcome:'allowed', reason:'连接成功'}); }
    catch(e) { attempts.push({outcome:e.code === 'PROXY_DENIED' ? 'denied' : outcome(e.code), reason:e.code || '未知错误'}); }
  }
  await attempt(direct);
  const proxies = [...new Set([process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.ALL_PROXY, process.env.https_proxy, process.env.http_proxy, process.env.all_proxy].filter(Boolean))];
  for (const address of proxies) await attempt(() => new Promise((resolve, reject) => {
    const proxy = new URL(address);
    if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') {
      const authenticated = Boolean(proxy.username || proxy.password);
      const username = Buffer.from(decodeURIComponent(proxy.username));
      const password = Buffer.from(decodeURIComponent(proxy.password));
      if (authenticated && (!username.length || username.length > 255 || !password.length || password.length > 255)) { reject({code:'PROXY_AUTH_INVALID'}); return; }
      const socket = net.connect({host:proxy.hostname, port:Number(proxy.port || 1080)});
      let phase = 0, buffer = Buffer.alloc(0), done = false;
      const finish = error => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve(); };
      socket.setTimeout(2500, () => finish({code:'ETIMEDOUT'})); socket.once('error', finish);
      socket.once('end', () => finish({code:'PROXY_CLOSED'}));
      function requestTarget() {
        phase = 2;
        const target = Buffer.from(host);
        socket.write(Buffer.concat([Buffer.from([5,1,0,3,target.length]),target,Buffer.from([port>>8,port&255])]));
      }
      socket.once('connect', () => socket.write(Buffer.from([5,1,authenticated ? 2 : 0])));
      socket.on('data', data => {
        buffer = Buffer.concat([buffer,data]);
        if (phase === 0 && buffer.length >= 2) {
          if (buffer[0] !== 5 || buffer[1] !== (authenticated ? 2 : 0)) { finish({code:'PROXY_AUTH_UNSUPPORTED'}); return; }
          buffer = buffer.subarray(2);
          if (authenticated) {
            phase = 1;
            socket.write(Buffer.concat([Buffer.from([1,username.length]),username,Buffer.from([password.length]),password]));
          } else requestTarget();
        }
        if (phase === 1 && buffer.length >= 2) {
          if (buffer[0] !== 1 || buffer[1] !== 0) { finish({code:'PROXY_AUTH_FAILED'}); return; }
          buffer = buffer.subarray(2); requestTarget();
        }
        if (phase === 2 && buffer.length >= 4) {
          if (buffer[0] !== 5) finish({code:'PROXY_PROTOCOL_UNKNOWN'});
          else if (buffer[1] === 0) finish();
          else finish({code:buffer[1] === 2 ? 'PROXY_DENIED' : 'PROXY_SOCKS_STATUS_'+buffer[1]});
        }
      });
      return;
    }
    if (proxy.protocol !== 'http:') { reject({code:'UNSUPPORTED_PROXY'}); return; }
    const headers = {};
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
    const req = http.request({hostname:proxy.hostname, port:proxy.port || 80, method:'CONNECT', path:host+':'+port, headers, agent:false});
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(),{code:'ETIMEDOUT'})),2500);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject);
    req.once('connect', (res, socket) => { socket.destroy(); res.statusCode === 200 ? resolve() : reject({code:res.statusCode === 403 ? 'PROXY_DENIED' : 'PROXY_STATUS_'+res.statusCode}); });
    req.end();
  }));
  probes.push({name, outcome:combine(attempts.map(a=>a.outcome)), reason:attempts.map(a=>a.reason).join('、')});
}
await networkTest('chrome', '127.0.0.1', 9222, () => connect(9222));
${port ? `await networkTest('listener', '127.0.0.1', ${port}, () => connect(${port}));` : "probes.push({name:'listener',outcome:'unknown',reason:'没有找到可验证的本机监听端口'});"}
// 外网：直接连一个公共 IP 的 443 端口，只看能否建立连接。不做 TLS（Node 做 TLS 要读钥匙串里的系统证书，
// Codex 的隔离不让碰钥匙串，Node 会直接崩溃），也不查域名（查不到域名分不清是被挡还是断网）。
await networkTest('internet', '1.1.1.1', 443, () => new Promise((resolve, reject) => {
  const s = net.connect({host:'1.1.1.1', port:443});
  const done = (e) => { s.destroy(); e ? reject(e) : resolve(); };
  s.once('connect', () => done()); s.once('error', done); s.setTimeout(4000, () => done({code:'ETIMEDOUT'}));
}));
await test('ssh', () => readdir(join(homedir(), '.ssh')));
await test('npmrc', async () => { const fd = await open(join(homedir(), '.npmrc'), 'r'); await fd.close(); });
// 终端配置文件、命令历史和常见的登录凭据文件：本机有的必须读不到（没有权限），本机没有的（不存在）不算数；读得到任何一个就是放行。
// 只看能不能打开（目录看能不能列出），不读内容，也不报文件名。
async function unreadable(name, files) {
  const results = [];
  for (const f of files) {
    try { await readdir(join(homedir(), f)); results.push('allowed'); }
    catch (e) {
      if (e.code !== 'ENOTDIR') { results.push(e.code === 'ENOENT' ? 'absent' : outcome(e.code)); continue; }
      try { const fd = await open(join(homedir(), f), 'r'); await fd.close(); results.push('allowed'); }
      catch (e2) { results.push(e2.code === 'ENOENT' ? 'absent' : outcome(e2.code)); }
    }
  }
  const count = o => results.filter(r => r === o).length;
  probes.push({name, outcome:count('allowed') ? 'allowed' : count('unknown') ? 'unknown' : 'denied', reason:'读得到 ' + count('allowed') + ' 个，挡住 ' + count('denied') + ' 个，拿不准 ' + count('unknown') + ' 个，本机没有 ' + count('absent') + ' 个'});
}
await unreadable('shell-files', ${JSON.stringify(SHELL_FILES)});
await unreadable('credential-files', ${JSON.stringify(CREDENTIAL_FILES)});
// 环境变量：外面放的假变量看不到，也没有别的名字带密钥字样的变量，才算挡住。只报名字。
// srt 自己设的代理口令（SRT_OWN_VARS）只在值正好等于 HTTP_PROXY 网址里的口令时放过；只比较、不输出值。
{
  const fakes = ${JSON.stringify(fakes)}, words = ${JSON.stringify(SECRET_WORDS)}, own = ${JSON.stringify(mode === 'codex' ? [] : SRT_OWN_VARS)};
  let proxyPassword = null;
  try { proxyPassword = decodeURIComponent(new URL(process.env.HTTP_PROXY || '').password) || null; } catch {}
  const seen = Object.keys(process.env).filter(n => fakes.includes(n) || (words.some(w => n.toUpperCase().includes(w)) && !(own.includes(n) && proxyPassword !== null && process.env[n] === proxyPassword)));
  probes.push({name:'env-secret', outcome:seen.length ? 'allowed' : 'denied', reason:seen.length ? '看得到 ' + seen.join('、') : '看不到'});
}
${expectedProbes(mode).filter(n => n.startsWith('login-')).map(name => {
    // 文件夹由自检在外面先建好，所以查“能不能列出”，没登录时也有确定的结果。
    if (name === 'login-deepseek') return `await test('login-deepseek', () => readdir(${JSON.stringify(deepseekHome())}));`;
    const path = { 'login-codex': '.codex/auth.json', 'login-grok': '.grok/auth.json', 'login-cursor': '.cursor/cli-config.json' }[name];
    return `await test(${JSON.stringify(name)}, async () => { const fd = await open(join(homedir(), ${JSON.stringify(path)}), 'r'); await fd.close(); });`;
  }).join('\n')}
// 钥匙串：用系统的 security 读测试条目（条目只信任 security，读得到时不弹窗）。只比对读出的是不是那个值，不打印内容。
// security 跑起来但读不出（退出码非 0）算挡住；读出别的、超时、启动不了都算拿不准。
${keychain ? `await new Promise(resolve => execFile(${JSON.stringify(securityPath())}, ['find-generic-password', '-a', ${JSON.stringify(keychain.account)}, '-s', ${JSON.stringify(keychain.service)}, '-w'], {timeout:10000}, (e, stdout) => {
  if (!e) probes.push(String(stdout).trim() === ${JSON.stringify(keychain.value)} ? {name:'keychain', outcome:'allowed', reason:'读出了测试条目'} : {name:'keychain', outcome:'unknown', reason:'读出的内容对不上'});
  else if (typeof e.code === 'number' && !e.killed) probes.push({name:'keychain', outcome:'denied', reason:'security 退出码 ' + e.code});
  else probes.push({name:'keychain', outcome:'unknown', reason:e.killed ? '超时' : (e.code || '未知错误')});
  resolve();
}));` : "probes.push({name:'keychain', outcome:'unknown', reason:'没能在钥匙串里放测试条目'});"}
await test('keychain-user', () => readdir(${JSON.stringify(keychainDirs()[0])}));
await test('keychain-system', () => readdir(${JSON.stringify(keychainDirs()[1])}));
// 全局配置：已有的文件用“只写、不截断、不新建”方式打开，不改内容；已有的目录里建一个随机名空文件；还没有的按真实路径建出来。
// 判定只看写这一步：写成了就是放行，删不掉另记原因。建出来的东西连同文件编号报给外面，外面只删编号对得上的。
// keep：公用临时目录。探针万一在里面建出了固定名的目录，不删（别的程序可能同时在删建同名目录），只报出来。
async function writable(name, target, dir, keep = false) {
  const created = [];
  const made = async (path, isDir, fd) => { let ino = null; try { ino = (await (fd ? fd.stat() : stat(path))).ino; } catch {} created.push({path, dir:isDir, ino}); };
  try {
    if (dir) {
      const inside = join(target, ${JSON.stringify(token)});
      let fd;
      try { fd = await open(inside, 'wx'); }
      catch(e) { if (e.code !== 'ENOENT') throw e; await mkdir(target); await made(target, true); }
      if (fd) { await made(inside, false, fd); await fd.close().catch(() => {}); }
    } else {
      let fd;
      try { fd = await open(target, constants.O_WRONLY); await fd.close().catch(() => {}); }
      catch(e) {
        if (e.code !== 'ENOENT') throw e;
        fd = await open(target, 'wx'); await made(target, false, fd); await fd.close().catch(() => {});
      }
    }
  } catch(e) {
    if (!created.length) { probes.push({name, outcome:outcome(e.code), reason:e.code || '未知错误'}); return; }
  }
  let reason = '操作成功';
  for (const c of [...created].reverse()) {
    if (keep && c.path === target) { reason += '，建出的公用目录没有删'; continue; }
    try { c.dir ? await rmdir(c.path) : await rm(c.path); } catch(e) { reason += '，清理失败：' + (e.code || '未知错误'); }
  }
  probes.push({name, outcome:'allowed', reason, created});
}
for (const t of ${JSON.stringify(globalTargets.map(({ name, path, dir }) => ({ name, path, dir })))}) await writable(t.name, join(homedir(), t.path), t.dir);
for (const [name, path] of Object.entries(${JSON.stringify(temp)})) {
  if (path) await writable(name, path, true, true); else probes.push({name, outcome:'unknown', reason:'查不到这个位置'});
}
console.log(${JSON.stringify(marker)} + JSON.stringify(probes));
`;
}
// 探针若意外写成功，外面再清一遍，但只删能证明是探针建的：各目录里的随机名文件（名字独一无二），
// 以及探针报告建过、文件编号对得上的目标。探针前还不存在、后来出现、却没被探针报告的，不删，报错让负责人查。
type Before = Map<string, boolean>;
const writeTargets = (home: string, temp: Partial<TempPaths>) => [
  ...globalTargets.map(t => ({ path: join(home, t.path), dir: t.dir, shared: false })),
  ...Object.values(temp).filter((path): path is string => Boolean(path)).map(path => ({ path, dir: true, shared: true })),
];
export async function globalBefore(home = homedir(), temp: Partial<TempPaths> = {}): Promise<Before> {
  const before: Before = new Map();
  // 只有“确实不存在”才算原来没有；其他错误一律按原来就有处理，不动它。
  for (const t of writeTargets(home, temp)) before.set(t.path, await lstat(t.path).then(() => true, e => !hasCode(e, 'ENOENT')));
  return before;
}
type Created = { path: string; dir: boolean; ino: number | null };
export async function cleanGlobal(token: string, before: Before, probes: { created?: Created[] }[] | null, home = homedir(), temp: Partial<TempPaths> = {}): Promise<string[]> {
  const problems: string[] = [], reported = new Map<string, Created>();
  for (const p of probes ?? []) for (const c of Array.isArray(p?.created) ? p.created : []) if (typeof c?.path === 'string') reported.set(c.path, c);
  for (const t of writeTargets(home, temp)) {
    const path = t.path;
    if (t.dir) {
      const inside = join(path, token);
      await rm(inside, { force: true }).catch(e => problems.push(`未能删除自检随机文件 ${inside}：${e.code || '未知错误'}`));
    }
    if (before.get(path) !== false) continue;
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    const c = reported.get(path);
    // 公用临时目录里新出现的固定名目录一律不删：核对编号和删除之间，别的程序可能已换成它自己的同名目录。
    if (t.shared) { problems.push(`自检期间出现了 ${path}（公用临时目录），不自动删，请负责人查看`); continue; }
    if (!c || c.ino === null || c.ino !== info.ino) { problems.push(`自检期间出现了 ${path}，不能确认是探针建的，没有删，请负责人查看`); continue; }
    // 探针建的文件是空的；有了内容说明后来有别的程序写过，不删。目录不空时 rmdir 自己会失败。
    if (!t.dir && info.size !== 0) { problems.push(`探针建出的 ${path} 后来被写进了内容，没有删，请负责人查看`); continue; }
    await (t.dir ? rmdir(path) : rm(path)).catch(e => problems.push(`未能删除探针建出的 ${path}：${e.code || '未知错误'}`));
  }
  return problems;
}
export async function readSelfcheck(now = Date.now()): Promise<{ ok: boolean | null; at: string | null; note: string }> {
  let raw: Selfcheck;
  try { raw = await readJson(join(paths().cache, 'selfcheck.json')); }
  catch (e) { return { ok: hasCode(e, 'ENOENT') ? null : false, at: null, note: hasCode(e, 'ENOENT') ? '还没做过自检' : '自检缓存损坏，请重新自检' }; }
  if (raw && typeof raw.version === 'number' && raw.version < cacheVersion) return { ok: null, at: null, note: '自检的做法更新了，需要重新自检' };
  if (!raw || raw.version !== cacheVersion || !Array.isArray(raw.results) || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return { ok: false, at: null, note: '自检缓存格式无效，请重新自检' };
  const age = now - Date.parse(raw.at);
  if (age < 0 || age >= 86400000) return { ok: null, at: raw.at, note: '自检已过期，请重新自检' };
  const result = evaluate(raw.results, raw.at);
  return { ok: result.ok, at: result.at, note: result.note };
}

// CODEX_HOME 必须为空，不能让负责人现有配置改变探针实际使用的权限。
// TMPDIR 与派活时一样指向任务的 tmp（Codex 的 :workspace 放开的是 $TMPDIR）。
// 环境变量和派活时一样两层：inherited 先按 env.ts 去掉带密钥字样的；inner 是绕过这一层、直接塞给 Codex 的假变量，
// 只靠 Codex 自己的 shell_environment_policy（和派活同一条参数）挡，两层各验一次。
export async function codexProbe(job: Pick<Job, 'mode' | 'repo' | 'worktree'>, project: Pick<Project, 'denyReadExtra'>, script: string, tmp: string, run: Executor = execute, inherited: NodeJS.ProcessEnv = process.env, inner: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'xagents-codex-home-'));
  try {
    const file = process.env.XAGENTS_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
    const env = exactEnv({ ...workerEnv(inherited, { CODEX_HOME: home, TMPDIR: tmp }), ...inner }, { ...process.env, ...inherited });
    return await run(file, ['sandbox', '-P', 'xa', '-C', job.worktree, '-c', codexPermissions({ ...job, id: '' }, project, tmp), '-c', codexEnvPolicy(), '--', process.execPath, script], job.worktree, 20000, undefined, env);
  } finally { await rm(home, { recursive: true, force: true }); }
}
// 测试条目都用这个固定账号名，清理时按它找。
export const KEYCHAIN_ACCOUNT = 'xagents-selfcheck';
// 在登录钥匙串里放一个测试条目（随机名、随机值），读回核对一致才用，否则返回 null。建没建成都由调用方之后统一清扫。
// 条目只信任 security 自己（不带 -T、-A），探针里用 security 读时不弹窗，别的程序读会弹窗，所以探针只用 security。
export async function addKeychainItem(run: Executor = execute): Promise<KeychainItem | null> {
  const item = { account: KEYCHAIN_ACCOUNT, service: `xagents-selfcheck-${randomUUID()}`, value: randomBytes(16).toString('hex') };
  const ok = (r: Awaited<ReturnType<Executor>>) => r.exit === 0 && !r.timedOut && !r.signal && !r.error;
  const added = await run(securityPath(), ['add-generic-password', '-a', item.account, '-s', item.service, '-w', item.value], homedir(), 10_000);
  const back = ok(added) ? await run(securityPath(), ['find-generic-password', '-a', item.account, '-s', item.service, '-w'], homedir(), 10_000) : null;
  return back && ok(back) && back.output.trim() === item.value ? item : null;
}
// 删掉登录钥匙串里所有自检测试条目：按固定账号名找，一次删一条，删到“没有这一项”为止。
// 自检前后各扫一次，上次自检被杀掉、超时后条目才写进去等情况留下的也一并清掉。返回出错原因，没出错返回 null。
export async function sweepKeychainItems(run: Executor = execute): Promise<string | null> {
  for (let i = 0; i < 50; i++) {
    const r = await run(securityPath(), ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT], homedir(), 10_000);
    const failed = r.timedOut || r.signal || r.error;
    if (r.exit === 44 && !failed) return null;
    if (r.exit !== 0 || failed) return `未能删除钥匙串里的自检测试条目（账号 ${KEYCHAIN_ACCOUNT}）：${r.error || (r.timedOut ? '超时' : r.signal ? `被 ${r.signal} 停止` : `退出码 ${r.exit}`)}`;
  }
  return `钥匙串里的自检测试条目（账号 ${KEYCHAIN_ACCOUNT}）删了 50 条还没删完，请负责人查看`;
}
export async function selfcheck(run: Executor = execute): Promise<Selfcheck> {
  await mkdir(paths().cache, { recursive: true });
  return withLock(join(paths().cache, 'selfcheck-run'), async () => {
    const results: IsolationResult[] = [];
    // 嵌套隔离会令探针产生假阳性；这里不启动任何探针，更不尝试解除外层限制。
    if (process.env.CODEX_SANDBOX || process.env.SANDBOX_RUNTIME || process.env.XAGENTS_FAKE_WORKER) {
      for (const isolation of modes) results.push({ isolation, probes: [], error: '当前在选手隔离或测试替身环境内，需要负责人在外面跑' });
    } else if (process.platform !== 'darwin') {
      for (const isolation of modes) results.push({ isolation, probes: [], error: '当前只支持 macOS 的实测隔离方式' });
    } else {
      const temp = await realpath(await mkdtemp(join(paths().cache, 'selfcheck-')));
      await mkdir(deepseekHome(), { recursive: true, mode: 0o700 });
      const homeFiles: string[] = [];
      let keychain: KeychainItem | null = null;
      const leftovers: string[] = [];
      try {
        const stale = await sweepKeychainItems(run); if (stale) leftovers.push(stale);
        keychain = await addKeychainItem(run);
        const listening = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], temp, 5000);
        const port = listening.exit === 0 && !listening.timedOut && !listening.error ? Number(listening.output.match(/^n(?:127\.0\.0\.1|\*):(\d+)$/m)?.[1]) || null : null;
        const shared = await tempPaths(run, temp);
        // 硬链接探针的目标：放在自检目录本身（不在任何放开写的地方）。
        const linkTarget = join(temp, 'link-target'); await writeFile(linkTarget, 'xagents selfcheck', { mode: 0o600 });
        // 假变量：名字带 KEY、TOKEN，值是随机数。outer 放在探针进程继承的环境里；inner 只给 Codex，绕过外面那一层。
        const outer = 'XAGENTS_SELFCHECK_API_KEY', inner = 'XAGENTS_SELFCHECK_INNER_TOKEN';
        const inherited = { ...process.env, [outer]: randomUUID() };
        for (const isolation of modes) {
          const worktree = join(temp, isolation); await mkdir(worktree);
          const tmp = join(temp, `${isolation}-tmp`); await mkdir(tmp);
          const homeFile = join(homedir(), `.xagents-selfcheck-${randomUUID()}`); homeFiles.push(homeFile);
          const marker = `XAGENTS_PROBE_${randomUUID()}:`, script = join(worktree, 'probe.mjs'), token = `.xagents-selfcheck-${randomUUID()}`;
          await writeFile(script, probeSource(isolation, worktree, homeFile, port, marker, token, shared, tmp, linkTarget, keychain, isolation === 'codex' ? [outer, inner] : [outer]), { mode: 0o600 });
          const before = await globalBefore(homedir(), shared);
          let probes: Probe[] | null = null;
          try {
            const job = { who: whos.find(w => isolationOf(w) === isolation)!, mode: 'workspace-write', worktree, repo: temp } as Job;
            // 自检用派活时同样的额外禁读名单。
            const project = { denyReadExtra: [], denyReadHome: await extraDenyRead() };
            let r;
            if (isolation === 'codex') {
              r = await codexProbe(job, project, script, tmp, run, inherited, { [inner]: randomUUID() });
            } else {
              const settings = join(temp, `${isolation}.json`);
              await writeJson(settings, await sandbox(job, project, join(temp, `${isolation}-state`), tmp));
              // 和派活时一样：srt 拿到的环境先按 env.ts 去掉带密钥字样的变量。
              r = await run(process.execPath, [await srtPath(), '--settings', settings, process.execPath, script], worktree, 20000, undefined, exactEnv(workerEnv(inherited, { CLAUDE_CODE_TMPDIR: tmp }), inherited));
            }
            const lines = r.output.split('\n').filter(line => line.startsWith(marker));
            if (r.exit !== 0 || r.timedOut || r.signal || r.error || lines.length !== 1) throw new Error(r.error || (r.timedOut ? '探针超时' : `探针没有完整结果（退出码 ${r.exit}）`));
            const parsed = JSON.parse(lines[0].slice(marker.length));
            if (!Array.isArray(parsed)) throw new Error('探针结果格式无效');
            probes = parsed;
            results.push({ isolation, probes: parsed });
          } catch (e) { results.push({ isolation, probes: [], error: (e as Error).message }); }
          // 每种隔离跑完马上清，下一种隔离看到的“原来有没有”才准。
          const problems = await cleanGlobal(token, before, probes, homedir(), shared);
          if (problems.length) { const r = results.at(-1)!; r.error = [r.error, ...problems].filter(Boolean).join('；'); }
        }
      } finally {
        // 建没建成都扫一遍；删不掉就记进自检结果（自检不过），不悄悄留下。
        const left = await sweepKeychainItems(run).catch(e => `未能删除钥匙串里的自检测试条目：${(e as Error).message}`);
        if (left) leftovers.push(left);
        if (leftovers.length) { const r = results[0]; if (r) r.error = [r.error, ...leftovers].filter(Boolean).join('；'); }
        for (const file of homeFiles) await rm(file, { force: true }).catch(e => {
          const r = results[0];
          if (r) r.error = `${r.error ? r.error + '；' : ''}未能清理自检随机文件 ${file}：${e.code || '未知错误'}`;
        });
        await rm(temp, { recursive: true, force: true });
      }
    }
    const result = evaluate(results);
    await writeJson(join(paths().cache, 'selfcheck.json'), result);
    return result;
  });
}
export async function ensureSelfcheck(check = selfcheck) {
  let result = await readSelfcheck();
  if (result.ok === null) result = await check();
  if (result.ok !== true) throw new Error(`隔离自检没过，不能派活：${result.note}。请由负责人运行 xagents selfcheck。`);
}
