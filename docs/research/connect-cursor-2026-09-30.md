# Cursor（编辑器 + 命令行 cursor-agent）的技能、全局规矩、钩子调研

调研日期：2026-09-30。本机 cursor-agent 版本 2026.09.28-64d2043。
标记说明：**文档** = cursor.com/docs 官方文档；**实测** = 本机真跑出来的；**源码** = 读了本机 cursor-agent 的打包代码（`~/.local/share/cursor-agent/versions/2026.09.28-64d2043/`，只读）；**未查清** = 没有证据。
出处网址：
- 技能 https://cursor.com/docs/context/skills
- 规矩 https://cursor.com/docs/context/rules
- 钩子 https://cursor.com/docs/hooks
- 第三方钩子 https://cursor.com/docs/reference/third-party-hooks
- 命令行 https://cursor.com/docs/cli/using 、/docs/cli/reference/parameters 、/docs/cli/reference/configuration

实测总共用了 5 次模型调用（claude-sonnet-5-5-medium），都在临时目录里。

---

## 0. 先说结论（给负责人看）

1. **技能**：Cursor 命令行和编辑器都会读 `~/.claude/skills`，所以现成的 `~/.claude/skills/<某个用户技能>` 已经在 Cursor 的技能清单里，不用另装。但**清单里每条说明会被砍到只剩约 27 个字符**（技能较多时的实测结果），所以技能能不能被想起来，主要靠"目录名 + 说明开头 27 个字"。
2. **全局规矩**：Cursor 的 User Rules 存在云端账号设置里，不是本机文件；命令行 `-p` 模式也会带上（实测）。本机文件形式的"全局规矩"：命令行会从工作目录一路往上，每一级目录都读 `.cursor/rules/*.mdc`、`AGENTS.md`、`CLAUDE.md`（源码）。所以只要选手/负责人的工作目录在家目录之下，`~/AGENTS.md`、`~/CLAUDE.md`、`~/.cursor/rules/*.mdc` 就会生效（源码，未实测）。
3. **压缩后**：规矩清单、技能清单、用户规矩、会话开始钩子注入的话，都放在对话第一条"初始上下文"消息里，压缩（摘要）时这条**原样保留**，只把后面的对话换成摘要（实测：读一份本机真实压缩过的聊天存储结构）。丢的是对话里读过的东西（比如读过的技能正文、`xagents guide` 的输出）。
4. **钩子**：`~/.cursor/hooks.json` 存在，命令行 `-p` 模式真的会执行钩子（实测：项目级）。能拦下 shell 命令，**但命令行版只把 `user_message` 交给模型，`agent_message` 被丢掉**（实测 + 源码），和文档说的不一样。所以要让模型看到理由，得写在 `user_message`。
5. **选手视角**：选手的 cursor-agent 会加载用户级技能、钩子、用户规矩，`-p` 模式没有任何参数能关掉；`CURSOR_CONFIG_DIR` 只能搬走 `cli-config.json`、`chats`、`statsig-cache.json`，搬不走技能/钩子/规矩（实测）。
6. **逃出隔离**：选手若能写 `~/.cursor/hooks.json`，主人以后在隔离外打开 Cursor 或运行 cursor-agent，钩子命令会以主人的账号、不受隔离限制地自动执行，还没有确认弹窗。这是**真实的口子**，建议把 `~/.cursor` 整体改成只读（可行做法见第 4 节）。

---

## 1. 技能

### 1.1 从哪些目录读

