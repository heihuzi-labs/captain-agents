# 家目录下常见登录凭据文件对选手禁读（实测，2026-10-02）

本机版本：codex-cli 0.159.0，grok 1.0.46，cursor-agent 2026.10.01-14929f9，srt（@anthropic-ai/sandbox-runtime）0.0.77，git 2.50.1（Apple Git-155）。每条标了出处：源码 / 实测。所有实测只看“有没有”“能不能打开”，没有读出或打印任何文件内容。

## 1. 起因

[worker-env-2026-10-02.md](worker-env-2026-10-02.md) 第 7 节“还没管的”：终端配置文件禁读了，但家目录下其他常见的登录文件（`~/.netrc`、`~/.git-credentials`、`~/.docker/config.json`、`~/.kube/config` 等）三种隔离都还读得到。这些文件里是主人在别家服务的密码、令牌、私钥，违反“不让选手读密钥”。

## 2. 逐个看：是什么、选手要不要

| 位置 | 里面是什么 | 谁会读 | 结论 |
|---|---|---|---|
| `~/.netrc` | 各网站的用户名和密码 | curl、git（走 https 时）、ftp | 禁读。只在联网时用，选手不联网 |
| `~/.git-credentials`、`~/.config/git/credentials` | git 用 `credential.helper store` 存的明文密码 | 只有 git 的 store 助手，只在推拉远端要密码时读 | 禁读。git 本地操作（status、diff、log、config）不读（实测，第 4 节） |
| `~/.docker`（整个） | `config.json` 的 `auths`、`config.json.bak`、远程 docker 的客户端证书 `*.pem`、`contexts`；还有插件 `cli-plugins` 和后台连接口 `run/docker.sock` | docker 命令 | 禁读整个目录：只禁 `config.json` 会漏掉旁边的备份和证书。`docker --version` 照常能跑；`docker compose`、`docker buildx` 跑不了（插件读不到，实测，第 5 节）。接受这个代价：后台连接口也在里面，选手本来就不该指挥 docker（能挂载整个硬盘，等于逃出隔离），没有后台 compose 也基本没用 |
| `~/.dockercfg` | Docker 旧版的凭据文件，没有 `config.json` 时 docker 还会回退去读 | docker | 禁读 |
| `~/.kube`（整个） | 集群地址、证书、令牌 | kubectl | 禁读 |
| `~/.config/gcloud`（整个） | `credentials.db`、`access_tokens.db`、`application_default_credentials.json` | gcloud、谷歌云的各种库 | 禁读 |
| `~/.azure`（整个） | 微软云登录令牌 | az | 禁读 |
| `~/.gnupg`（整个） | GPG 私钥 | gpg、git 签名提交 | 禁读。选手本来就不提交 |
| `~/.config/op`（整个） | 1Password 命令行的账号配置和后台连接口 | op | 禁读 |
| `~/.config/hub`、`~/.config/glab-cli` | GitHub（hub）、GitLab 命令行的令牌 | hub、glab | 禁读（`~/.config/gh` 早已禁读） |
| `~/.ollama`（整个） | Ollama 的身份私钥 `id_ed25519`、对话历史、模型 | ollama | 禁读。选手连不上本机端口，用不了 Ollama |
| `~/.pypirc` | 发 Python 包的令牌 | twine | 禁读 |
| `~/.gem/credentials` | 发 Ruby 包的令牌 | gem push | 只禁这个文件：`~/.gem` 里还有用户装的 gem |
| `~/.cargo/credentials.toml`、`~/.cargo/credentials`（旧名） | 发 Rust 包的令牌 | cargo publish | 只禁这两个文件：`~/.cargo/bin` 在 PATH 上（本机就是） |
| `~/.terraform.d/credentials.tfrc.json` | `terraform login` 存的令牌 | terraform | 只禁这个文件：`~/.terraform.d` 里还有插件缓存 |
| `~/.pgpass`、`~/.my.cnf` | PostgreSQL、MySQL 的密码 | psql、mysql | 禁读 |
| `~/.vault-token` | HashiCorp Vault 令牌 | vault | 禁读 |
| `~/.huggingface/token`（旧位置）、`~/.cache/huggingface/token`、`~/.cache/huggingface/stored_tokens`（新版存多个具名令牌） | Hugging Face 令牌 | huggingface 库 | 只禁令牌文件：`~/.cache/huggingface` 里是模型缓存 |

测试机上名单里有 4 处是真实存在的（只查有没有），下面的对照就用它们；`~/.gitconfig`、`~/.config/git`、`~/.cargo` 这类不禁的也在。

### 不放进默认名单的

| 位置 | 原因 |
|---|---|
| `~/.gitconfig`、`~/.config/git/config`、`~/.config/git/ignore` | git 每条命令都读。常见做法是 `credential.*.helper` 指向 gh 之类的程序，令牌在 `~/.config/gh` 或钥匙串里（两处都已禁读），`.gitconfig` 本身一般没有钥匙 |
| `~/.terraformrc`、`~/.m2/settings.xml`、`~/.gradle/gradle.properties`、`~/.yarnrc.yml`、Poetry 的 `auth.toml`（macOS 在 `~/Library/Application Support/pypoetry/`） | 常放令牌或仓库密码，但 Terraform、Maven、Gradle、Yarn 每次运行都读配置，Poetry 启动时先查 `auth.toml` 在不在（读不到会报“没有权限”而不是“不存在”），读不到就直接报错，会让这类项目的验收跑不起来。本机都没有。主人放了钥匙的，在设置的“额外禁读的家目录位置”里加 |
| `~/.cargo`、`~/.gem`、`~/.terraform.d` 整个目录 | 里面有程序、包和插件缓存，只禁凭据文件 |

