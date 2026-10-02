import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { paths, toolRoot, unpackedPath } from './paths.ts';
import { readJson, writeJson, hasCode } from './fsx.ts';
import type { Who } from './job.ts';
import { isolationOf, isolations, spec, vendorOf } from './roster.ts';
import { cursorState } from './sandbox.ts';
import { LIMIT_CAPS } from './settings.ts';

import type { Isolation } from './roster.ts';
export type Provider = Isolation;
export type QuotaBar = { label: string; used: number | null; approx?: boolean; reset: string | null; windowMinutes?: number };
export type QuotaEntry = { name: string; icon: Provider; plan: string | null; bars: QuotaBar[]; at: string | null; error?: string; reached?: string; onDemand?: string };
export type QuotaSnapshot = { queriedAt: string; providers: QuotaEntry[] };
export type QuotaSnapshots = { quota_before?: QuotaSnapshot | null; quota_after?: QuotaSnapshot | null };
export type QueryCommand = {
  file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  input?: string; writes?: { afterMs: number; text: string }[]; complete?: (output: string) => boolean;
  // 请求退出后等多久再整组强杀（缺省 300 毫秒）。经伪终端桥启动的要比桥自己的收尾宽限（pty-bridge.py 的 GRACE）长。
  graceMs?: number;
};
export type QueryExecutor = (command: QueryCommand) => Promise<string>;

// 查询也回收整个进程组，避免 script 留下交互选手；执行器可整组替换供离线测试使用。
export const executeQuery: QueryExecutor = command => new Promise((resolve, reject) => {
  if (process.env.XAGENTS_FAKE_WORKER && !process.env.XAGENTS_QUERY_EXEC) {
    reject(new Error('测试替身未提供查询结果')); return;
  }
  const replacement = process.env.XAGENTS_QUERY_EXEC;
  const child = spawn(replacement ? process.execPath : command.file,
    replacement ? [replacement, command.file, ...command.args] : command.args,
    { cwd: command.cwd, env: { ...process.env, ...command.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', settled = false, completed = false, failure: Error | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    // 已拿到完整结果后只是收尾：程序刚好退出、还没被收走时，macOS 对整组发信号会报 EPERM，这时当它已经退出。
    // 2026-09-30 查到的偶发失败（测试里 Cursor 替身“kill EPERM”）就是这个；没拿到结果时照旧当失败。
    catch (e) { if (!hasCode(e, 'ESRCH') && !(completed && hasCode(e, 'EPERM'))) failure ??= e as Error; }
  };
  // 先请求退出：伪终端桥收到后先让自己起的交互程序正常退出、超时再强杀（它在另一个会话里，不在这个进程组）；
  // 桥没退出再补一刀，收尾时（finish）还会整组清一遍。
  const stop = (error?: Error) => { failure ??= error; kill('SIGTERM'); timers.push(setTimeout(() => kill(), command.graceMs ?? 300)); };
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true; timers.forEach(clearTimeout); kill();
    if (failure) reject(failure);
    else if (completed || (!command.complete && code === 0)) resolve(output);
    else reject(new Error(command.complete ? '未读到完整查询结果' : `查询程序退出码 ${code}`));
  };
  child.on('error', e => { failure = e; finish(null); });
  child.on('close', finish);
  child.stdin.on('error', e => { if (!completed) stop(e); });
  child.stderr.on('data', () => {}); // 不把可能含身份信息的原始错误输出写入缓存。
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (completed) return;
    output += chunk;
    if (output.length > 4 * 1024 * 1024) { stop(new Error('查询输出超过 4 MB')); return; }
    if (command.complete?.(output)) { completed = true; stop(); }
  });
  timers.push(setTimeout(() => stop(new Error('查询超时')), command.timeoutMs ?? 20_000));
  if (command.input) child.stdin.write(command.input);
  for (const write of command.writes ?? []) timers.push(setTimeout(() => {
    if (!completed && !failure) child.stdin.write(write.text);
  }, write.afterMs));
  if (!command.input && !command.writes) child.stdin.end();
});