| 目录 | 结论 | 依据 |
|---|---|---|
| `~/.cursor/skills/` | 读（用户级） | **文档** + **实测**：用户级技能出现在 `-p` 模式技能清单 |
| `~/.cursor/skills-cursor/` | Cursor 自带技能，由 Cursor 同步管理，不要手放东西。有 `.sync-manifest.json`（记录同步时间） | **文档**（"Built-in Cursor skills ... managed by Cursor"）+ **源码**（`skills-cursor` 标了 `builtin:true`）+ **实测**清单里可见 |
| `~/.agents/skills/` | 读 | **文档** + **实测**（该目录的技能出现在清单） |
| `~/.claude/skills/` | 读（含子目录里的 `synced/...`，会递归找 SKILL.md） | **文档**（"for compatibility ... `~/.claude/skills/`"）+ **实测**：`~/.claude/skills/<某个用户技能>` 出现在清单 |
| `~/.codex/skills/` | 读 | **文档** + **实测**（该目录的技能出现在清单） |
| `~/.grok/skills/` | 读（文档没写） | **源码**（目录表里有 `.grok/skills`）+ **实测**：`~/.grok/skills/<某个用户技能>` 出现在清单 |
| 项目 `.cursor/skills/`、`.agents/skills/`、`.claude/skills/`、`.codex/skills/` | 读；子目录里的也读，嵌套目录里的技能只在处理那个目录下的文件时才露出 | **文档** + **实测**：四个 `zz-*` 探针技能全部出现在清单 |
| `~/.claude/plugins/cache/.../skills/`（Claude 插件里的技能） | 也读 | **实测**：某个 Claude 插件的技能出现在清单（文档没写这一条） |

- 文档说明"Include Third-Party Plugins, Skills, and Other Configs"设置默认开着（**文档**，在第三方钩子页面）。命令行里没有找到关掉它的参数或环境变量（`--help` 没有；源码里判断函数的来源没查到）：**未查清**。
- 技能名 = 含 SKILL.md 的文件夹名（**文档**）。

### 1.2 名字和说明是不是每轮都在上下文里；压缩后还在不在

- **在**。技能清单放在对话第一条"初始上下文"用户消息里的 `<agent_skills><available_skills>` 块中，每条是"SKILL.md 的完整路径 + 说明"。模型要用时得自己用 Read 工具读 SKILL.md（提示词原话："read the skill file at the provided absolute path using the Read tool ... IMMEDIATELY as your first action"）。**实测**（读 `~/.cursor/chats/.../store.db` 里存下来的真实提示词）。
- **压缩后还在**：**实测**。检查了一份发生过压缩的聊天存储（有过压缩，里面有 `<summary>` 消息）：对话状态的消息序列是 `[系统提示, 初始上下文消息, 摘要消息, 后面的新消息…]`，"初始上下文消息"的内容哈希和压缩前是同一个。也就是技能清单、规矩、用户规矩、会话开始钩子注入的内容，压缩后原样还在。压缩由服务端触发（源码里 `preCompact` 是服务端发给客户端的请求）。
  - 没做到：自己**触发**一次压缩。`-p` 模式里的 `/summarize` 不是压缩命令，而是被当成技能名去调用了某个用户技能（**实测**）。所以非交互触发压缩的办法：**未查清**（文档只说交互界面里有 `/summarize`，别名 `/compress`）。
- **会丢什么**：对话中途读进来的技能正文、`xagents guide` 的输出，压缩后只剩摘要里的转述。所以"名字清单还在，但内容忘了"，需要靠机制重新读（见第 5 节）。

### 1.3 说明有没有字数上限

- **文档**：Cursor 的技能页没写上限（`description` 必填，"Used by the agent to determine relevance"）。
- **实测**：技能较多时，**几乎每条说明被砍成开头约 27 个字符 + "..."**。我的探针技能 "Probe skill. Secret word for..." 也被砍。其中某个技能保留了完整 95 个字符（为什么它例外：**未查清**）。
- 砍多少是不是随技能数量变化、总预算是多少：**未查清**（提示词是服务端拼的，本机代码里找不到预算常数；我没有多余的模型调用做对照）。
- 结论：技能多的机器上，"什么时候用"的触发词必须放在**目录名**和**说明的头 25 个字**里。

### 1.4 其他技能行为
- `disable-model-invocation: true` 的技能只能手动 `/名字` 调用；`paths` 可限定文件范围；技能可以做成 Custom Mode 常驻（**文档**）。
- `-p` 模式里 `/技能名 参数` 会被当成技能调用（**实测**，见上）。

---

## 2. 全局规矩

