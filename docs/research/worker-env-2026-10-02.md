# 选手看得到的环境变量和终端配置文件（实测，2026-10-02）

本机版本：codex-cli 0.159.0，grok 1.0.46，cursor-agent 2026.10.01-14929f9，srt（@anthropic-ai/sandbox-runtime）0.0.77。每条标了出处：源码 / 实测。所有实测只看变量名、只看“能不能打开”，没有读出或打印任何值。

## 1. 起因

DeepSeek 选手（借 Codex 跑，同一套 Codex 隔离）在隔离里运行 `env | grep 'sk-' | sed 's/=.*/=<redacted>/'`，看到了主人环境里别家服务的一个 `*_API_KEY`。选手跑的命令会继承派活进程的整个环境，主人放在环境变量里的别家钥匙对选手可见，违反“不让选手读密钥”。

## 2. 三种隔离各自怎么把环境交给选手（改之前）

| 隔离 | 链条 | 有没有过滤 |
|---|---|---|
| Codex | 派活进程 → `codex exec`（主进程在隔离外）→ 选手的命令（在隔离里） | 主进程拿到派活进程的整个环境（runner.ts `{ ...process.env, ...cmd.env }`）。命令的环境由 Codex 的 `shell_environment_policy` 决定，**默认不过滤**（实测，见下）。 |
| Grok | 派活进程 → srt → `grok`（在隔离里）→ 选手的命令 | srt 原样传下去，只改代理、`TMPDIR` 等几项（源码 `sandbox-utils.js` 的 `generateProxyEnvVars`）。Grok 不过滤；而且**跑命令用登录式 bash，会自动读 `~/.bash_profile`、`~/.bashrc`**，把主人写在里面的钥匙重新导出（实测，见第 5 节）。 |
| Cursor | 派活进程 → srt → `cursor-agent`（在隔离里）→ 选手的命令 | 同 srt。cursor-agent 不读终端配置文件（实测：命令里只多出 srt 自己的代理口令）。 |

### Codex 的 `shell_environment_policy`（实测）

在隔离外放 5 个假变量（`XA_FAKE_API_KEY`、`XA_FAKE_TOKEN`、`XA_FAKE_SECRET`、`XA_FAKE_PASSWORD`、`XA_FAKE_lower_key`），用 `codex sandbox <参数> -- /usr/bin/env` 看命令里剩哪些名字：

| 参数 | 命令里还看得到 |
|---|---|
| 不加 | 5 个全在（**默认不过滤**） |
| `-c shell_environment_policy.ignore_default_excludes=false` | 只剩 `XA_FAKE_PASSWORD`（内置的只有 KEY、SECRET、TOKEN 三个词） |
| `-c 'shell_environment_policy.exclude=["*key*","*TOKEN*"]'` | `XA_FAKE_PASSWORD`、`XA_FAKE_SECRET`：**支持 `*` 通配、不分大小写**（`*key*` 去掉了 `XA_FAKE_API_KEY` 和 `XA_FAKE_lower_key`） |
| `-c 'shell_environment_policy.exclude=["XA_FAKE_API_KEY"]'` | 只去掉写明的那一个 |
| `-c shell_environment_policy.inherit="core"` | 一个都没有（只留 HOME、PATH 等几项，太窄，不用） |

`codex sandbox` 和 `codex exec` 用的是同一套规则：DeepSeek 接入时已实测 `codex exec` 加 `exclude` 后命令看不到（[connect-deepseek-2026-10-02.md](connect-deepseek-2026-10-02.md) 第 4 节），本次真派 Codex 活也看不到（第 6 节）。

## 3. 各家程序自己要不要带“密钥字样”的变量（源码 / 实测）

