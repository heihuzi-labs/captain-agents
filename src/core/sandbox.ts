import { isAbsolute, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { readJson } from './fsx.ts';
import { jobDir, paths, toolRoot } from './paths.ts';
import { createHash } from 'node:crypto';
import type { Job } from './job.ts';
import type { Project } from './project.ts';
import { relativePath } from './project.ts';
import { isolationOf } from './roster.ts';

function tomlString(value: string) {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('权限路径不能包含控制字符。');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 每件活一个专用临时目录（任务目录下的 tmp/，xagents clean 时删掉），选手只能写它，不能写公用的 /tmp、/var/folders：
// 那里有负责人会话的草稿和后台输出、别的程序的临时文件和套接字。依据 docs/research/tmp-writes-2026-09-30.md。
export const jobTmpDir = (job: Pick<Job, 'id'>) => join(jobDir(job.id), 'tmp');

// DeepSeek 选手的 Codex 文件夹（CODEX_HOME）：放 DeepSeek 的登录（API 钥匙）和它的会话记录，和主人自己 ~/.codex 里的 ChatGPT 登录分开。
// 钥匙由 Codex 隔离外的主进程读；三种隔离里的选手一律读不到这个文件夹。依据 docs/research/connect-deepseek-2026-10-02.md。
export const deepseekHome = () => join(paths().home, 'deepseek');

// 系统钥匙串的两个文件夹：本用户的（登录钥匙串，主人和各家程序存的密码）和系统的（Wi-Fi 等）。三种隔离一律读不到。
// srt 固定放行钥匙串服务、设置里收不回，读得到文件就能用 security 读出密码；挡住文件就读不出。
// Grok、Cursor 的模板（sandbox/*.json）里写的是同样两处。依据 docs/research/keychain-2026-10-02.md。
export const keychainDirs = () => [join(homedir(), 'Library/Keychains'), '/Library/Keychains'];

// 终端的配置文件和命令历史：主人常把钥匙写在里面（export XX_API_KEY=…），历史里也会留下敲过的钥匙。
// Grok 跑命令用登录式 bash，会自动读 ~/.bash_profile、~/.bashrc，把里面的钥匙重新导进命令的环境，env.ts 的过滤就白做了；
// 选手也能直接 cat 这些文件。所以三种隔离一律禁读（2026-10-02 实测，docs/research/worker-env-2026-10-02.md）。
// 禁读后 bash 每条命令前多一行“Operation not permitted”的提示，命令照常跑；PATH 由派活进程传下去，不靠这些文件。
export const SHELL_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.bash_history',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zsh_history', '.zsh_sessions', '.config/fish'];
// 家目录下常见的登录和凭据文件：里面是主人在别家服务的密码、令牌、私钥。允许联网也不放开这些；
// 三家程序启动、git 本地操作都不读（2026-10-02 实测，docs/research/credential-files-2026-10-02.md）。
// 整个目录只放纯凭据目录；.cargo、.gem、.terraform.d、Hugging Face 缓存里还有程序和缓存，只禁读凭据那个文件。
// 每次运行都要读的配置（~/.terraformrc、~/.m2/settings.xml、~/.gradle/gradle.properties、~/.yarnrc.yml、Poetry 的 auth.toml）不放：读不到程序直接报错。
export const CREDENTIAL_FILES = ['.netrc', '.git-credentials', '.config/git/credentials',
  '.docker', '.dockercfg', '.kube', '.config/gcloud', '.azure', '.gnupg', '.config/op', '.config/hub', '.config/glab-cli', '.ollama',
  '.pypirc', '.gem/credentials', '.cargo/credentials.toml', '.cargo/credentials', '.terraform.d/credentials.tfrc.json',
  '.pgpass', '.my.cnf', '.vault-token', '.huggingface/token', '.cache/huggingface/token', '.cache/huggingface/stored_tokens',
  // DeepSeek Harness 的家目录：里面有它的登录凭据和会话记录，选手用不着（2026-10-03 加，docs/research/connect-dsh-2026-10-02.md）。
  '.dsh'];
// 三种隔离共用的家目录禁读名单（Codex 权限表和 srt 模板都从这里取）。
const HOME_DENY = [...SHELL_FILES, ...CREDENTIAL_FILES];

// 依据 docs/research/codex-permissions-2026-09-29.md；启动与探针只能从这里取表。
// denyReadHome：设置里额外禁读的家目录位置（settings.ts 的 extraDenyRead，派活开头读好）。
export type Isolated = Pick<Project, 'denyReadExtra'> & { denyReadHome?: string[] };
// :workspace 自带 /tmp 和 $TMPDIR 可写：两者都改成只读，只有任务的 tmp 写明可写（启动方另把 TMPDIR 指向它）。
// 实测不设 TMPDIR 时 :tmpdir 就是系统给本用户的临时目录，所以不能只靠环境变量把它指走。
// 2026-10-09 主人决定网络完全不限：只加 enabled，不启用 network_proxy（实测报告 3.1）。
export function codexPermissions(job: Pick<Job, 'mode' | 'repo' | 'worktree' | 'id'>, project: Isolated, tmp = jobTmpDir(job), network = false) {
  tomlString(job.repo); tomlString(job.worktree); tomlString(tmp); checkRoot(tmp, '临时目录');
  const rules = new Map<string, 'read' | 'write' | 'deny'>();
  for (const path of ['.ssh', '.codex', '.grok', '.cursor', '.aws', '.claude', '.config/gh', '.npmrc', ...HOME_DENY, ...(project.denyReadHome ?? [])]) { tomlString(path); relativePath(path); rules.set(join(homedir(), path), 'deny'); }
  rules.set(join(homedir(), '.codex/tmp'), 'read');
  tomlString(deepseekHome()); rules.set(deepseekHome(), 'deny');
  for (const dir of keychainDirs()) { tomlString(dir); rules.set(dir, 'deny'); }
  rules.set(':slash_tmp', 'read');
  rules.set(':tmpdir', 'read');
  rules.set(tmp, 'write');
  for (const extra of project.denyReadExtra) {
    // 在 resolve 前检查，避免换行等字符在规范化时消失。
    tomlString(extra); relativePath(extra);
    rules.set(resolve(job.repo, extra), 'deny');
    rules.set(resolve(job.worktree, extra), 'deny');
  }
  const filesystem = [...rules].map(([path, permission]) => `${tomlString(path)}="${permission}"`).join(',');
  return `permissions.xa={extends="${job.mode === 'read-only' ? ':read-only' : ':workspace'}",filesystem={${filesystem}}${network === true ? ",network={enabled=true}" : ""}}`;
}

// 各家的全局配置目录对选手只读（依据 docs/research/global-config-writes-2026-09-30.md）：
// 钩子、技能、规矩、插件、程序本身都在里面，主人之后在隔离外打开就会被加载，甚至以主人身份执行。
// Cursor 会变的东西（配置、聊天记录、项目状态和信任标记）用两个环境变量搬到任务目录里，登录不受影响。
export function cursorState(dir: string) {
  return { root: dir, config: join(dir, 'config'), data: join(dir, 'data') };
}
// 状态目录要短：cursor-agent 把工作目录的 worker.sock 放在 <数据目录>/projects/<副本名> 下，
// 数据目录（接上 /projects 前后）超过 84 个字符，它就改放写死的 /tmp/.cursor，隔离里写不进去，活 2 秒就失败
// （cursor-agent 2026.09.28 源码 ../cursor-config 的 socket 目录函数；实测见 docs/research/global-config-writes-2026-09-30.md 第 8 节）。
// 所以不放在任务目录下，而放在登记处的 cursor/<任务号哈希> 下；清理时一起删。
export const cursorStateDir = (job: Pick<Job, 'id'>) => join(paths().home, 'cursor', createHash('sha256').update(job.id).digest('hex').slice(0, 12));
export const CURSOR_DATA_LIMIT = 84;
export function checkCursorState(dir: string) {
  const data = cursorState(dir).data;
  if (data.length > CURSOR_DATA_LIMIT) throw new Error(`Cursor 的数据目录路径太长（${data.length} 个字符，最多 ${CURSOR_DATA_LIMIT}），它会改用公用的 /tmp/.cursor 而启动失败。请把登记处（XAGENTS_HOME）换到短一些的路径。`);
  return dir;
}
// Grok 只需要写本次副本自己的会话文件夹（~/.grok/sessions/<副本路径逐段转义>）。
// 实测转义同 encodeURIComponent；! ' ( ) * ~ 两种写法都放开，副本路径和它的真实路径各算一份。
// srt 把 * ? [ ] 当通配符：带这些字符的写法一律不放开（Grok 若用的正是这种写法，会启动就报错，不会悄悄放宽）。
export async function grokSessionDirs(worktree: string) {
  checkRoot(worktree, '副本路径');
  const root = join(homedir(), '.grok/sessions');
  const strict = (p: string) => encodeURIComponent(p).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const real = await realpath(worktree).catch(() => worktree);
  checkRoot(real, '副本的真实路径');
  const names = [...new Set([worktree, real].flatMap(p => [encodeURIComponent(p), strict(p)]))].filter(name => !hasGlob(name));
  for (const name of names) if (!name.startsWith('%2F') || name.includes('/')) throw new Error(`Grok 会话文件夹名不对：${name}`);
  return names.map(name => join(root, name));
}
const hasGlob = (p: string) => /[*?[\]]/.test(p);
// 放开写的每一处都必须是规范的绝对路径、不是根目录、不含通配符，免得展开后比本意更宽。
function checkRoot(path: string, what: string) {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.endsWith('/') || hasGlob(path)) {
    throw new Error(`${what}必须是规范的绝对路径、不含 * ? [ ]：${JSON.stringify(path)}。`);
  }
}

