// 探针：用户的 Codex 接的是自定义接口时，平台现在的启动参数派不派得出去；把“连哪个接口”那一段带进启动参数以后行不行，
// 原来挡住的（用户配置里会在隔离外执行的东西、隔离本身、密钥变量）是不是还都挡着。依据 docs/design-scan.md 第 5 节。
// 全程用本机起的假模型接口、空的临时 Codex 文件夹和一把假钥匙：不碰真实的登录，不连真的接口。
// 用法：node scripts/probe/codex-endpoint.mjs <codex 可执行文件> <结果文件>
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url), windows = process.platform === 'win32';
const MARK = 'XA_PROBE ';

// ---------- 在隔离里跑的那一半 ----------
if (process.argv[2] === '--inner') {
  const spec = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
  const write = async file => { try { await fs.writeFile(file, 'probe'); return 'allowed'; } catch (e) { return `denied:${e.code}`; } };
  const connect = (host, port) => new Promise(done => {
    const socket = net.connect({ host, port, timeout: 4000 });
    socket.on('connect', () => { socket.destroy(); done('allowed'); });
    socket.on('timeout', () => { socket.destroy(); done('denied:timeout'); });
    socket.on('error', e => done(`denied:${e.code}`));
  });
  const secretNames = Object.keys(process.env).filter(name => /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE/i.test(name));
  console.log(MARK + JSON.stringify({ inside: await write(path.join(process.cwd(), 'inner.txt')), tmp: await write(path.join(spec.tmp, 'inner.txt')),
    home: await write(spec.homeFile), internet: await connect('1.1.1.1', 443), local: await connect('127.0.0.1', spec.port), secretNames,
    seen: (spec.watch ?? []).filter(name => name in process.env) }));
  process.exit(0);
}
// 用户配置里的两种“会在隔离外执行程序”的东西都指到这里：被执行了就留下记号。
if (process.argv[2] === '--trap') { await fs.writeFile(process.argv[3], 'ran'); process.exit(0); }

// ---------- 在外面跑的那一半 ----------
const [codex, resultFile] = process.argv.slice(2);
if (!codex || !resultFile) { console.error('用法：codex-endpoint.mjs <codex 可执行文件> <结果文件>'); process.exit(1); }

const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xa-endpoint-')));
process.env.XAGENTS_HOME = path.join(base, 'registry');
const { codexPermissions } = await import('../../src/core/sandbox.ts');
const { codexEnvPolicy, workerEnv } = await import('../../src/core/env.ts');

const codexHome = path.join(base, 'codex-home'), worktree = path.join(base, 'worktree'), tmp = path.join(base, 'job-tmp');
const homeFile = path.join(os.homedir(), `.xa-endpoint-probe-${randomUUID()}`);
const marks = { notify: path.join(base, 'mark-notify'), mcp: path.join(base, 'mark-mcp') };
const fakeKey = `sk-probe-${randomUUID()}`, envKey = `sk-env-${randomUUID()}`;
for (const dir of [codexHome, worktree, tmp]) await fs.mkdir(dir, { recursive: true });

