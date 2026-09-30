import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { jobDir, paths, toolRoot } from './paths.ts';
import { readOptional, withLock } from './fsx.ts';
import { StreamParser, LogTail } from './activity.ts';
import type { Job, Command } from './job.ts';
import type { Who } from './roster.ts';
import type { Project } from './project.ts';
import { checkCursorState, codexPermissions, cursorState, cursorStateDir, jobTmpDir } from './sandbox.ts';
import { execute } from './verify.ts';
import type { Executor } from './verify.ts';
import { grokEnvironment } from './quota.ts';
import type { Isolated } from './sandbox.ts';
import { allowedEfforts, fastWhos, isWho, isolationOf, launchModel, spec, supportsFast, whos } from './roster.ts';
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
export async function srtPath() {
  const path = resolve(process.env.XAGENTS_SRT || join(toolRoot, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js'));
  try { await access(path); }
  catch { throw new Error('找不到 srt。请先在工具目录安装 @anthropic-ai/sandbox-runtime，或把 XAGENTS_SRT 设为已有 dist/cli.js 的路径。'); }
  return path;
}
// 本机 Codex 不在 PATH 上，派活和查模型用同一个取路径的地方；XAGENTS_CODEX 可覆盖。
export const codexPath = () => process.env.XAGENTS_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export async function command(job: Job, text: string, project: Isolated): Promise<Command> {
  const dir = jobDir(job.id), env: Record<string, string> = {}, tmp = jobTmpDir(job);
  let file: string, args: string[];
  // 每件活一个专用临时目录，选手只能写它（见 sandbox.ts 的 jobTmpDir）。
  await mkdir(tmp, { recursive: true });
  if (isolationOf(job.who) === 'codex') {
    // Codex 的 :workspace 放开的是 $TMPDIR，所以把它指到任务的 tmp。
    env.TMPDIR = tmp;
    file = codexPath();
    const disable = ['plugins', 'apps', 'remote_plugin', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'hooks', 'memories'];
    args = ['exec', '--ignore-user-config', ...disable.flatMap(n => ['--disable', n]), '-m', job.model, '-c', `model_reasoning_effort="${job.effort}"`, '-c', 'default_permissions="xa"', '-c', codexPermissions(job, project), '-C', job.worktree, '--json', '-o', join(dir, 'final.md'), '-'];
  } else {
    file = process.execPath;
    // 替身模式仍传入完整参数；无需安装或执行真正的 srt。
    const srt = process.env.XAGENTS_FAKE_WORKER ? resolve(process.env.XAGENTS_SRT || join(toolRoot, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js')) : await srtPath();
    args = [srt, '--settings', join(dir, 'sandbox.json')];
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
      args.push('cursor-agent', '-p', '--output-format', 'stream-json', '--model', job.model, '--force', '--trust', ...(job.mode === 'read-only' ? ['--mode', 'ask'] : []), '--workspace', job.worktree, text);
    }
  }
  if (process.env.XAGENTS_FAKE_WORKER) {
    await access(resolve(process.env.XAGENTS_FAKE_WORKER));
    file = process.execPath;
    args = [resolve(process.env.XAGENTS_FAKE_WORKER), ...args];
  }
  return { file, args, env, stdin: isolationOf(job.who) === 'codex' ? 'prompt' : 'ignore', output: 'run.log' };
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