| 程序 | 要的变量 | 结论 |
|---|---|---|
| Codex 主进程 | HOME、PATH、代理、`CODEX_HOME`、`TMPDIR` | 登录从登录文件读（主人的 `~/.codex/auth.json`，DeepSeek 的在 `<登记处>/deepseek`），不靠环境变量。`OPENAI_API_KEY`、`CODEX_API_KEY` 等反而会抢在登录文件前面（connect-deepseek 记录），去掉更安全。 |
| grok | HOME、PATH、代理；平台设的 `GROK_*_ENABLED`、`GROK_MEMORY`、`GROK_DISABLE_AUTOUPDATER` | 程序里认 `XAI_API_KEY`、`GROK_CODE_XAI_API_KEY`、`GROK_AUTH_*` 等（`strings` 查到），都是另一种登录方式。主人用的是 `~/.grok/auth.json`，环境里没有这些变量，不用留。 |
| cursor-agent | HOME、PATH、代理；平台设的 `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR` | 程序里认 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`（源码 `process.env.*`），也是另一种登录方式，主人没用，不用留。 |
| srt | `HTTP_PROXY` 等代理、`CLAUDE_CODE_TMPDIR`、`NODE_EXTRA_CA_CERTS`、PATH | 源码里读的 `process.env.*` 没有一个带密钥字样。 |

主人当前环境里代理变量的值都不带账号密码（只查有没有 `@`）。

结论：名字带密钥字样的变量，各家都用不着，**不留例外**。平台自己给选手设的变量（`Command.env`）照给，测试保证它们的名字都不带这些词（`test/workers.test.ts`）。

## 4. 做法

规则只在 `src/core/env.ts` 一处：

- 名字里带 `KEY`、`TOKEN`、`SECRET`、`PASS`、`CREDENTIAL`、`AUTH`、`COOKIE`、`PRIVATE`（不分大小写）的变量，一律不交给选手。只看名字，不看值。`PASS` 覆盖 PASSWORD、PASSWD、PASSPHRASE；`AUTH` 覆盖 OAUTH、`SSH_AUTH_SOCK`（SSH 代理的连接口）。PWD、PATH、代理、TMPDIR 都不受影响。
- 第一层（三家都有）：`runner.ts` 启动选手时用 `workerEnv(process.env, cmd.env, cmd.unset)`：继承的环境先去掉这些变量，再加平台设的，最后去掉这件活点名不要的（DeepSeek 的 `KEY_VARS`，其中 `OPENAI_FEDERATION_RULE_ID`、`OPENAI_WORKLOAD_IDENTITY_CONTEXT` 不带这些词，所以这张表还留着）。Codex 主进程、srt 都拿不到。
- 第二层（Codex）：所有 Codex 选手（含 DeepSeek）都带 `-c shell_environment_policy.exclude=["*KEY*","*TOKEN*",…]`（DeepSeek 后面再加 `KEY_VARS`），万一有变量漏进 Codex 主进程，也到不了命令里。
- 终端配置文件和命令历史三种隔离一律禁读（第 5 节）：`~/.bashrc`、`~/.bash_profile`、`~/.bash_login`、`~/.profile`、`~/.bash_history`、`~/.zshrc`、`~/.zshenv`、`~/.zprofile`、`~/.zlogin`、`~/.zsh_history`、`~/.zsh_sessions`、`~/.config/fish`（`sandbox.ts` 的 `SHELL_FILES`，Codex 权限表和 srt 模板共用）。
- 共同规则 `rules.md` 加一句：这些文件故意读不到，命令前那行“Operation not permitted”不用理会。

srt 例外：srt 在隔离里自己设了 `CLOUDSDK_PROXY_PASSWORD`（源码 `generateProxyEnvVars`），值是它每次启动 `randomBytes(16)` 生成的本地代理口令，和它写进 `HTTP_PROXY` 网址里的是同一个，只能用来连 srt 自己的代理（只放行各家自家域名），不是主人的东西。

## 5. 终端配置文件（实测）

测试用的这台机器上，`~/.bashrc` 里 `export` 了几个钥匙，其他终端配置文件里也有（只数行数和名字）。很多人都这样放钥匙，所以按“一定有”来防。

第一次真派三家只读小题（只做了第 4 节第一、二层，还没禁读这些文件），让选手跑 `env | cut -d= -f1 | grep -iE '…'`：

| 选手 | 看到的名字 | 外面放的假变量 `XA_OWNER_FAKE_API_KEY` |
|---|---|---|
| Codex | 没有 | 看不到 |
| Grok | `~/.bashrc` 里的那几个 `*_API_KEY`、`CLOUDSDK_PROXY_PASSWORD` | 看不到 |
| Cursor · Grok | `CLOUDSDK_PROXY_PASSWORD` | 看不到 |

假变量看不到，说明环境那一层挡住了；Grok 多出来的正好是 `~/.bashrc` 里那几个：它跑命令用登录式 bash，自己把配置文件读了一遍。另外三种隔离都允许直接 `cat ~/.bashrc`。

在 srt（Grok 模板）和 Codex 隔离里分别用 `bash -lc`、`bash -ic`、`zsh -lc`、`zsh -ic` 对照：

| | 命令里的钥匙名 | 读 `~/.bashrc` | `which node git` |
|---|---|---|---|
| 不禁读 | bash 和 `zsh -ic` 下都看得到 | 能读 | nvm 的 node、`/usr/bin/git` |
| 禁读 | 没有 | Operation not permitted | Homebrew 的 node（v26）或 nvm 的、`/usr/bin/git` |

禁读后 bash 每条命令前多一行 `/bin/bash: …/.bash_profile: Operation not permitted`，退出码仍是 0，命令照常跑。禁读一个本机没有的文件，两种隔离都报“不存在”（ENOENT），已有的报“没有权限”（EPERM）。桌面应用本来就自己设 PATH、不读这些文件（`paths.ts` 的 `desktopPath`）。

## 6. 新的探针结果（实测）

自检升到第 5 版，加两项：

- `env-secret`：自检在探针进程继承的环境里放 `XAGENTS_SELFCHECK_API_KEY`（值是随机数），按派活时同一个 `workerEnv` 交给隔离；Codex 另把 `XAGENTS_SELFCHECK_INNER_TOKEN` 绕过第一层直接塞给 Codex，只靠第二层挡。探针看不到这两个、也没有别的带密钥字样的变量才算挡住；srt 的 `CLOUDSDK_PROXY_PASSWORD` 只在值正好等于 `HTTP_PROXY` 里的口令时放过。只报名字。
- `shell-files`：逐个打开 `SHELL_FILES`，本机有的都要“没有权限”，本机没有的不算数，打开任何一个就是放行。只看能不能打开，不读内容。

在隔离外用临时登记处跑 `xagents selfcheck`（环境里另放一个 `XA_OWNER_FAKE_API_KEY`），**通过**：

| 隔离 | env-secret | shell-files |
|---|---|---|
| codex | 看不到 | 挡住 9 个，本机没有 3 个 |
| grok | 看不到 | 挡住 9 个，本机没有 3 个 |
| cursor | 看不到 | 挡住 9 个，本机没有 3 个 |

（加 srt 例外之前，grok、cursor 两项报“看得到 CLOUDSDK_PROXY_PASSWORD”，自检不过；查清是 srt 自己的口令后才加例外。）

反面对照（同一台机器、同一个只列名字的脚本）：

| 做法 | 看到的名字 |
|---|---|
| srt 不过滤（旧做法） | 环境里的几个 `*_API_KEY`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_OAUTH_SCOPES`、`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`、`CLOUDSDK_PROXY_PASSWORD`、`SSH_AUTH_SOCK`、`USE_LOCAL_OAUTH`、`USE_STAGING_OAUTH`、`XA_OWNER_FAKE_API_KEY` |
| srt 按 env.ts 过滤 | 只有 srt 自己的 `CLOUDSDK_PROXY_PASSWORD` |
| Codex 不过滤、无策略（旧做法） | 同第一行，少 `CLOUDSDK_PROXY_PASSWORD` |
| Codex 只靠第二层（第一层漏了的情形） | 没有 |
| Codex 两层都开 | 没有 |

