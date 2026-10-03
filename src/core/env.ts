// 选手看得到的环境变量：全仓库只有这一份规则，启动选手（runner.ts）、Codex 的启动参数（workers.ts）、隔离自检（selfcheck.ts）都从这里取。
// 选手跑的命令会继承启动它的进程的整个环境；主人常把别家的钥匙放在环境变量里（2026-10-02 实测：DeepSeek 选手 env 看到了主人的 *_API_KEY）。
// 所以名字里带下面这些词的变量（不分大小写）一律不交给选手。只看名字，不看值。依据 docs/research/worker-env-2026-10-02.md。
//
// 各家程序自己要的变量都不带这些词，所以不用留例外（逐个核对见上面那份记录）：
// - Codex：登录在隔离外由主进程从登录文件读（主人的 ~/.codex，DeepSeek 的在 <登记处>/deepseek），不靠环境变量；
//   主进程要的 HOME、PATH、代理、CODEX_HOME、TMPDIR 都不带这些词。
// - Grok：登录读 ~/.grok/auth.json，不靠环境变量；平台给它设的 GROK_*_ENABLED、GROK_MEMORY、GROK_DISABLE_AUTOUPDATER 都不带这些词。
// - Cursor：登录令牌存在系统钥匙串里，选手读不到；由看管进程在隔离外取出，过滤之后再以 CURSOR_AUTH_TOKEN 只放进这次 Cursor 进程
//   （runner.ts，顺序不能反；见 docs/research/keychain-2026-10-02.md）。它跑的命令看得到这一个，和以前“Cursor 读得到自己的登录”是同一范围；
//   平台给它设的 CURSOR_CONFIG_DIR、CURSOR_DATA_DIR 不带这些词。
// - srt：只读代理（HTTP_PROXY 等）、CLAUDE_CODE_TMPDIR、NODE_EXTRA_CA_CERTS、PATH，都不带这些词。
// 平台自己给选手设的变量（Command.env）照常交给选手，测试保证它们的名字都不带这些词。
export const SECRET_WORDS = ['KEY', 'TOKEN', 'SECRET', 'PASS', 'CREDENTIAL', 'AUTH', 'COOKIE', 'PRIVATE'] as const;
export const isSecretName = (name: string) => SECRET_WORDS.some(word => name.toUpperCase().includes(word));
// 平台自己给选手设的、名字恰好带这些词、值却不是密钥的开关（逐个写明理由）。只用在“平台设的变量不许带密钥字样”这条检查上；
// 继承来的同名变量照样会被去掉。
// - AGENT_CLI_CREDENTIAL_STORE=memory：让 Cursor 只在内存里记登录、不去写钥匙串（workers.ts，见 docs/research/keychain-2026-10-02.md）。
export const PLATFORM_SWITCHES = ['AGENT_CLI_CREDENTIAL_STORE'];

// srt 自己在隔离里给选手设的、名字带这些词的变量（srt 0.0.77 的 generateProxyEnvVars）：它每次启动随机生成的本地代理口令
// （randomBytes(16)），和它写进 HTTP_PROXY 网址里的是同一个，只能用来连 srt 自己的代理（只放行各家自家域名），不是主人的东西。
// 自检只在它的值正好等于 HTTP_PROXY 里的口令时才认它是 srt 的。
export const SRT_OWN_VARS = ['CLOUDSDK_PROXY_PASSWORD'];

// 选手进程的完整环境：继承的环境去掉带这些词的变量，再加上平台给它设的，最后去掉这件活点名不要的（比如 DeepSeek 的 KEY_VARS）。
export function workerEnv(inherited: NodeJS.ProcessEnv, add: Record<string, string> = {}, unset: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) if (!isSecretName(name)) env[name] = value;
  Object.assign(env, add);
  for (const name of unset) delete env[name];
  return env;
}
// 交给会把 process.env 垫在底下的执行器（verify.ts 的 execute）时用：base 里有、env 里没有的变量写成 undefined，Node 启动子进程时会跳过它们。
// base 要包含 process.env（默认就是它）。
export function exactEnv(env: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.keys(base).map(name => [name, undefined])), ...env };
}

// Codex 自己还有一层：选手跑的命令的环境由它的 shell_environment_policy 决定（codex-cli 0.159 实测：默认不过滤；
// exclude 支持 * 通配、不分大小写）。主进程的环境已经按上面去过一遍，这一层是双保险，万一有变量漏进 Codex 主进程也到不了命令里。
// extra：这件活另外点名不交给命令的变量名。
export function codexEnvPolicy(extra: readonly string[] = []) {
  const patterns = [...SECRET_WORDS.map(word => `*${word}*`), ...extra];
  return `shell_environment_policy.exclude=[${patterns.map(p => `"${p}"`).join(',')}]`;
}
