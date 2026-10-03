# 接入 DeepSeek：借 Codex 跑（实测，2026-10-02）

本机版本：codex-cli 0.159.0。每条标了出处：文档 / 实测。

## 1. 结论

- DeepSeek 没有给编程工具用的“会员登录”，只能用 API 钥匙按用量扣钱。
- 用 Codex 程序跑 DeepSeek 模型：DeepSeek 官方为 Codex 做了适配（文档：api-docs.deepseek.com 的 Codex 接入页，要求 Codex ≥ 0.144，`wire_api = "responses"`）。这样沿用 Codex 那套已实测的隔离，不新开隔离。
- 钥匙交给 Codex 自己保管，放在派活工作台单独的 Codex 文件夹（`<登记处>/deepseek`，用 `CODEX_HOME` 指过去），**不碰主人 `~/.codex` 里的 ChatGPT 登录**。各系统通用，平台自己不存钥匙。
- 只开高档：DeepSeek 自报的强度只有 low、high、max，超高档会被换算成 max（拉满），违反底线。
- 另有一个 GitHub 上的旧接入说明（awesome-deepseek-agent 的 codex.md）要在本机开转发程序（本机端口），不用。

## 2. 模型和强度

- 实测 `GET https://api.deepseek.com/models`：
  - `deepseek-v4-pro`（DeepSeek-V4-Pro，只收文字）
  - `deepseek-flash`（DeepSeek-V4.1-Flash，收文字和图片，2026-09-10 上线）
  - 两个都是上下文 1,048,576，`effort.supported_levels = ["low","high","max"]`，默认 high。
- 实测 `POST /responses` 时 `reasoning.effort` 收 `none minimal low medium high xhigh ultra max`，其他值报 422。回包原样回显传入的档位，看不出换算。
- 第三方资料（不是官方文档）：low、medium 换算成 high，xhigh 换算成 max。
- 结论：只开 `high`。中档等于高档，没有意义；超高档等于拉满。

## 3. 登录：单独的 Codex 文件夹（实测）

- `CODEX_HOME=<单独文件夹> codex login --with-api-key`（钥匙从标准输入给）：
  - 写出的是该文件夹里的 `auth.json`，`login status` 显示 “Logged in using an API key”。
  - 主人自己的 `codex login status` 前后都是 “Logged in using ChatGPT”，`~/.codex/auth.json` 的修改时间和大小不变。
- 派活时提供方写 `requires_openai_auth=true`（用这份 API 钥匙登录），再加上 `forced_login_method="api"`，实测能连上 DeepSeek 干活。
- 登录和派活都固定 `cli_auth_credentials_store="file"`：钥匙不进系统钥匙串，免得和主人自己的 Codex 登录混在一处。
- `--ignore-user-config` 照旧（跳过该文件夹里的 config.toml）。会话记录也写进这个文件夹，不混进主人的 `~/.codex/sessions`，不会扰乱 Codex 周额度的读数。
- 命令：`xagents login deepseek`。在终端里粘贴时不回显，钥匙只经标准输入转给 Codex。

## 4. 隔离（实测，同派活时的 Codex 权限档）

在 Codex 隔离里让 DeepSeek 选手逐条运行，从原始记录核对确实跑过：

| 项 | 结果 |
|---|---|
| 环境变量里带钥匙的那一项 | **不显式去掉时看得到**；加 `shell_environment_policy.exclude=[…]` 后看不到 |
| `ps -E` 看别的进程的环境变量 | 看不到钥匙 |
| 外网（curl api.deepseek.com） | 连不上 |
| 读 `~/.ssh`、`~/.codex` | Operation not permitted |
| 写 `/tmp` | Operation not permitted |
| 写副本 | 可以 |
| 读系统钥匙串（`security find-generic-password`） | 读不到 |

- 启动参数里要一直带 `shell_environment_policy.exclude=["OPENAI_API_KEY","CODEX_API_KEY","DEEPSEEK_API_KEY"]`：现在钥匙走登录文件、不走环境变量，这一条是双保险。
- `<登记处>/deepseek` 对三种隔离一律禁读（Codex 权限表、srt 模板），自检加了 `login-deepseek` 探针（自检第 4 版）。

## 5. 顺带发现：srt 隔离能读系统钥匙串（另开待办）

- 实测：在 Grok、Cursor 用的 srt 隔离里，`security find-generic-password -s <名字> -w` 能读出用 `security` 命令存进去的钥匙。Codex 的隔离读不到。
- 原因：srt 0.0.77 的 macOS 隔离配置固定放行 `com.apple.SecurityServer` 和 `com.apple.securityd.xpc` 两个系统服务（`dist/sandbox/macos-sandbox-utils.js`），设置里只能多放行、不能收回。
- 和 DeepSeek 无关（DeepSeek 的钥匙不放在钥匙串里），另开一件修。
- 已修：三种隔离都禁读钥匙串文件夹，自检加了钥匙串探针，见 [keychain-2026-10-02.md](keychain-2026-10-02.md)。

## 6. 还没做（简单版不做）

- 查余额、余额不足停派：DeepSeek 有 `GET /user/balance`（返回 `is_available` 和各币种余额），简单版不接，钱用完时 DeepSeek 自己报错。
- 模型说明文件：Codex 不认识 DeepSeek 的模型，会提示 “Model metadata … not found” 并用默认参数；能正常干活，以后可以给一份 `model_catalog_json`。
- `xagents models` 不核对 DeepSeek 的模型名（不在 Codex 自带的列表里）。
