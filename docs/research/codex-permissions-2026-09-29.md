# Codex 权限档：堵上“读整台电脑”的缺口（2026-09-29 研究）

**结论：能堵上。** 用 Codex 的权限档（permissions profile），可以只禁读指定的目录和文件；其余照旧：系统文件和副本能读，副本和临时目录能写，完全不联网（包括 127.0.0.1 和本机的 ssh-agent 这类通道）。

这份研究由子代理完成，依据是 OpenAI 官方文档和 Codex 源码，并在临时目录里逐项实测。

## 要点

- **自定义档**写在 `[permissions.<名字>]`，再用顶层 `default_permissions = "<名字>"` 选中。可以用 `extends` 继承内置的 `:workspace`（写副本和临时目录）或 `:read-only`。
- **文件规则**写在 `filesystem` 表里：`路径 = "read" | "write" | "deny"`。`deny` 同时禁读禁写，而且优先于同级的放行规则；更具体的路径可以在已禁的目录里重新开口。
- **网络**：`network.enabled` 缺省是 `false`，即全断。
- **旧写法冲突**：命令行里的 `-s/--sandbox`，或配置里的 `sandbox_mode`，会让权限档被**悄悄忽略**。所以必须去掉 `-s`。
- **`codex exec`**：它没有 `-P` 参数，要用两条 `-c`：
  - 一条选档：`-c 'default_permissions="xa"'`
  - 一条定义档，必须写成内联表：`-c 'permissions.xa={extends=":workspace",filesystem={...}}'`

  不能用点分写法，因为路径里的点号会被切开。

  `--ignore-user-config` 会把用户配置换成空表（用户配置不会被加载），但登录信息仍从 `~/.codex/auth.json` 读，而且是在沙箱外的主进程里读，所以禁读 `~/.codex` 不影响登录。
- **`codex sandbox`**（给自检探针用）：必须用 `-P <档名>`，并且没有 `--ignore-user-config`。所以要配一个空的临时 `CODEX_HOME`，再用同一张表：

  ```
  CODEX_HOME=<空的临时目录> codex sandbox -P xa -C <副本> -c 'permissions.xa={同一张表}' -- <命令>
  ```

  命令前的 `--` 不能省。
- **`~/.codex/tmp` 要重新开口**：沙箱里的程序查找路径含 `~/.codex/tmp/arg0/...`，这是 Codex 自带的辅助命令。

## 推荐的禁读名单

- `~/.ssh`
- `~/.codex`（其中 `~/.codex/tmp` 设为 read，重新开口）
- `~/.grok`
- `~/.cursor`
- 用户自己的私有目录（通过 `denyReadHome` 配置）
- `~/.aws`
- `~/.claude`
- `~/.config/gh`
- `~/.npmrc`（实测在沙箱里可读，里面可能有令牌）
- 项目设置里的 `denyReadExtra`

## 实测（`codex sandbox`，本机 codex 0.158.0-alpha.2.1）

| 项目 | 现状（`-s workspace-write`） | 推荐的禁读名单 |
|---|---|---|
| 副本内写、临时目录写 | 通过 | 通过 |
| 主目录写 | 拒 | 拒 |
| 读 `~/.ssh`、`~/.grok/auth.json`、`~/.cursor/cli-config.json`、`~/.codex/auth.json` | **通过（缺口）** | 拒 |
| 读 `/etc/hosts`、`ls /usr/bin` | 通过 | 通过 |
| 连 127.0.0.1:9222、本机自建端口、外网 | 拒 | 拒 |
| 在 git 副本里 `status` / `add` / `commit` | 正常 | 正常 |

白名单写法（`":root"="deny"`）也能挡住主目录，但 git 会因为读不到 `~/.gitconfig` 而失败，`~/.nvm`、`/opt/homebrew` 也会读不了，所以**不用**。

## 还没验证的

- `codex exec` 没有真跑过，兼容性是根据文档和源码判断的。上线后要用一个真实的小活确认：派一道题，让它去读 `~/.ssh`，确认读不到。
- 副本里如果自带 `.codex/config.toml`，理论上不会被读进来（因为是否读取要看信任记录，而信任记录存在被忽略的用户配置里），但没有实测。

## 依据（查看日期均为 2026-09-29）

- https://developers.openai.com/codex/permissions（现在跳转到 https://learn.chatgpt.com/docs/permissions）
- https://developers.openai.com/codex/config-reference.md
- openai/codex 源码，标签 `rust-v0.158.0`：
  - `codex-rs/exec/src/lib.rs`：约 328 行，约 578 行
  - `codex-rs/core/src/config/mod.rs`：`resolve_permission_config_syntax`
  - `codex-rs/config/src/loader/mod.rs`：约 511 行

## 补记 2026-09-30：技能目录和选手手上的工具（codex-cli 0.158.0-alpha.2.1）

用现在的启动参数（`--ignore-user-config` 加那组 `--disable`），在只读临时目录里问了几个不用工具就能答的问题：
- **技能**：Codex 启动时会扫描 `~/.codex/skills`（日志里有两行格式不对的“加载失败”），但模型说系统说明里没有任何技能，工具清单里也没有技能相关的工具。另外，隔离规则挡住了整个 `~/.codex`，选手跑的命令读不到技能文件。加 `--disable skill_search`、`--enable skip_host_skill_discovery` 前后结果一样，所以**不改启动参数**。
- **选手手上的工具**：跑命令、改文件、看图、目标、问用户、`web__run`（网页搜索）、生成图片、子代理一组（`collaboration.*`）。加 `--disable image_generation` 能去掉生成图片；加 `--disable multi_agent` 去不掉子代理那组。子代理和选手在同一个隔离、同一份额度里。暂不改，有新的需要时再附探针改动。
- 工具清单是模型自己报的，只能当参考。