export async function sandbox(job: Job, project: Isolated, state = cursorStateDir(job), tmp = jobTmpDir(job), network = false) {
  const template = await readJson<{ filesystem: { allowWrite: string[]; denyRead: string[] }; [key: string]: unknown }>(join(toolRoot, 'sandbox', `${isolationOf(job.who) === 'grok' ? 'grok' : 'cursor'}.json`));
  assertNoLocalEscape(template);
  // 只有库接口省略 allowedDomains 才是不限制网络，开着时改走 srt-open.ts。
  if (network === true) delete template.network;
  const sessions = template.filesystem.allowWrite.includes('__GROK_SESSION__') ? await grokSessionDirs(job.worktree) : [];
  template.filesystem.allowWrite = template.filesystem.allowWrite.flatMap((p: string) =>
    p === '__WT__' ? (job.mode === 'read-only' ? [] : [job.worktree])
    : p === '__CURSOR_STATE__' ? [state]
    : p === '__TMP__' ? [tmp]
    : p === '__GROK_SESSION__' ? sessions : [p]);
  for (const path of template.filesystem.allowWrite) checkRoot(path, '可写路径');
  template.filesystem.denyRead.push(deepseekHome());
  for (const path of HOME_DENY) template.filesystem.denyRead.push(join(homedir(), path));
  for (const path of project.denyReadHome ?? []) { relativePath(path); template.filesystem.denyRead.push(join(homedir(), path)); }
  for (const extra of project.denyReadExtra) {
    relativePath(extra);
    template.filesystem.denyRead.push(resolve(job.repo, extra), resolve(job.worktree, extra));
  }
  assertNoLocalEscape(template);
  return template;
}

// 不论层级和值，这些键都不能出现，连 false 也不接受。
export function assertNoLocalEscape(settings: unknown): void {
  if (!settings || typeof settings !== 'object') return;
  for (const [key, value] of Object.entries(settings)) {
    if (['allowLocalBinding', 'allowUnixSockets', 'allowAllUnixSockets'].includes(key)) throw new Error(`隔离设置不允许 ${key}，本机端口和套接字必须保持关闭。`);
    assertNoLocalEscape(value);
  }
}