function run(file, args, { cwd = worktree, env, input = '', timeout = 90_000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now(), child = spawn(file, args, { cwd, env, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ exit: null, error: e.message, stdout, stderr, ms: Date.now() - started }); });
    child.on('close', exit => { clearTimeout(timer); resolve({ exit, timedOut, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const tail = (text, n = 600) => text.length > n ? '…' + text.slice(-n) : text;

// 假模型接口：只认 Responses 协议。第一问按这一轮的要求回“请跑这条命令”或直接回一句话；带着命令结果的第二问回一句话收尾。
let requests = [], wantTool = false, port = 0;
const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
const quote = value => windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
const specFile = path.join(base, 'inner-spec.json');
const innerArgv = [process.execPath, self, '--inner', specFile];
const innerLine = (windows ? '& ' : '') + innerArgv.map(quote).join(' ');
// 工具清单在哪、命令怎么调，各版 Codex 不一样：老的放在请求的 tools 里（exec_command、shell 等）；
// 0.162 起放在输入里的 additional_tools 项，跑命令要经一个叫 exec 的“写一段脚本”工具，脚本里再调 tools.exec_command。
const flatten = tools => tools.flatMap(t => t.type === 'namespace' ? flatten(t.tools ?? []) : [t]);
const toolsOf = body => flatten([...(body?.tools ?? []), ...(Array.isArray(body?.input) ? body.input : []).filter(i => i?.type === 'additional_tools').flatMap(i => i.tools ?? [])]);
function toolCall(tools) {
  const names = tools.map(t => t.name ?? t.type), call_id = 'call_probe';
  if (tools.some(t => t.type === 'custom' && t.name === 'exec')) return { type: 'custom_tool_call', call_id, name: 'exec',
    input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(innerLine)} });\ntext(typeof r === "string" ? r : JSON.stringify(r));` };
  if (names.includes('exec_command')) return { type: 'function_call', call_id, name: 'exec_command', arguments: JSON.stringify({ cmd: innerLine }) };
  if (names.includes('shell_command')) return { type: 'function_call', call_id, name: 'shell_command', arguments: JSON.stringify({ command: innerLine }) };
  if (names.includes('shell')) return { type: 'function_call', call_id, name: 'shell', arguments: JSON.stringify({ command: innerArgv }) };
  if (names.includes('local_shell')) return { type: 'local_shell_call', call_id, status: 'completed', action: { type: 'exec', command: innerArgv } };
  return null;
}
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { /* 不是 JSON 的请求只记路径 */ }
    const input = Array.isArray(body?.input) ? body.input : [];
    const outputs = input.filter(i => typeof i?.type === 'string' && i.type.endsWith('call_output'));
    const entry = { method: req.method, path: req.url, auth: req.headers.authorization ?? null, model: body?.model ?? null,

      tools: toolsOf(body).map(t => t.name ?? t.type), outputs: outputs.map(o => typeof o.output === 'string' ? o.output : JSON.stringify(o.output)) };
    requests.push(entry);
    if (req.method !== 'POST' || !req.url.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"probe: not found"}}'); return; }
    const call = wantTool && !outputs.length ? toolCall(toolsOf(body)) : null;
    entry.replied = call ? `tool:${call.name ?? call.type}` : 'message';
    const item = call ?? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'probe done' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { id: 'resp_probe' } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: 'resp_probe', usage } }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// watch：两个名字里不带密钥字样的变量。一个是配置里点名放钥匙的（启动参数里明写不给命令），一个什么都不做（对照，命令应当看得到）。
const HANDLE = 'XA_PROBE_RELAY_HANDLE', PLAIN = 'XA_PROBE_PLAIN';
await fs.writeFile(specFile, JSON.stringify({ tmp, homeFile, port, watch: [HANDLE, PLAIN] }));

// 用户的 Codex 配置：接自定义接口，另带两样会在隔离外执行程序的东西（任务结束时的通知程序、一个外部连接）。
const toml = value => JSON.stringify(value);
const provider = (extra = 'requires_openai_auth=true') => `model_providers.probe={name="Probe",base_url=${toml(baseUrl)},wire_api="responses",${extra}}`;
await fs.writeFile(path.join(codexHome, 'config.toml'), [
  'model_provider = "probe"',
  `notify = [${[process.execPath, self, '--trap', marks.notify].map(toml).join(', ')}]`,
  '', '[model_providers.probe]', 'name = "Probe"', `base_url = ${toml(baseUrl)}`, 'wire_api = "responses"', 'requires_openai_auth = true',
  '', '[mcp_servers.trap]', `command = ${toml(process.execPath)}`, `args = [${[self, '--trap', marks.mcp].map(toml).join(', ')}]`, ''].join('\n'));

const job = { mode: 'workspace-write', repo: worktree, worktree, id: 'probe' };
const permissions = codexPermissions(job, { denyReadExtra: [] }, tmp, false);
const sandboxFlag = windows ? ['-c', 'windows.sandbox="elevated"'] : [];
// 和 src/core/workers.ts 里派 Codex 活的参数一字不差（探针另加的只有 extra）。
const disable = ['plugins', 'apps', 'remote_plugin', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'hooks', 'memories'];
const platformArgs = (extra = [], hidden = []) => ['exec', '--ignore-user-config', ...sandboxFlag, ...disable.flatMap(n => ['--disable', n]), ...extra,
  '-c', codexEnvPolicy(hidden), '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="medium"', '-c', 'default_permissions="xa"', '-c', permissions,
  '-C', worktree, '--json', '-o', path.join(base, 'final.md'), '-'];
// 对照：读用户配置、什么都不关。用来证明上面那两个记号在配置生效时确实会出现。
const controlArgs = ['exec', ...sandboxFlag, '-c', codexEnvPolicy(), '-m', 'gpt-6-astra', '-c', 'default_permissions="xa"', '-c', permissions,
  '-C', worktree, '--json', '-o', path.join(base, 'final.md'), '-'];
const tmpVars = { TMPDIR: tmp, ...(windows ? { TEMP: tmp, TMP: tmp } : {}), CODEX_HOME: codexHome };
// 平台给选手进程的环境：名字带 KEY 等字样的变量都滤掉。
const platformEnv = (inherited = process.env) => workerEnv(inherited, tmpVars);

const result = { at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, os: os.release(), cases: {} };
const exists = file => fs.stat(file).then(() => true, () => false);
async function probeCase(name, args, env, tool) {
  requests = []; wantTool = tool;
  for (const file of [...Object.values(marks), homeFile, path.join(base, 'final.md'), path.join(worktree, 'inner.txt'), path.join(tmp, 'inner.txt')]) await fs.rm(file, { force: true });
  const r = await run(codex, args, { env, input: '请运行一条命令，然后说 done。' });
  await new Promise(done => setTimeout(done, 1500)); // 通知程序是任务收尾时才起的，等它落盘。
  // 命令的输出被一层层转义后带回第二问：去掉反斜杠再取出那一行 JSON（里面没有嵌套的花括号）。
  const found = /XA_PROBE (\{[^{}]*\})/.exec(requests.flatMap(q => q.outputs).join('\n').replaceAll('\\', ''));
  const inner = found ? JSON.parse(found[1]) : null;
  const posts = requests.filter(q => q.path.includes('/responses'));
  const entry = { exit: r.exit, timedOut: r.timedOut ?? false, ms: r.ms, requests: requests.map(q => `${q.method} ${q.path} → ${q.replied ?? '404'}`),
    arrived: posts.length, auth: [...new Set(posts.map(q => q.auth === `Bearer ${fakeKey}` ? '假钥匙（登录文件里的）' : q.auth === `Bearer ${envKey}` ? '假钥匙（环境变量里的）' : q.auth ? '别的值' : '没带'))],
    tools: posts[0]?.tools ?? [], final: await fs.readFile(path.join(base, 'final.md'), 'utf8').catch(() => null), inner,
    notifyRan: await exists(marks.notify), mcpRan: await exists(marks.mcp), homeFileLeft: await exists(homeFile), stderr: tail(r.stderr), stdout: tail(r.stdout, 300) };
  result.cases[name] = entry;
  console.log(`[${name}] 退出码 ${entry.exit}${entry.timedOut ? '（超时）' : ''}，到假接口 ${entry.arrived} 次，钥匙 ${entry.auth.join('、') || '—'}，通知程序${entry.notifyRan ? '被执行了' : '没执行'}，外部连接${entry.mcpRan ? '被执行了' : '没执行'}，隔离里 ${JSON.stringify(inner)}`);
}

try {
  await run('git', ['init', '-q', '-b', 'main'], { env: process.env });
  // 假钥匙存进临时 Codex 文件夹的登录文件（明写存成文件，不进系统钥匙串）。
  const login = await run(codex, ['login', '--with-api-key', '-c', 'cli_auth_credentials_store="file"'], { env: { ...platformEnv(), CODEX_HOME: codexHome }, input: fakeKey + '\n' });
  result.login = { exit: login.exit, stderr: tail(login.stderr, 200), files: await fs.readdir(codexHome) };
  const status = await run(codex, ['login', 'status'], { env: platformEnv() });
  result.loginStatus = { exit: status.exit, text: (status.stdout + status.stderr).replaceAll(fakeKey, '<假钥匙>').trim() };
  console.log(`[登录] 退出码 ${login.exit}；login status：${result.loginStatus.text}`);
  if (windows) {
    const setup = await run(codex, ['sandbox', 'setup', '--elevated', '--current-user'], { env: platformEnv(), timeout: 300_000 });
    result.sandboxSetup = { exit: setup.exit, stderr: tail(setup.stderr, 300) };
    console.log(`[装隔离] 退出码 ${setup.exit}`);
  }

  await probeCase('现在的启动参数', platformArgs(), platformEnv(), true);
  await probeCase('带上接口那一段', platformArgs(['-c', 'model_provider="probe"', '-c', provider()]), platformEnv(), true);
  await probeCase('对照：读用户配置', controlArgs, platformEnv(), true);
  await probeCase('只带 openai_base_url', platformArgs(['-c', `openai_base_url=${toml(baseUrl)}`]), platformEnv(), false);
  const envProvider = ['-c', 'model_provider="probe"', '-c', provider('env_key="XA_PROBE_RELAY_KEY"')];
  await probeCase('钥匙在环境变量：不过滤', platformArgs(envProvider), { ...platformEnv(), XA_PROBE_RELAY_KEY: envKey }, true);
  await probeCase('钥匙在环境变量：按平台过滤', platformArgs(envProvider), platformEnv({ ...process.env, XA_PROBE_RELAY_KEY: envKey }), false);
  // 变量名里不带密钥字样时，靠的只有启动参数里点名的那一条：命令里必须看不到它，对照的那个必须看得到。
  const handleProvider = ['-c', 'model_provider="probe"', '-c', provider(`env_key="${HANDLE}"`)];
  await probeCase('钥匙变量的名字不带密钥字样：点名不给命令', platformArgs(handleProvider, [HANDLE]), { ...platformEnv(), [HANDLE]: envKey, [PLAIN]: 'plain' }, true);

  requests = []; wantTool = false;
  const models = await run(codex, ['debug', 'models', '-c', 'model_provider="probe"', '-c', provider()], { env: platformEnv() });
  result.debugModels = { exit: models.exit, askedEndpoint: requests.map(q => `${q.method} ${q.path}`), listed: (() => { try { return JSON.parse(models.stdout).models?.length ?? null; } catch { return null; } })() };
  console.log(`[debug models 带自定义接口] 退出码 ${models.exit}，问了假接口：${result.debugModels.askedEndpoint.join('、') || '没有'}，列出 ${result.debugModels.listed} 个`);
} finally {
  server.close();
  await fs.rm(homeFile, { force: true });
  await fs.mkdir(path.dirname(path.resolve(resultFile)), { recursive: true });
  await fs.writeFile(resultFile, JSON.stringify(result, null, 2));
  await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