### 2.1 User Rules 存哪
- **文档**：User Rules 在 **Customize → Rules**（旧版是设置里的 Rules for AI）里设置，"User rules are also not migrated since they are not stored on the file system"（技能页原话），即**不是本机文件**，是账号侧设置。只用于 Agent（Chat），不用于 Cmd+K 行内编辑。
- **命令行读不读**：**读**。**实测**：`-p` 模式提示词里有 云端 User Rules，在完全空的项目里也在。

### 2.2 有没有本机文件形式的全局规矩
- `~/.cursor/rules/*.mdc`、`~/.cursor/AGENTS.md`：**文档**里没有说这两个是全局规矩。
- **源码**（命令行 `LocalCursorRulesService.loadRulesFromDirAndAncestors`）：从工作目录开始，**一直往上走到根目录**，每一级目录都读 `<目录>/.cursor/rules/**/*.mdc`、`<目录>/AGENTS.md`，第三方读取开着时还读 `<目录>/CLAUDE.md`、`<目录>/CLAUDE.local.md`。因此：
  - 只要工作目录在 `/Users/<你>/...` 之下，`~/AGENTS.md`、`~/CLAUDE.md`、`~/.cursor/rules/*.mdc` 都会被读到（**源码，未实测**）。
  - 命令行**不读** `~/.claude/CLAUDE.md`（源码里没有这一项）。
  - 工作目录在 `/tmp` 或别处（比如派活工作台的副本）时，这些家目录文件不会被读。
- 环境变量 `CURSOR_CONFIG_DIR` 改不了这些位置（**实测**，见 4.1）。

### 2.3 项目级怎么读
- **实测**（`-p`，探针项目）：`.cursor/rules/probe.mdc`（alwaysApply:true）、`AGENTS.md`、`CLAUDE.md` 三个暗号都进了提示词 `<rules><always_applied_workspace_rules>`，来源标注各不相同。
- **文档**：命令行"reads AGENTS.md and CLAUDE.md at the project root (if present)"；嵌套子目录的 AGENTS.md 在处理该目录文件时叠加；`.cursor/rules` 里只认 `.mdc`，`.md` 被忽略；`alwaysApply: true` 每轮都带，"Apply Intelligently"只给模型看 description。
- 优先级：Team Rules → Project Rules → User Rules（**文档**）。

### 2.4 压缩后规矩还在不在
- **在**（同 1.2，规矩块在初始上下文消息里，压缩时原样保留；**实测**读存储结构，未自己触发压缩）。这也是三种手段里最稳的一种：`alwaysApply` 的规矩、AGENTS.md、用户规矩都不依赖对话历史。

---

## 3. 钩子（hooks）

### 3.1 位置、格式、事件
- **文档**：四级配置，优先级 Enterprise > Team > Project > User，全部会跑，结果合并（任何一个 deny 胜出）：
  - 企业：macOS `/Library/Application Support/Cursor/hooks.json`（Linux `/etc/cursor/hooks.json`）
  - 项目：`<项目根>/.cursor/hooks.json`（命令从项目根运行，写 `.cursor/hooks/x.sh`）
  - 用户：`~/.cursor/hooks.json`（命令从 `~/.cursor/` 运行，写 `./hooks/x.sh`）
- **源码**确认：命令行里用户级路径就是写死的 `homedir()/.cursor/hooks.json`，不受 `CURSOR_CONFIG_DIR` 影响；另外还会读 `~/.claude/settings.json`、`<项目>/.claude/settings.json`、`settings.local.json` 里的 Claude Code 钩子（按名字映射，如 PreToolUse→preToolUse、PreCompact→preCompact、SessionStart→sessionStart）。用户若装了其他 Claude 钩子，选手的 cursor-agent 也会加载它们。
- 格式：`{"version":1,"hooks":{"事件名":[{"command":"...","timeout":30,"matcher":"正则","failClosed":true,"type":"command|prompt"}]}}`。
- 事件（**文档**）：`sessionStart`、`sessionEnd`、`preToolUse`、`postToolUse`、`postToolUseFailure`、`subagentStart`、`subagentStop`、`beforeShellExecution`、`afterShellExecution`、`beforeMCPExecution`、`afterMCPExecution`、`beforeReadFile`、`afterFileEdit`、`beforeSubmitPrompt`、`preCompact`、`stop`、`afterAgentResponse`、`afterAgentThought`；Tab 用的 `beforeTabFileRead`、`afterTabFileEdit`；`workspaceOpen`（打开工作区时触发，文档写明"编辑器和命令行都跑"）。
- 退出码：0 用 JSON 输出；**2 = 拦下**；其他非零 = 失败但放行（默认"失败放行"，加 `failClosed:true` 才改成失败也拦）。权限类钩子输出不是合法 JSON 会直接拦下（**文档**）。

