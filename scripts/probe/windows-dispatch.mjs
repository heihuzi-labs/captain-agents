// 端到端：在一台什么都没装加固的机器上，用平台自己的命令真的派一件活，看它做完没有（docs/design-windows.md 第 12 节）。
// 模型是本机起的假接口（只认 Responses 协议），钥匙是假的，登记处和 Codex 文件夹都是临时的：不碰真实的登录，不连真的接口。
// 假模型让选手在副本里写一个文件，再说一句话收尾；所以“活做完了、文件在副本里”就说明：选手列得出来、接口那一段带上了、
// 派活没被自检拦住、Codex 自带的隔离里命令跑得起来而且写得进副本。
// 用法：node scripts/probe/windows-dispatch.mjs <结果文件> -- <启动 xagents 的命令和参数…>
//   从源码跑：… -- node src/cli/cli.ts        装好的应用：… -- <应用的程序> <应用里的 platform/bin/xagents>（环境里设 ELECTRON_RUN_AS_NODE=1）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const split = process.argv.indexOf('--');
// 命令里写的相对路径（比如 src/cli/cli.ts）按现在的目录补成完整的：后面的命令是在临时仓库里跑的。
const resultFile = process.argv[2] && path.resolve(process.argv[2]), xagents = (split < 0 ? [] : process.argv.slice(split + 1)).map((v, i) => i > 0 && existsSync(v) ? path.resolve(v) : v);
if (!resultFile || !xagents.length) { console.error('用法：windows-dispatch.mjs <结果文件> -- <启动 xagents 的命令和参数…>'); process.exit(2); }
const windows = process.platform === 'win32';
const codex = process.env.XAGENTS_CODEX || (windows ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xa-dispatch-')));
const registry = path.join(base, 'registry'), codexHome = path.join(base, 'codex-home'), repo = path.join(base, 'repo');
for (const dir of [registry, codexHome, repo]) await fs.mkdir(dir, { recursive: true });
const env = { ...process.env, XAGENTS_HOME: registry, CODEX_HOME: codexHome };
delete env.XAGENTS_FAKE_WORKER;

function run(file, args, { cwd = repo, input = '', timeout = 240_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    let out = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ exit: null, out: out + e.message, timedOut }); });
    child.on('close', exit => { clearTimeout(timer); resolve({ exit, out, timedOut }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const cli = (...args) => run(xagents[0], [...xagents.slice(1), ...args]);

// 假模型：第一问叫选手跑一条命令（在当前目录写一个文件），带着结果的第二问回一句话。两种工具写法都认（见 codex-endpoint.mjs）。
const WRITE = 'echo dispatched > dispatched.txt';
const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
const flatten = tools => tools.flatMap(t => t.type === 'namespace' ? flatten(t.tools ?? []) : [t]);
let asked = 0, toolOutput = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"not found"}}'); return; }
    asked++;
    let body = {}; try { body = JSON.parse(raw); } catch { /* 按没有工具处理 */ }
    const input = Array.isArray(body.input) ? body.input : [];
    const tools = flatten([...(body.tools ?? []), ...input.filter(i => i?.type === 'additional_tools').flatMap(i => i.tools ?? [])]);
    const outputs = input.filter(i => typeof i?.type === 'string' && i.type.endsWith('call_output'));
    const answered = outputs.length > 0;
    // 命令在隔离里跑出来的结果（或隔离拒绝它时的报错），原样记下来。
    if (answered) toolOutput = outputs.map(o => typeof o.output === 'string' ? o.output : JSON.stringify(o.output)).join('\n').slice(0, 900);
    let item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '写好了。' }] };
    if (!answered) {
      if (tools.some(t => t.type === 'custom' && t.name === 'exec')) item = { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(WRITE)} });\ntext(typeof r === "string" ? r : JSON.stringify(r));` };
      else if (tools.some(t => t.name === 'exec_command')) item = { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: WRITE }) };
      else if (tools.some(t => t.name === 'shell_command')) item = { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: JSON.stringify({ command: WRITE }) };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: 'r', usage } }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const result = { at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, via: xagents.map(v => path.basename(v)).join(' '), steps: {} };
let ok = false;
try {
  // “主人的 Codex”：接的是自定义接口（就是上面的假接口），钥匙交给 Codex 自己保管。
  await fs.writeFile(path.join(codexHome, 'config.toml'), `model_provider = "probe"\n\n[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`);
  // 主人的电脑上常见的一种状态：加固装过（管理员装一次的那种隔离已经给这个 Codex 文件夹装上了），但自检没通过，所以派活走的仍是“没装加固”的那一路。
  if (windows && process.env.XA_DISPATCH_AFTER_SETUP) result.steps.setup = (await run(codex, ['sandbox', 'setup', '--elevated', '--current-user'], { timeout: 300_000 })).exit;
  const login = await run(codex, ['login', '--with-api-key', '-c', 'cli_auth_credentials_store="file"'], { input: 'sk-probe-not-a-real-key\n' });
  result.steps.login = login.exit;
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']]) await run('git', args);
  const task = path.join(base, 'task.md');
  await fs.writeFile(task, '在当前目录写一个叫 dispatched.txt 的文件，然后说“写好了”。\n');
  const added = await cli('project', 'add', 'probe', repo, '--label', '试一试');
  result.steps.projectAdd = { exit: added.exit, tail: added.out.trim().split(/\r?\n/).slice(-2).join(' | ') };
  const workers = await cli('workers');
  result.steps.workers = workers.out.trim().split(/\r?\n/).filter(l => /Codex|DeepSeek|Grok|Cursor|没找到|不能派/.test(l)).map(l => l.trim().slice(0, 90));
  const sent = await cli('run', task, '--project', 'probe', '--who', 'codex:medium', '--title', '写一个文件', '--summary', '端到端检查：派一件活，看它在隔离里把文件写进副本');
  const id = /^(\d{4}-\d{4}-\S+)/m.exec(sent.out)?.[1];
  result.steps.run = { exit: sent.exit, id: id ?? null, out: sent.out.trim().slice(-600) };
  if (id) {
    const waited = await cli('wait', id);
    const job = JSON.parse(await fs.readFile(path.join(registry, 'jobs', id, 'job.json'), 'utf8'));
    const written = await fs.stat(path.join(job.worktree, 'dispatched.txt')).then(() => true, () => false);
    const args = job.command?.args ?? [];
    result.steps.job = { waitExit: waited.exit, state: job.state, error: job.error ?? null, written, asked, toolOutput,
      sandbox: args.find(a => a.startsWith('windows.sandbox=')) ?? null, endpoint: args.includes('model_provider="probe"'),
      denyRead: args.some(a => a.startsWith('permissions.xa=') && a.includes('"deny"')) };
    if (job.state !== 'done' || !written) for (const name of ['stderr.log', 'supervisor.log', 'run.log']) result.steps[name] = (await fs.readFile(path.join(registry, 'jobs', id, name), 'utf8').catch(() => '')).slice(-800);
    ok = job.state === 'done' && written;
    await cli('stop', id); await cli('clean', id);
  }
} catch (error) { result.error = String(error?.stack ?? error); }
finally {
  server.close();
  result.ok = ok;
  await fs.mkdir(path.dirname(path.resolve(resultFile)), { recursive: true });
  await fs.writeFile(resultFile, JSON.stringify(result, null, 2));
  await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
console.log(ok ? '通过：活派出去了，在隔离里做完了，文件写进了副本。' : '没过：活没有做完，看上面的结果。');
process.exit(ok ? 0 : 1);
