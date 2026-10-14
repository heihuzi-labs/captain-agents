// 用户的 Codex 连的是哪个接口（docs/design-scan.md 规则二、三；实测依据 docs/research/codex-endpoint-2026-10-12.md）。
// 平台启动 Codex 时不读用户的配置（--ignore-user-config），接口地址也跟着丢了，接自定义接口的人派不出活。
// 这里只读配置文件里“连哪个接口”那一段：最上面的 model_provider、openai_base_url，和 [model_providers.<名字>] 那一张表，
// 换成启动参数原样带上。别的配置一概不读、不生效；钥匙不读、不带；读不懂的项不带，并说明原因。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasCode } from './fsx.ts';
import { isSecretName } from './env.ts';

export type Endpoint = {
  custom: boolean;        // 连的不是官方接口：读到的额度不是这位用户的，不显示（规则三）
  args: string[];         // 带进 codex 启动参数的 -c 项（规则二）；官方接口时是空的
  envKey: string | null;  // 钥匙放在哪个环境变量里：只把这一个交给 Codex 主程序，选手跑的命令照旧看不到
  problem: string | null; // 带不全时写给人看的原因；派活时提示，不拦
};
export const official: Endpoint = { custom: false, args: [], envKey: null, problem: null };

type Scalar = string | boolean | number;
type Value = Scalar | Record<string, string>;
// 带哪几项：地址、协议、钥匙从哪取，和不含密钥的几项连接设置。
const CARRIED = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'env_key', 'query_params', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'supports_websockets'];
// 直接装着钥匙的项：不带，钥匙不进启动参数（参数会写进任务记录，别的进程也看得到）。
const SECRET = ['experimental_bearer_token', 'http_headers', 'env_http_headers'];
const bare = /^[A-Za-z0-9_-]+$/;
// 配置里点名放钥匙的变量不能是系统或平台自己要用的：放行会把平台给选手设好的值换掉，写进“不给命令”的名单又会让命令拿不到它。
const RESERVED = /^(PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|CODEX_HOME|SHELL|USER|USERNAME|LANG|PWD|SYSTEMROOT|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|NODE_.*|NPM_.*|ELECTRON_.*|XAGENTS_.*|CLAUDE_.*|GROK_.*|CURSOR_.*)$/i;
// 地址里自带账号密码、或地址参数的名字像钥匙的：等于把钥匙写在了配置里，不带（启动参数会写进任务记录）。
function secretInUrl(value: string): boolean {
  try { const url = new URL(value); return Boolean(url.username || url.password) || [...url.searchParams.keys()].some(isSecretName); }
  catch { return false; }
}