旧做法下连负责人会话自己的 `CLAUDE_CODE_MESSAGING_TOKEN` 也会交给选手。

改完后再真派三家只读小题（Codex · GPT-6 Astra 中档、Grok 4.7 中档、Cursor · Grok 4.7 中档），都正常做完：

| 选手 | 钥匙名 | 假变量 | 读 `~/.bashrc` | node / git / npm |
|---|---|---|---|---|
| Codex | 没有 | 看不到 | 没去试（它看到权限规则就不读） | v24.13.0 / 2.50.1 / 11.6.2 |
| Grok | 只有 `CLOUDSDK_PROXY_PASSWORD` | 看不到 | Operation not permitted | v26.5.0 / 2.50.1 / 11.17.0 |
| Cursor · Grok | 只有 `CLOUDSDK_PROXY_PASSWORD` | 看不到 | Operation not permitted | v26.8.1 / 2.50.1 / 11.6.2 |

临时登记处、副本和 Grok 的会话文件夹都已清理，临时登记处移进废纸篓。

## 7. 还没管的

- 只看名字。名字不带这些词、值却是钥匙的变量（比如 `DATABASE_URL=postgres://用户:密码@…`）挡不住；主人把钥匙放进环境变量时，名字里最好带 KEY、TOKEN 之类。
- 终端配置文件里 `source` 进来的别的文件（比如 `~/.secrets`）不在名单上，需要时在设置的“额外禁读的家目录位置”里加。
- 家目录下其他常见的登录文件（`~/.netrc`、`~/.git-credentials`、`~/.docker/config.json`、`~/.kube/config` 等）当时不在默认禁读名单上；已另开一件补上，见 [credential-files-2026-10-02.md](credential-files-2026-10-02.md)。
- srt 隔离能读系统钥匙串的问题照旧（[connect-deepseek-2026-10-02.md](connect-deepseek-2026-10-02.md) 第 5 节）。
