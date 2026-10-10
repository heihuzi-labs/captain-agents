import { nodeRunner, externalEnvironment } from './node-runtime.ts';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { jobDir, paths, toolRoot } from './paths.ts';
import { readOptional, withLock } from './fsx.ts';
import { StreamParser, LogTail } from './activity.ts';
import type { Job, Command } from './job.ts';
import type { Who } from './roster.ts';
import type { Project } from './project.ts';
import { checkCursorState, codexPermissions, cursorState, cursorStateDir, deepseekHome, jobTmpDir } from './sandbox.ts';
import { execute } from './verify.ts';
import type { Executor } from './verify.ts';
import { grokEnvironment } from './quota.ts';
import { codexEnvPolicy } from './env.ts';
import type { Isolated } from './sandbox.ts';
import { allowedEfforts, fastWhos, isWho, isolationOf, launchModel, spec, supportsFast, vendorOf, whos } from './roster.ts';
import type { Effort } from './roster.ts';

const effortNames: Record<Effort, string> = { medium: '中档', high: '高档', xhigh: '超高档' };
// --who 写法：选手:强度[:fast]。强度只开中档、高档、超高档，永远不拉满，也不开最低档；允许哪些由 roster 决定。
export function selection(value: string) {
  const [name, effort, fastWord, ...more] = value.split(':');
  if (!isWho(name)) throw new Error(`选手不存在，请选 ${whos.join('、')}。`);
  const who = name, s = spec(who), allowed = allowedEfforts(who);
  if (more.length) throw new Error('--who 最多三段：选手:强度[:fast]。请修改 --who。');
  if (!allowed.includes(effort as Effort)) throw new Error(`${who} 的推理强度只允许：${allowed.map(e => `${e}（${effortNames[e]}）`).join('、')}，写法是 选手:强度，例如 ${who}:${allowed[0]}。请修改 --who。`);
  if (fastWord !== undefined && fastWord !== 'fast') throw new Error(`${who} 的第三段只能写 fast（快速版），例如 ${fastWhos[0]}:${effort}:fast。请修改 --who。`);
  const fast = fastWord === 'fast';
  if (fast && !supportsFast(who)) throw new Error(`${who} 没有快速版：${s.noFast}。请去掉 :fast；有快速版的选手是 ${fastWhos.join('、')}。`);
  return { who, effort: effort as Effort, model: launchModel(who, effort as Effort, fast), ...(fast ? { fast: true as const } : {}) };
}
// DeepSeek 借 Codex 跑：Codex 文件夹换成派活工作台单独的那个（里面只有 DeepSeek 的登录），主人 ~/.codex 的 ChatGPT 登录不受影响。
// 钥匙由 Codex 主进程在隔离外读、只发给 DeepSeek；选手看不到带钥匙的环境变量（规则在 env.ts，所有选手都一样）。
// 依据 docs/research/connect-deepseek-2026-10-02.md。
export const DEEPSEEK_PROVIDER = 'model_providers.deepseek={name="DeepSeek",base_url="https://api.deepseek.com/",wire_api="responses",requires_openai_auth=true}';
// 登录只认 API 钥匙，并固定存成文件（不进系统钥匙串，免得和主人自己的 Codex 登录混在一处）；登录和派活用同一组。
const DEEPSEEK_LOGIN = ['-c', 'forced_login_method="api"', '-c', 'cli_auth_credentials_store="file"'];
// 这些变量在 Codex 里比登录文件优先（codex-cli 0.159 的认证顺序），带着就会把 OpenAI 的钥匙发给 DeepSeek；
// 后三个会让它改走“工作负载身份”登录，在只认 API 钥匙时直接报错、用不上 DeepSeek 的登录文件。
// 所以 DeepSeek 的 Codex 主进程启动前从继承的环境里去掉（登录、查登录、派活都一样），选手的命令也一并去掉。
// 名字带 KEY、TOKEN 的本来就会被 env.ts 去掉；后三个里有两个不带，所以这张表还要单独留着。
export const KEY_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'DEEPSEEK_API_KEY',
  'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT'];