### 3.2 能不能拦 shell 命令、理由给不给模型
- 能拦：`beforeShellExecution` 输出 `{"permission":"deny","user_message":"...","agent_message":"..."}`。
- **实测（命令行 -p，--force）**：命令被拦，`echo zz-blocked` 没有执行。模型收到的原文是：
  `Rejected: Command execution was blocked by a hook: USERMSG-blocked` + `To view or modify configured hooks, go to Cursor Settings > Hooks.` + `Agent note: Do not suggest workarounds to the blocked tool.`
  我在 `agent_message` 里放的暗号 `BLOCKED-BY-HOOK-REASON-PURPLE-917` **模型没收到**。**源码**确认：命令行里拒绝文案只用 `user_message`（`j("Command execution", i.user_message)`）。所以：**给模型的话必须写进 `user_message`**；末尾还会被强行加一句"不要建议绕过办法"。（文档说 `agent_message` 会发给模型，这是编辑器行为，命令行版本不同。）
- 钩子输入（实测）含：`command`、`cwd`（命令行里是空字符串）、`sandbox:false`、`conversation_id`、`model`、`workspace_roots`、`user_email` 等。
- 其他注入手段：
  - `sessionStart` 输出 `{"additional_context":"..."}` 会进初始上下文的 `<hooks_context>` 块（**实测**：暗号 HOOKCTX-GAMMA-880 模型看到了，来源标为 hooks_context）。它随初始上下文消息一起，压缩后还在（结论同 1.2）。文档写明该钩子"fire-and-forget"，不能阻止会话。
  - `postToolUse`/`postToolUseFailure` 输出 `additional_context` 会在工具结果后追加给模型（**文档**；命令行工具结果里有 `hookAdditionalContexts` 字段，**实测**看到，但未专门测内容）。
  - `stop` 钩子输出 `followup_message` 会自动发下一条用户消息（**文档**，默认最多连发 5 次）。
- `preCompact`：**文档**说是"观察性"的，不能阻止或修改压缩，只能返回 `user_message` 给用户看。**源码**里命令行处理服务端发来的 preCompact 请求并执行钩子。我**没能触发压缩**，所以命令行里 preCompact 是否真的触发：**未实测**。它可以用来在压缩前把"已读指南"的标记文件删掉（见第 5 节）。

### 3.3 命令行 cursor-agent 是否执行钩子
- **实测：执行**。项目级 `.cursor/hooks.json` 的 `sessionStart`、`beforeShellExecution` 在 `cursor-agent -p` 下都真的跑了（钩子脚本写了日志，工作目录=项目根，环境变量有 `CURSOR_PROJECT_DIR`）。
- **用户级 `~/.cursor/hooks.json` 命令行是否执行**：**没有实测**（铁律不让动 `~/.cursor`；用 `CURSOR_CONFIG_DIR` 或假 HOME 都不行，见 4.1）。但**源码**里加载器对 `userConfigPath` 与 `projectConfigPath` 用同一套代码，且用户级不看任何信任条件，我判断会执行。
- **项目级要不要信任**：**文档**说"Project hooks run in any trusted workspace"。**实测**：`-p` 模式**不加 `--trust`** 时（全新目录，`~/.cursor/projects/<目录>/` 下没有 `.workspace-trusted`），项目里的钩子、规矩、技能**照样全部生效**。也就是说命令行 `-p` 下项目钩子不受信任标记限制；源码里 `loadProjectHooks` 默认就是真。

---

## 4. 选手视角