## 3. 三家程序启动时要不要读（源码）

- **Codex**：主进程在隔离外，这些限制只管它跑的命令，不影响它启动和登录。
- **Grok**（整个在 srt 隔离里）：程序里的字符串只在它自己的“敏感文件”名单里出现这些名字（`.netrc`、`.pypirc`、`.pgpass`、`.dockercfg`、`application_default_credentials.json`、`*.kubeconfig` 等，以及它自己的 macOS 隔离配置里禁读的 `.git-credentials`、`.gnupg`），没有启动时去读的用法。
- **Cursor**（整个在 srt 隔离里）：`git-credentials` 只出现在“托管 git 凭据”（`exec-daemon-managed-git-credentials`）那段代码里，`.azure` 只出现在识别 `dev.azure.com` 仓库网址的代码里，都不是本机启动要读的文件。

结论：三家启动都用不着这些文件，禁读不会让它们启动失败。下面实测确认。

## 4. 做法

规则只在 `src/core/sandbox.ts` 一处：新加 `CREDENTIAL_FILES`（24 处），和 `SHELL_FILES` 合成一张家目录禁读名单 `HOME_DENY`，Codex 权限表（`codexPermissions`）和 srt 模板（`sandbox()`）都从它取。`sandbox/*.json` 不重复写。共同规则 `rules.md` 加一句：这些凭据故意读不到，不要设法绕过，要用它们的操作做不了就在报告里写明。

禁读一个本机没有的位置，两种隔离都照常启动，探针报“不存在”（ENOENT），不算数；父目录也不存在的（`~/.terraform.d/credentials.tfrc.json`）同样没问题（实测）。

## 5. 实测

### 对照：加名单前后，同一个只看“能不能打开”的脚本

在三种隔离里各跑一次（Codex 用 `codex sandbox -P xa` 加共用权限表；Grok、Cursor 用 srt 加各自模板），加名单前（把这些规则去掉）和加名单后各一次。同一条命令里再跑 `git status`、`git diff --stat`、`git log`、`git config -l`、`node -v`、`npm -v`、`cargo --version`、`docker --version`（在一个临时 git 仓库里，有一处没提交的改动）：

| | 测试机上存在的 4 处 | git 四条、node、npm、cargo、docker |
|---|---|---|
| 加名单前，三种隔离 | 都能打开 | 都正常 |
| 加名单后，三种隔离 | 都是 EPERM（没有权限） | 都正常，没有多出报错 |

补测 docker 插件（隔离外都正常）：加名单后两种隔离里 `docker compose version`、`docker buildx version` 都失败（插件在 `~/.docker/cli-plugins`）。取舍见第 2 节。

### 自检

自检升到第 6 版，加 `credential-files` 一项：逐个打开 `CREDENTIAL_FILES`（目录看能不能列出，文件用只读方式打开再关上，不读内容），本机有的都要“没有权限”，本机没有的不算数，打开任何一个就是放行。只报个数，不报文件名。

在隔离外用临时登记处跑 `xagents selfcheck`，**通过**：

| 隔离 | credential-files | shell-files | env-secret |
|---|---|---|---|
| codex | 挡住 4 个，本机没有 20 个 | 挡住 9 个，本机没有 3 个 | 看不到 |
| grok | 挡住 4 个，本机没有 20 个 | 挡住 9 个，本机没有 3 个 | 看不到 |
| cursor | 挡住 4 个，本机没有 20 个 | 挡住 9 个，本机没有 3 个 | 看不到 |

### 真派三家只读小题（名单第一版，含 `~/.terraformrc`、不含 `~/.dockercfg` 和 `stored_tokens`；后两者本机没有，改名单后重跑了自检和上面的对照）

用临时登记处和一个只有一次提交的临时仓库，派 Codex · GPT-6 Astra 中档、Grok 4.7 中档、Cursor · Grok 4.7 中档各一道只读题：查 6 个凭据位置（`~/.docker`、`~/.kube`、`~/.config/op`、`~/.ollama`、`~/.netrc`、`~/.git-credentials`）能不能打开（只报能不能、不读内容），再跑 `git status`、`git log`、`node -v`、`git --version`。三家都正常启动、做完（26–40 秒）：

| 选手 | 6 个凭据位置 | git、node |
|---|---|---|
| Codex | 没去试（它看到权限规则里禁读这些路径，就不碰，和终端配置文件那次一样） | 退出码 0 |
| Grok | 全部打不开 | 退出码 0，node v26.5.0，git 2.50.1 |
| Cursor · Grok | 全部打不开 | 退出码 0，node v26.8.1，git 2.50.1 |

临时登记处、临时仓库、副本都已清理，临时登记处移进废纸篓。

## 6. 独立审查

派 Cursor · Grok 4.7 高档独立审了第一版（只读）。采纳：`~/.terraformrc` 每次运行 terraform 都读，和 Maven、Gradle 同类，从默认名单拿掉；补上 `~/.dockercfg`、Hugging Face 的 `stored_tokens`；旧记录的说法改成过去时；补测 `docker compose`。没采纳：Poetry 的 `auth.toml`（见第 2 节）。

## 7. 还没管的

- 名单只收常见的位置。别的程序把钥匙放在家目录别处的（比如各家云的命令行、自己写的 `~/.secrets`），在设置的“额外禁读的家目录位置”里加。
- Terraform、Maven、Gradle、Yarn、Poetry 的全局配置见第 2 节，没放进默认名单。
- srt 隔离能读系统钥匙串的问题照旧（[connect-deepseek-2026-10-02.md](connect-deepseek-2026-10-02.md) 第 5 节）。