const deepseekEnv = (): NodeJS.ProcessEnv => ({ CODEX_HOME: deepseekHome(), ...Object.fromEntries(KEY_VARS.map(name => [name, undefined])) });
function deepseekArgs(env: Record<string, string>) {
  env.CODEX_HOME = deepseekHome();
  return ['-c', 'model_provider="deepseek"', '-c', DEEPSEEK_PROVIDER, ...DEEPSEEK_LOGIN, '-c', 'web_search="disabled"'];
}
// 派 DeepSeek 活前在隔离外查一次登录；没登录就不派，提示主人自己登录（钥匙只有主人能拿到）。
export async function checkDeepseekLogin(run: Executor = execute) {
  await mkdir(deepseekHome(), { recursive: true, mode: 0o700 });
  const r = await run(codexPath(), ['login', 'status', ...DEEPSEEK_LOGIN], deepseekHome(), 20_000, undefined, deepseekEnv());
  if (r.exit !== 0 || r.timedOut || r.error || !/API key/i.test(r.output)) {
    throw new Error('DeepSeek 还没登录，这件没有派出。请主人在终端运行 xagents login deepseek，按提示粘贴 DeepSeek 的 API 钥匙。');
  }
}
// 主人自己登录 DeepSeek：钥匙从标准输入交给 Codex，由它存进 DeepSeek 的 Codex 文件夹；平台只转手，不存、不打印。
export async function loginDeepseek(key: string) {
  key = key.trim();
  if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) throw new Error('这不像 DeepSeek 的 API 钥匙（应以 sk- 开头），没有保存。');
  await mkdir(deepseekHome(), { recursive: true, mode: 0o700 });
  const ok = await new Promise<boolean>((done, fail) => {
    const child = spawn(codexPath(), ['login', '--with-api-key', ...DEEPSEEK_LOGIN], { cwd: deepseekHome(), env: { ...externalEnvironment(), ...deepseekEnv() }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', fail); child.once('close', code => done(code === 0));
    child.stdin.end(key + '\n');
  });
  if (!ok) throw new Error('Codex 没能保存 DeepSeek 的登录，请重试。');
  await checkDeepseekLogin();
}
export async function srtPath() {
  const path = resolve(process.env.XAGENTS_SRT || join(toolRoot, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js'));
  try { await access(path); }
  catch { throw new Error('找不到 srt。请先在工具目录安装 @anthropic-ai/sandbox-runtime，或把 XAGENTS_SRT 设为已有 dist/cli.js 的路径。'); }
  return path;
}
// Cursor 把登录令牌存在系统钥匙串里（cursor-agent 用 /usr/bin/security 读 cursor-user 的 cursor-access-token），
// 而钥匙串对选手一律读不到（sandbox.ts 的 keychainDirs）。所以由看管进程在隔离外读出，只放进这次 Cursor 进程的环境
// （CURSOR_AUTH_TOKEN），不写进任务记录和日志；AGENT_CLI_CREDENTIAL_STORE=memory 让它只在内存里记登录、不去写钥匙串。
// 这个令牌约两个月有效，普通登录时 Cursor 不会在干活中途换新，快到期就不派、请主人重新登录。依据 docs/research/keychain-2026-10-02.md。
export const securityPath = () => process.env.XAGENTS_SECURITY || '/usr/bin/security';
const CURSOR_MIN_SECONDS = 2 * 3600;
export async function cursorToken(run: Executor = execute, now = Date.now()) {
  const r = await run(securityPath(), ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'], homedir(), 10_000);
  const failed = r.timedOut || r.signal || r.error;
  if (r.exit === 44 && !failed) throw new Error('没在钥匙串里找到 Cursor 的登录。请主人在终端运行 cursor-agent login 登录 Cursor。');
  if (r.exit !== 0 || failed) throw new Error(`从钥匙串读 Cursor 的登录没成功（${r.timedOut ? '超时' : r.error ? '启动失败' : r.signal ? `被 ${r.signal} 停止` : `退出码 ${r.exit}`}），请稍后重试；一直这样请主人在终端运行 cursor-agent login。`);
  const token = r.output.trim();
  if (!/^[\w.-]+$/.test(token)) throw new Error('钥匙串里 Cursor 的登录格式不对。请主人在终端运行 cursor-agent login 重新登录。');
  const exp = jwtExpiry(token);
  if (exp !== null && exp * 1000 - now < CURSOR_MIN_SECONDS * 1000) throw new Error('Cursor 的登录剩不到 2 小时就过期了。请主人在终端运行 cursor-agent login 重新登录。');
  return token;
}
function jwtExpiry(token: string): number | null {
  try { const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp; return Number.isFinite(exp) ? exp : null; }
  catch { return null; }
}
// 派 Cursor 活前在隔离外先查一次登录（只查，不留令牌）；没登录或快过期就不派。
export async function checkCursorLogin(run: Executor = execute) {
  try { await cursorToken(run); }
  catch (e) { throw new Error(`这件没有派出：${(e as Error).message}`); }
}
// 本机 Codex 不在 PATH 上，派活和查模型用同一个取路径的地方；XAGENTS_CODEX 可覆盖。
export const codexPath = () => process.env.XAGENTS_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
// runtime：这一轮运行包的目录（run-package.ts）；srt 的设置文件和联网小程序都从包里取。
export async function command(job: Job, text: string, project: Isolated, runtime?: string): Promise<Command> {
  const dir = jobDir(job.id), env: Record<string, string> = {}, tmp = jobTmpDir(job);
  const network = job.network === true;
  const unset = [...(vendorOf(job.who) === 'deepseek' ? KEY_VARS : []), ...(network ? ['NODE_USE_SYSTEM_CA'] : [])];
  // 联网任务避免读取系统钥匙串，npm 缓存只写任务专用临时目录（负责人隔离实测）。
  if (network) env.npm_config_cache = join(tmp, 'npm-cache');
  let file: string, args: string[];
  // 每件活一个专用临时目录，选手只能写它（见 sandbox.ts 的 jobTmpDir）。
  await mkdir(tmp, { recursive: true });
  if (isolationOf(job.who) === 'codex') {
    // Codex 的 :workspace 放开的是 $TMPDIR，所以把它指到任务的 tmp。
    env.TMPDIR = tmp;
    file = codexPath();
    const deepseek = vendorOf(job.who) === 'deepseek';
    const disable = ['plugins', 'apps', 'remote_plugin', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'hooks', 'memories'];
    args = ['exec', '--ignore-user-config', ...disable.flatMap(n => ['--disable', n]), ...(deepseek ? deepseekArgs(env) : []), '-c', codexEnvPolicy(deepseek ? KEY_VARS : []), '-m', job.model, '-c', `model_reasoning_effort="${job.effort}"`, '-c', 'default_permissions="xa"', '-c', codexPermissions(job, project, tmp, network), '-C', job.worktree, '--json', '-o', join(dir, 'final.md'), '-'];
  } else {
    file = nodeRunner().file;
    // 替身模式仍传入完整参数；无需安装或执行真正的 srt。
    const srt = process.env.XAGENTS_FAKE_WORKER ? resolve(process.env.XAGENTS_SRT || join(toolRoot, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js')) : await srtPath();
    args = [...(network ? [join(runtime ?? join(dir, 'runtime'), 'src/core/srt-open.ts')] : []), srt, '--settings', join(runtime ?? dir, 'sandbox.json')];
    // srt 用 CLAUDE_CODE_TMPDIR 给选手设 TMPDIR；不设就是公用的 /tmp/claude（模板里已禁写）。
    env.CLAUDE_CODE_TMPDIR = tmp;
    if (isolationOf(job.who) === 'grok') {
      Object.assign(env, grokEnvironment());
      // 不读写主人的记忆，不自动更新（~/.grok 对选手只读，更新也写不进去）。
      env.GROK_MEMORY = '0'; env.GROK_DISABLE_AUTOUPDATER = '1';
      args.push('grok', '--prompt-file', join(dir, 'prompt.md'), '--cwd', job.worktree, '-m', job.model, '--effort', job.effort, '--sandbox', 'off', '--always-approve', '--output-format', 'streaming-json');
    } else {
      // 替身不是 cursor-agent，不受它的路径长度限制（测试的临时登记处路径很长）。
      const state = cursorState(process.env.XAGENTS_FAKE_WORKER ? cursorStateDir(job) : checkCursorState(cursorStateDir(job)));
      await mkdir(state.config, { recursive: true }); await mkdir(state.data, { recursive: true });
      env.CURSOR_CONFIG_DIR = state.config; env.CURSOR_DATA_DIR = state.data;
      // 登录由看管进程启动前现取（见 cursorToken），Cursor 只在内存里记，不碰钥匙串。
      env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
      args.push('cursor-agent', '-p', '--output-format', 'stream-json', '--model', job.model, '--force', '--trust', ...(job.mode === 'read-only' ? ['--mode', 'ask'] : []), '--workspace', job.worktree, text);
    }
  }
  if (process.env.XAGENTS_FAKE_WORKER) {
    await access(resolve(process.env.XAGENTS_FAKE_WORKER));
    file = nodeRunner().file;
    args = [resolve(process.env.XAGENTS_FAKE_WORKER), ...args];
  }
  return { file, args, env, ...(unset.length ? { unset } : {}), ...(isolationOf(job.who) === 'cursor' ? { login: 'cursor' as const } : {}), stdin: isolationOf(job.who) === 'codex' ? 'prompt' : 'ignore', output: 'run.log' };
}
// Grok 的登录每 6 小时换一次新令牌、旧令牌作废；写回 ~/.grok/auth.json 要在 ~/.grok 里新建临时文件，选手隔离里做不到。
// 所以派 Grok 活前先在隔离外刷新：剩不到 5 小时就换新，选手干活期间用不着自己刷新（跑着的选手会直接用磁盘上的新令牌）。
// 几个派活进程排队刷新；刷新失败就不派这件，免得选手很快在隔离里刷新、写不回去。不记输出，里面可能有账号信息。
export async function refreshGrokLogin(run: Executor = execute) {
  await mkdir(paths().cache, { recursive: true });
  // 每次刷新最多 30 秒；同时派几件时排队，最多等 2 分钟。
  const r = await withLock(join(paths().cache, 'grok-login-refresh'), () =>
    run('grok', ['models'], paths().cache, 30000, undefined, { ...grokEnvironment(), GROK_AUTH_EARLY_INVALIDATION_SECS: '18000' }), 120_000);
  if (r.exit !== 0 || r.timedOut || r.signal || r.error) {
    throw new Error(`派活前刷新 Grok 登录没成功（${r.timedOut ? '超时' : r.error ? '启动失败' : `退出码 ${r.exit}`}），这件没有派出。请在终端运行 grok models 看登录是否正常，需要时请主人重新登录。`);
  }
}
export function parseResult(who: Who, raw: string, final = '', worktree = '') {
  const parser = new StreamParser(who, worktree);
  parser.feed(raw); parser.finish();
  return parser.result(final);
}
export async function result(job: Job) {
  const parser = new StreamParser(job.who, job.worktree);
  await new LogTail().read(join(jobDir(job.id), 'run.log'), parser);
  parser.finish();
  return parser.result(await readOptional(join(jobDir(job.id), 'final.md')));
}
// 续接（群与小队共用）：准备阶段先按当前平台生成完整运行包，并确认旧约束没有减少；
// 这里仅在这一轮新生成的 command 上改续接参数，不负责生成隔离规则。
// Codex：codex exec resume <其余参数> <会话号> -（exec resume 不认 -C，去掉它；看管进程本来就在副本目录里启动）。
// Grok：在 --prompt-file 前加 --resume <会话号>，提示词换成这一轮的文件。Cursor 还没实测续接，不支持。
export const SESSION_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
export const RESUME_PROMPT_RE = /^prompt-r([2-9]|[1-9][0-9])\.md$/;
export function resumeCommand(job: Pick<Job, 'id' | 'who' | 'command' | 'session' | 'resume'>): Command {
  const cmd = job.command;
  if (!cmd) throw new Error('没有保存第 1 轮的选手命令，没法续接。');
  if (!job.session || !SESSION_RE.test(job.session)) throw new Error('没有取到这位选手的会话号，没法续接。');
  if (!job.resume || !RESUME_PROMPT_RE.test(job.resume.prompt)) throw new Error('续接的提示词文件名不对。');
  const args = [...cmd.args], prompt = join(jobDir(job.id), job.resume.prompt);
  const isolation = isolationOf(job.who);
  if (isolation === 'codex') {
    const exec = args.indexOf('exec');
    if (exec < 0 || args.at(-1) !== '-' || args[exec + 1] === 'resume') throw new Error('第 1 轮的 Codex 命令不是预期的样子，没法续接。');
    const opts = args.slice(exec + 1, -1), c = opts.indexOf('-C');
    if (c >= 0) opts.splice(c, 2);
    return { ...cmd, args: [...args.slice(0, exec), 'exec', 'resume', ...opts, job.session, '-'] };
  }
  if (isolation === 'grok') {
    const p = args.indexOf('--prompt-file');
    if (p < 0 || args.includes('--resume')) throw new Error('第 1 轮的 Grok 命令不是预期的样子，没法续接。');
    args[p + 1] = prompt;
    args.splice(p, 0, '--resume', job.session);
    return { ...cmd, args };
  }
  throw new Error('Cursor 还没实测续接，暂时不能当搭档。');
}