### 4.1 选手的 cursor-agent 会不会加载；有没有关闭办法
（a）**会**。在 `-p` 模式下，全部**实测/源码**证实会加载：
- 用户级技能：`~/.cursor/skills`、`~/.claude/skills`、`~/.agents/skills`、`~/.codex/skills`、`~/.grok/skills`（实测都在清单里）。
- 用户规矩：云端 User Rules（实测）；家目录祖先目录的规矩文件（源码）。
- 用户级钩子：`~/.cursor/hooks.json`（源码）、`~/.claude/settings.json` 的钩子（源码）。
- **没有**参数关掉它们：`cursor-agent --help` 里没有 `--no-skills` / `--bare` 之类。可用的相关开关只有 `--plugin-dir`（加载额外插件）、`--sandbox`、`--trust`。
- 环境变量：
  - `CURSOR_CONFIG_DIR`（**实测**）：只把 `cli-config.json`、`chats/`、`statsig-cache.json` 搬到新目录，登录状态不受影响（`status` 仍显示已登录，登录信息不在这个目录里）；但技能（`~/.cursor/skills` 仍被读到，新目录里的 `zz-userskill` 没被读到）、用户级钩子（新目录里的 `hooks.json` 没触发）、规矩（新目录里的 `rules/*.mdc` 没进提示词）**都不跟着搬**。
  - `CURSOR_DATA_DIR`（**源码**：`projects/` 目录，含 `.workspace-trusted`、agent-transcripts 等，默认 `~/.cursor`）：未实测。实测里 `projects/<目录>` 仍写进了真实 `~/.cursor/projects`（因为我没设这个变量）。
  - 改 `HOME`：会丢登录（`HOME=空目录 cursor-agent status` → "Not logged in"，实测），不可用作隔离。
- 所以：**用环境变量挡不住加载**；能做的是让派活工作台的隔离把 `~/.cursor/{hooks.json,hooks,skills,rules,mcp.json,...}` 设为只读，并把会变的东西（`cli-config.json`、`chats`、`projects`）用 `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` 挪到每次运行的临时目录（第二个变量未实测）。

（b）**逃出隔离**：分析如下，没有去试。
- **确切路径**：`~/.cursor/hooks.json`（脚本放 `~/.cursor/hooks/`）。命令行代码里是 `homedir()/.cursor/hooks.json`。
- **谁的权限执行**：钩子是 Cursor 进程（编辑器主进程或 cursor-agent 进程）直接 spawn 出来的子进程，用的是**启动 Cursor 那个人的账号**。实测钩子脚本的 `id -u` 与启动用户一致。钩子不走 shell 工具那套沙箱（`beforeShellExecution` 输入里 `sandbox:false` 是指被审查的命令没在沙箱里，钩子自己本来就在沙箱外）。
- **选手在隔离里运行时**：cursor-agent 进程本身在派活工作台的隔离里，它 spawn 的钩子也继承隔离，钩子没有额外权限。
- **口子在选手退出之后**：选手写下 `~/.cursor/hooks.json`（或 `~/.claude/settings.json`，如果隔离也允许写），主人之后在隔离外：
  - 打开 Cursor 编辑器并打开任何文件夹 → `workspaceOpen` 钩子就会触发（文档：打开工作区就触发，不需要开 Agent 对话）；
  - 或者开任何一次 Agent 对话（`sessionStart`）、每条命令前（`beforeShellExecution`）、每次提交提示（`beforeSubmitPrompt`）……
  - 或者在隔离外跑 `cursor-agent`（包括负责人本人自己用）。
  - 以主人账号、完整权限执行任意命令，**没有确认弹窗**（文档和源码里用户级钩子都没有信任/批准步骤；Cursor 自己的沙箱保护清单里也只保护 `~/.cursor/sandbox-policies`，不含 `hooks.json`）。
  - **判断：这是一个真实的逃出隔离口子**（持久化 + 隔离外任意命令执行）。