function scalar(raw: string): Scalar | undefined {
  const text = raw.trim();
  if (text.startsWith('"""') || text.startsWith("'''")) return undefined;
  let match = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text);
  if (match) { try { const value: unknown = JSON.parse(`"${match[1]}"`); return typeof value === 'string' ? value : undefined; } catch { return undefined; } }
  match = /^'([^']*)'\s*(?:#.*)?$/.exec(text);
  if (match) return match[1];
  match = /^(true|false)\s*(?:#.*)?$/.exec(text);
  if (match) return match[1] === 'true';
  match = /^([+-]?\d+)\s*(?:#.*)?$/.exec(text);
  return match ? Number(match[1]) : undefined;
}
// 只认一行写完、值都是字符串的小表（query_params = { api-version = "…" }）。
function inlineTable(raw: string): Record<string, string> | undefined {
  const match = /^\{(.*)\}\s*(?:#.*)?$/.exec(raw.trim());
  if (!match) return undefined;
  const out: Record<string, string> = {}, body = match[1].trim();
  if (!body) return out;
  const item = /\s*(?:"([^"\\]*)"|([A-Za-z0-9_-]+))\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(,|$)/y;
  for (item.lastIndex = 0; item.lastIndex < body.length;) {
    const found = item.exec(body);
    if (!found) return undefined;
    const value = scalar(found[3]);
    if (typeof value !== 'string') return undefined;
    out[found[1] ?? found[2]] = value;
  }
  return out;
}
// [a.b."c d"] 这样的表头拆成几段；数组表（[[…]]）和写法不认识的返回 null。
function header(line: string): string[] | null {
  const match = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  const parts: string[] = [], segment = /\s*(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  for (segment.lastIndex = 0; segment.lastIndex < match[1].length;) {
    const found = segment.exec(match[1]);
    if (!found) return null;
    parts.push(found[1] ?? found[2] ?? found[3]);
  }
  return parts;
}
const toml = (value: Value): string => typeof value === 'string' ? JSON.stringify(value) : typeof value === 'object'
  ? `{${Object.entries(value).map(([k, v]) => `${bare.test(k) ? k : JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}` : String(value);

export function parseEndpoint(text: string): Endpoint {
  const top: Record<string, Scalar | undefined> = {}, tables = new Map<string, Record<string, Value | undefined>>(), nested = new Map<string, Set<string>>();
  let section: string[] | null = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\s*\[/.test(line)) { section = header(line); continue; }
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair || !section) continue;
    const [, key, raw] = pair;
    // 同一个键写两遍，真正的 TOML 会报错；这里不猜哪一个算数，当作读不懂。
    if (!section.length) { if (key === 'model_provider' || key === 'openai_base_url') top[key] = key in top ? undefined : scalar(raw); continue; }
    if (section[0] !== 'model_providers' || section.length < 2 || section.length > 3) continue;
    const table = tables.get(section[1]) ?? {};
    tables.set(section[1], table);
    if (section.length === 2) table[key] = key in table ? undefined : key === 'query_params' ? inlineTable(raw) : scalar(raw);
    else {
      // [model_providers.<名字>.<子表>]：只带 query_params；装着钥匙的子表记下名字，后面说明没带。
      const names = nested.get(section[1]) ?? new Set<string>();
      nested.set(section[1], names); names.add(section[2]);
      if (section[2] !== 'query_params') continue;
      const value = scalar(raw), params = typeof table.query_params === 'object' ? table.query_params : {};
      table.query_params = typeof value === 'string' && !(key in params) ? { ...params, [key]: value } : undefined;
    }
  }
  const provider = top.model_provider, base = top.openai_base_url, args: string[] = [], problems: string[] = [];
  if ('model_provider' in top && typeof provider !== 'string') problems.push('读不懂 model_provider 这一项');
  if ('openai_base_url' in top && typeof base !== 'string') problems.push('读不懂 openai_base_url 这一项');
  let envKey: string | null = null;
  const inline: string[] = [];
  if (typeof base === 'string') { if (secretInUrl(base)) inline.push('openai_base_url'); else args.push('-c', `openai_base_url=${toml(base)}`); }
  if (typeof provider === 'string' && provider !== 'openai') {
    if (!bare.test(provider)) problems.push(`接口的名字（${provider}）里有平台不认的字符`);
    else {
      args.push('-c', `model_provider=${toml(provider)}`);
      const table = tables.get(provider) ?? {}, carried: string[] = [];
      for (const key of CARRIED) {
        if (!(key in table)) continue;
        const value = table[key];
        if (value === undefined) { problems.push(`读不懂 ${key} 这一项`); continue; }
        if (key === 'base_url' && typeof value === 'string' && secretInUrl(value)) { inline.push(key); continue; }
        if (key === 'query_params' && typeof value === 'object' && Object.keys(value).some(isSecretName)) { inline.push(key); continue; }
        if (key === 'env_key') {
          if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) { problems.push('env_key 不是一个环境变量的名字'); continue; }
          if (RESERVED.test(value)) { problems.push(`env_key 指的是系统或平台自己要用的变量（${value}），不带`); continue; }
          envKey = value;
        }
        carried.push(`${key}=${toml(value)}`);
      }
      const secrets = [...SECRET.filter(key => key in table || nested.get(provider)?.has(key)), ...inline];
      if (secrets.length) problems.push(`接口那一段里直接写着钥匙（${secrets.join('、')}），平台不带这几项；请把钥匙交给 Codex 保管（codex login --with-api-key）`);
      if (carried.length) args.push('-c', `model_providers.${provider}={${carried.join(',')}}`);
    }
  }
  if (inline.includes('openai_base_url') && !problems.some(p => p.includes('直接写着钥匙'))) problems.push('接口地址里直接写着钥匙（openai_base_url），平台不带这一项；请把钥匙交给 Codex 保管（codex login --with-api-key）');
  const custom = typeof base === 'string' || (typeof provider === 'string' && provider !== 'openai') || problems.length > 0;
  return { custom, args, envKey, problem: problems.length ? `Codex 配置里连接口的那一段没能完整带上：${problems.join('；')}。` : null };
}

// 用户的 Codex 文件夹：和 Codex 自己的规矩一样，CODEX_HOME 优先。
export const codexConfigFile = (env: NodeJS.ProcessEnv = process.env, home = homedir()) => join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
export async function codexEndpoint(file = codexConfigFile()): Promise<Endpoint> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return official; return { custom: true, args: [], envKey: null, problem: `读不了 Codex 的配置文件（${(error as Error).message}），没法知道它连的是哪个接口。` }; }
  return parseEndpoint(text);
}