export function grokEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const source of ['CLAUDE', 'CURSOR']) for (const feature of ['AGENTS', 'HOOKS', 'MCPS', 'RULES', 'SKILLS']) env[`GROK_${source}_${feature}_ENABLED`] = 'false';
  return env;
}
const names = { codex: 'Codex', grok: 'Grok', cursor: 'Cursor' };
const labels = { codex: ['周额度'], grok: ['本期额度'], cursor: ['自家模型池', '其他模型池'] };
function unavailable(icon: Provider, error: string): QuotaEntry {
  return { name: names[icon], icon, plan: null, at: null, error,
    bars: labels[icon].map(label => ({ label, used: null, reset: null })) };
}
// 这次没查到时，保留这家上一次的数据和时间（带上这次的原因）；上次也没有数据才算查不到。
function keepPrevious(icon: Provider, error: string, previous: QuotaSnapshot | null): QuotaEntry {
  const old = previous?.providers.find(p => p.icon === icon);
  if (!old?.bars.some(b => b.used !== null)) return unavailable(icon, error);
  const { reached: _stale, ...rest } = old; // 上次“已触顶”的说法过时了，不带过来拦派活。
  return { ...rest, error };
}
function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function iso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function parseCodexQuota(line: string, modifiedAt: string): QuotaEntry {
  const limits = JSON.parse(line)?.payload?.rate_limits;
  if (!limits || typeof limits !== 'object') throw new Error('会话额度字段不完整');
  const bars = [limits.primary, limits.secondary].filter(Boolean).map(window => ({
    label: window.window_minutes === 10080 ? '周额度' : window.window_minutes === 300 ? '5 小时额度' : `${window.window_minutes ?? '未知'} 分钟额度`,
    used: percent(window.used_percent), reset: typeof window.resets_at === 'number' ? iso(window.resets_at * 1000) : null,
    windowMinutes: window.window_minutes,
  }));
  if (!bars.length) throw new Error('会话中没有额度窗口');
  return { name: 'Codex', icon: 'codex', plan: typeof limits.plan_type === 'string' ? limits.plan_type : null, bars, at: modifiedAt,
    ...(limits.rate_limit_reached_type ? { reached: String(limits.rate_limit_reached_type) } : {}) };
}
export async function queryCodexQuota(directory = join(homedir(), '.codex/sessions')): Promise<QuotaEntry> {
  const files: { file: string; mtimeMs: number }[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ file, mtimeMs: (await stat(file)).mtimeMs });
    }
  }
  await walk(directory); // 不跟随符号链接，不接触会话目录外的登录文件。
  for (const { file, mtimeMs } of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20)) {
    let last: QuotaEntry | undefined;
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        try { last = parseCodexQuota(line, new Date(mtimeMs).toISOString()); }
        catch { /* 会话末尾可能还在写；保留上一条完整额度。 */ }
      }
    } finally { lines.close(); input.destroy(); }
    if (last) return last;
  }
  throw new Error('最近 20 个会话里没有额度记录');
}
function billingReply(raw: string) {
  for (const line of raw.split(/\r?\n/)) {
    try { const message = JSON.parse(line); if (message?.id === 2) return message; } catch { /* 普通日志行 */ }
  }
}
export function parseGrokQuota(raw: string, at: string): QuotaEntry {
  const reply = billingReply(raw), result = reply?.result, config = result?.config;
  if (!config || reply.error) throw new Error('未读到 Grok 账单结果');
  const approx = !Object.hasOwn(config, 'creditUsagePercent');
  return { name: 'Grok', icon: 'grok', plan: result.subscription_tier ?? null, at,
    bars: [{ label: '本期额度', used: approx ? 1 : percent(config.creditUsagePercent), ...(approx ? { approx: true } : {}), reset: iso(config.currentPeriod?.end) }] };
}
export function cleanTerminal(raw: string) {
  // 光标定位、清屏作为分隔符，避免不同位置的字粘在一起；颜色码直接剥掉。
  return stripVTControlCharacters(raw.replace(/\x1b\[[0-9;?]*[HfABCDJKG]/g, '\n')).replace(/[█░│┃]/g, ' ').replace(/\r/g, '\n');
}
export function parseCursorQuota(raw: string, at: string): QuotaEntry {
  const text = cleanTerminal(raw), marker = text.lastIndexOf('Esc to close');
  if (marker < 0) throw new Error('界面可能改了');
  const before = text.slice(0, marker), separator = before.lastIndexOf('────');
  // 真实界面里每个百分比后面跟一条进度条，On-Demand 后面还有一整行横线，先去掉。
  const body = (separator >= 0 ? before.slice(separator + 4) : before).replace(/[—─]{3,}/g, ' ').replace(/\s+/g, ' ').trim();
  const resetMatch = /Resets\s+([A-Za-z]+)\s+(\d{1,2})\b/.exec(body);
  const plan = /([A-Za-z][A-Za-z+]*)\s+Resets\b/.exec(body)?.[1]; // 真实界面是“Usage • Ultra    Resets Oct 16”
  if (!plan || !resetMatch) throw new Error('界面可能改了');
  const now = new Date(at), month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(resetMatch[1].slice(0, 3).toLowerCase());
  const day = Number(resetMatch[2]);
  if (month < 0 || day < 1 || day > 31) throw new Error('界面可能改了');
  let reset = new Date(now.getFullYear(), month, day);
  if (reset.getMonth() !== month) throw new Error('界面可能改了');
  if (reset.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) reset = new Date(now.getFullYear() + 1, month, day);
  const bars = [['Included', '总额度'], ['Auto', '自家模型池'], ['API', '其他模型池']].map(([key, label]) => {
    const match = new RegExp(`\\b${key}\\s+(\\d+(?:\\.\\d+)?)\\s*%\\s*used`, 'i').exec(body);
    if (!match) throw new Error('界面可能改了');
    return { label, used: Number(match[1]), reset: reset.toISOString() };
  });
  return { name: 'Cursor', icon: 'cursor', plan, at, bars, onDemand: /On-Demand\s+(.+?)(?=\s+On-demand usage|\s+View in|\s+cursor\.com|$)/.exec(body)?.[1]?.trim() };
}

export type QuotaOptions = { execute?: QueryExecutor; sessionsDir?: string; now?: Date };
export async function queryQuota(options: QuotaOptions = {}): Promise<QuotaSnapshot> {
  const at = (options.now ?? new Date()).toISOString(), execute = options.execute ?? executeQuery;
  await mkdir(paths().cache, { recursive: true });
  const previous = await readQuotaCache();
  const providers = await Promise.all(isolations.map(async icon => {
    try {
      if (icon === 'codex') {
        const directory = options.sessionsDir ?? process.env.XAGENTS_CODEX_SESSIONS;
        if (process.env.XAGENTS_FAKE_WORKER && !directory) throw new Error('测试替身未提供会话记录');
        return await queryCodexQuota(directory);
      }
      if (icon === 'grok') {
        const input = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
          { jsonrpc: '2.0', id: 2, method: '_x.ai/billing', params: {} }].map(m => JSON.stringify(m) + '\n').join('');
        return parseGrokQuota(await execute({ file: 'grok', args: ['agent', '--no-leader', 'stdio'], cwd: paths().cache,
          env: grokEnvironment(), input, timeoutMs: 20_000, complete: output => Boolean(billingReply(output)) }), at);
      }
      const root = await mkdtemp(join(paths().cache, 'cursor-usage-')), cwd = join(root, 'work'), state = cursorState(join(root, 'state'));
      try {
        await mkdir(cwd);
        // 配置和项目状态（含信任标记）同派活一样搬进这次的临时目录，查完一起删，不在 ~/.cursor/projects 留目录；登录不受影响。
        // 窗口大小 60×140 与实测能用的参考实现一致；不用 script，原因见 pty-bridge.py 开头。
        return parseCursorQuota(await execute({ file: 'python3', args: [unpackedPath(join(toolRoot, 'src/core/pty-bridge.py')), '60', '140', 'cursor-agent', '--trust', '--mode', 'ask'], cwd,
          env: { TERM: 'xterm-256color', CURSOR_CONFIG_DIR: state.config, CURSOR_DATA_DIR: state.data }, timeoutMs: 27_500, graceMs: 3000,
          writes: [{ afterMs: 6000, text: '/usage' }, { afterMs: 7500, text: '\r' }], complete: output => cleanTerminal(output).includes('Esc to close') }), at);
      } finally { await rm(root, { recursive: true, force: true }); }
    } catch (e) { return keepPrevious(icon, (e as Error).message, previous); }
  }));
  const snapshot = { queriedAt: at, providers };
  await writeJson(join(paths().cache, 'quota.json'), snapshot);
  return snapshot;
}
export async function readQuotaCache(): Promise<QuotaSnapshot | null> {
  try {
    const snapshot = await readJson<QuotaSnapshot>(join(paths().cache, 'quota.json'));
    if (!iso(snapshot?.queriedAt) || !Array.isArray(snapshot.providers) || snapshot.providers.length !== 3) return null;
    if (!isolations.every(icon => snapshot.providers.filter(p => p?.icon === icon && Array.isArray(p.bars)).length === 1)) return null;
    if (snapshot.providers.some(p => p.bars.some(b => !b || typeof b.label !== 'string' ||
      (b.used !== null && percent(b.used) === null) || (b.reset !== null && !iso(b.reset))))) return null;
    return snapshot;
  } catch { return null; } // 缓存损坏或不可读不能挡住收尾和看板。
}
export async function ensureQuota(options: QuotaOptions = {}) {
  const cached = await readQuotaCache(), now = options.now ?? new Date();
  const age = cached ? now.getTime() - Date.parse(cached.queriedAt) : Infinity;
  return cached && age >= 0 && age <= 600_000 ? cached : queryQuota(options);
}
// DeepSeek 借 Codex 跑但按用量扣自己的余额，不占 Codex 的周额度；简单版不查余额（钱用完时 DeepSeek 自己会报错）。
export function quotaPool(who: Who) {
  if (vendorOf(who) === 'deepseek') return { name: 'DeepSeek', label: '余额' };
  const provider = isolationOf(who);
  const label = provider === 'codex' ? '周额度' : provider === 'grok' ? '本期额度' : spec(who).pool === 'auto' ? '自家模型池' : '其他模型池';
  return { name: names[provider], label };
}
export function quotaBar(snapshot: QuotaSnapshot | null | undefined, who: Who) {
  if (vendorOf(who) !== isolationOf(who)) return undefined;
  const entry = snapshot?.providers.find(p => p.icon === isolationOf(who));
  if (!entry || entry.error) return undefined;
  const { label } = quotaPool(who);
  return entry.bars.find(b => isolationOf(who) === 'codex' ? b.windowMinutes === 10080 : b.label === label);
}
export function checkQuota(snapshot: QuotaSnapshot, chosen: { who: Who }[], force = false, quotaStop: number = LIMIT_CAPS.quotaStop) {
  if (force) return;
  for (const { who } of chosen) {
    const bar = quotaBar(snapshot, who);
    const codex = vendorOf(who) === 'codex' ? snapshot.providers.find(p => p.icon === 'codex') : undefined, reached = !codex?.error && codex?.reached;
    if (reached || (bar && !bar.approx && bar.used !== null && bar.used >= quotaStop)) {
      throw new Error(`${quotaPool(who).name} 的${bar?.label ?? '额度'}${reached ? '已触顶' : `已用 ${bar!.used}%，到了设置里的停派线 ${quotaStop}%`}，本次未派发。确实要派请加 --force。`);
    }
  }
}
export function quotaPoints(before: QuotaBar | undefined, after: QuotaBar | undefined): number | null {
  if (!before || !after || before.used === null || after.used === null || before.approx || after.approx || !before.reset || before.reset !== after.reset) return null;
  const diff = Math.round((after.used - before.used) * 10) / 10;
  if (diff < 0) return null;
  return diff;
}
export function quotaDelta(job: { who: Who } & QuotaSnapshots): string | null {
  const before = quotaBar(job.quota_before, job.who), after = quotaBar(job.quota_after, job.who);
  const diff = quotaPoints(before, after);
  return diff === null ? null : `${after!.label} +${diff.toFixed(1)}%`;
}
export function boardQuota(snapshot: QuotaSnapshot | null) {
  return (snapshot?.providers ?? (['codex', 'grok', 'cursor'] as const).map(icon => unavailable(icon, '尚未查询')))
    .map(({ name, icon, plan, bars, at, error }) => ({ name, icon, plan, at, ...(snapshot && error ? { failed: true as const } : {}), bars: bars.map(({ label, used, approx, reset }) => ({ label, used, ...(approx ? { approx } : {}), reset })) }));
}