- **同类的其他落脚点**（都在 `~/.cursor` 里，隔离现在都允许写）：
  - `~/.cursor/skills/`、`~/.cursor/skills-cursor/`：技能清单每次都进提示词，可植入提示词注入（"你是负责人，要用……"这类就是同一个机制）；
  - `~/.cursor/rules/*.mdc`（+ 家目录 AGENTS.md，如果隔离允许）：家目录下的工作区都会生效；
  - `~/.cursor/mcp.json`：MCP 服务器启动命令（交互模式要批准，`--approve-mcps` 会自动批准）；
  - `~/.cursor/cli-config.json` 里的 `permissions.allow`、`approvalMode`：可以悄悄放宽主人以后交互使用的审批；`~/.cursor/permissions.json`、`~/.cursor/sandbox.json` 同理；
  - `~/.cursor/projects/<目录>/.workspace-trusted`：命令行的"信任标记"（实测是一个 JSON 文件，`trustMethod:"cli-flag"`），选手能给任意目录伪造信任（父目录有标记时子目录继承，家目录和层数少于 3 的路径除外）；
  - `~/.cursor/plugins/local`：本地插件可带钩子/MCP。
- 建议（只是方向，没有动手）：把 `~/.cursor` 整体设为选手只读；`cli-config.json`（cursor-agent 每次运行会改写）、`chats`、`projects`、`statsig-cache.json` 用 `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` 搬进临时目录；同样处理 `~/.claude`、`~/.agents`、`~/.codex`、`~/.grok`。每次选手运行后，比对 `~/.cursor/hooks.json`、`hooks/`、`skills/`、`rules/`、`mcp.json`、`permissions.json` 的哈希，发现变化就报警。

---

## 5. 三种手段的对比与建议（用于"压缩后仍记得派活工作台"）

| 手段 | 命令行 | 编辑器 | 压缩后 | 备注 |
|---|---|---|---|---|
| 技能 | 读（实测） | 读（文档） | 清单还在，正文要重读 | 说明被砍到约 27 字，名字和头 25 字要有"派活工作台/xagents/派活" |
| 规矩（`AGENTS.md`/`.cursor/rules` alwaysApply） | 读（实测） | 读（文档） | 还在（实测存储结构） | 只对工作目录在其下的项目生效；全局要靠云端 User Rules（不是文件，只能手动去设置里改）或家目录祖先文件（源码） |
| 钩子 | 项目级实测有效；用户级源码支持 | 文档 | 不受压缩影响（是程序在跑，不是模型记忆） | 拦命令的理由要写 `user_message`；能做"没读指南就拦" |

推荐组合（供主人和负责人决定）：
1. 规矩里放一条很短的固定话："先运行 `xagents guide`"（最稳，压缩后原样还在）。
2. 若已有用于派活的用户技能，可复用 Cursor 会读取的 `~/.claude/skills/`，把说明前 25 个字写成"派活工作台 xagents：派活给 Codex/Grok/Cursor"。
3. 需要"压缩后重新读"时：用 `preCompact` 钩子删掉标记文件 + `beforeShellExecution` 钩子在标记不存在时拦下命令，并在 `user_message` 里写"请先运行 xagents guide"。（`preCompact` 命令行是否触发没实测；若不触发，可退而求其次：`beforeShellExecution` 里按"距上次读指南是否超过 N 分钟/N 次命令"来判断。）
4. 不要把上述钩子/技能装进选手能读到的用户级位置，除非能接受选手也被影响（选手会被同样的技能清单和钩子影响，钩子还会拦选手自己的 shell 命令）。项目级 `.cursor/hooks.json` 只放在负责人自己用的仓库里，派活工作台给选手的副本里要排除它。

---


## 6. 没查清 / 没实测的清单

- 自己触发一次压缩（`-p` 下没有办法）；命令行里 `preCompact` 钩子是否真的触发。
- 用户级 `~/.cursor/hooks.json` 在命令行里的实际执行（只有源码和文档支持）。
- 家目录祖先目录的 `AGENTS.md`/`CLAUDE.md`/`.cursor/rules` 是否生效（只有源码）。
- 技能说明被砍的预算算法（为何个别技能例外，与技能数量的关系）。
- 有没有办法在命令行关掉"第三方读取"（`.claude`/`.codex`/`.grok` 技能和钩子、`CLAUDE.md`）。
- `CURSOR_DATA_DIR` 能否把 `projects/` 搬走。
- 编辑器（IDE）侧全部结论只有文档依据，没有本机实测（本机没有用 IDE 跑）。
