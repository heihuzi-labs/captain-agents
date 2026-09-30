# Codex 三种手段调研：技能 / 全局规矩文件 / 钩子

调研日期 2026-09-30。本机 Codex 版本：`codex-cli 0.159.0`（使用本机的 `codex`）。
标注说明：【文档】官方文档；【实测】本机命令与输出；【源码】openai/codex 的 GitHub 源码（main 分支）；【未查清】。

官方文档现在的地址：`developers.openai.com/codex/*` 会 308 跳转到 `learn.chatgpt.com/docs/*`。
- 技能：https://learn.chatgpt.com/docs/build-skills （原 developers.openai.com/codex/skills）
- 规矩文件：https://developers.openai.com/codex/guides/agents-md
- 钩子：https://learn.chatgpt.com/docs/hooks （原 developers.openai.com/codex/hooks）

## 一句话结论

压缩之后，技能清单和 ~/.codex/AGENTS.md 都还在，而且是实测过的：压缩后的下一轮，Codex 会把这两样原样重新塞回请求开头。钩子也是真有：`PreToolUse` 能拦下 shell 命令并把理由交给模型，实测成功；还有专门的“压缩后”事件。三者里，规矩文件最稳；技能是“清单常驻、正文按需读”，要靠说明写得好才会被想起；钩子最硬（能真拦、能压缩后补话），但配置和信任步骤最多。

---

## 1. 技能（skills）

### 1.1 从哪些目录读【文档】+【实测】
文档表格：
- 仓库级：`$CWD/.agents/skills`、`$CWD/../.agents/skills`、`$REPO_ROOT/.agents/skills`（从当前目录一路向上扫到仓库根，每层都扫）
- 用户级：`$HOME/.agents/skills`
- 管理员级：`/etc/codex/skills`
- 系统内置：随 Codex 打包（`~/.codex/skills/.system`）
- 支持符号链接。
- 文档原话：同名技能“不合并，两个都可能出现在选择器里”。文档没写谁覆盖谁，也就没有“优先级覆盖”这回事，只是都列出。

实测（`codex debug prompt-input "hello"`，在临时仓库里）输出的“Skill roots”表：
```
r0 = ~/.codex/skills
r1 = ~/.agents/skills
r2 = ~/.codex/skills/.system
r3..r6 = ~/.codex/plugins/cache/...（插件带的技能）
r7 = <临时仓库>/.agents/skills
```
也就是：`~/.codex/skills`（文档没列，但本机实际在读，也是 Codex 自己安装技能的位置）、`~/.agents/skills`、系统内置、插件缓存、仓库里的 `.agents/skills` 都会读。
未实测：`.codex/skills`（仓库内）——文档没提，别用；仓库级请用 `.agents/skills`。

### 1.2 名字和说明是否每次对话都进上下文【文档】+【实测】
是。文档：“Codex 先只带每个技能的名字和说明，模型决定用时才读完整 SKILL.md”（progressive disclosure）；Codex 的初始清单还带每个技能的文件路径。

实测：`codex debug prompt-input` 显示，请求的第一条就是一条 `developer` 消息，包着 `<skills_instructions>`，内容是“Skill roots”表和 “Available skills” 列表，形如
`- zz-probe-skill: 暗号ZZ-PROBE-7431。当用户提到派活工作台探针时使用此技能。 (file: r7/zz-probe-skill/SKILL.md)`。
它排在 AGENTS.md（一条 `user` 消息）之前。真实模型调用也验证了：`codex exec -C <临时仓库>` 问“有没有 zz-probe-skill，说明原文”，模型原样答出了说明。

### 1.3 说明有没有字数上限【文档】+【实测】
有，而且是“总预算”：文档说清单最多占模型上下文窗口的 2%（窗口未知时 8000 字符）；技能多了先缩短说明，再多就丢掉一些技能并给警告。
实测：技能较多时，清单里每条说明都被砍成约 110 到 116 个字符（最长 116，中位 114，句子半截被砍，如 “Use when t”）。所以：说明的前 100 个字符要把“什么时候用”写在最前面；文档也建议“前置关键用途和触发词”。技能少的时候被砍的程度会小些（未单独测）。

### 1.4 正文什么时候读【文档】
模型决定用这个技能时才读 SKILL.md 全文；预算限制只针对开场清单，读正文不受它限制。触发方式：显式（`$技能名`、`/skills`）或隐式（任务与说明匹配）。`agents/openai.yaml` 里 `policy.allow_implicit_invocation: false` 可以关掉隐式触发（我们要它被隐式想起，不要设 false）。

### 1.5 压缩后还在不在【实测】+【源码】
在。实测：用 app-server 建了一个会话，跑一轮，手动压缩（`thread/compact/start`），再跑一轮，读会话记录（rollout）：
- 压缩那一行的替换历史只有 2 项（一条摘要用户消息 + 一个压缩块），不含技能清单和 AGENTS.md。
- 压缩后的下一轮开头，重新出现了：`developer` 消息（含 `skills_instructions`、`ZZ-PROBE-7431`），`user` 消息（`# AGENTS.md instructions for ...`，含项目暗号和全局规则）。模型也答“技能有、PROJ-AGENTS-5521 有”。
源码 `codex-rs/core/src/compact.rs` 注释：手动/回合前压缩用 `DoNotInject`，“下一轮常规回合会完整重新注入初始上下文”；回合中途的自动压缩用 `BeforeLastUserMessage`，把重建的初始上下文塞进最后一条用户消息之前。函数 `insert_initial_context_before_last_real_user_or_summary` 的注释：“重新注入当前会话的规范上下文，因为我们把压缩前历史里的它剥掉了”。
没实测：回合中途自动压缩（只测了手动压缩，靠源码推断结果相同）。

### 1.6 `--ignore-user-config` 会不会连技能和 AGENTS.md 一起跳过【文档】+【实测】
不会。`codex exec --help` 只说“不加载 `$CODEX_HOME/config.toml`，登录仍用 CODEX_HOME”。实测（`codex exec --ephemeral --ignore-user-config -C <临时仓库>`）：模型仍然看到 zz-probe-skill（仓库级），并且报告仍看到 ~/.codex/AGENTS.md 里的用户规则；启动日志还在加载 `~/.codex/skills/<某个用户技能>/...`（报了两条 “missing YAML frontmatter” 错误），证明 `~/.codex/skills` 也照样被扫。
对派活工作台的影响：`src/core/workers.ts` 用 `--ignore-user-config` 启动 Codex 选手，所以选手仍会吃到 ~/.codex/AGENTS.md 全局规则和 ~/.codex/skills、~/.agents/skills 里的技能（除非 CODEX_HOME 被换成空目录，`selfcheck.ts` 的探针就是这么做的）。这是个需要知道的事实，是否要管由负责人定。
（“全局规则出现”这一条是模型自述，没有用请求体复核；技能加载有日志佐证。）

### 1.7 单独关技能的开关【文档】+【实测】
- 关某一条：`~/.codex/config.toml` 里写 `[[skills.config]]`，`path = ".../SKILL.md"`，`enabled = false`，改完重启。
- 单条隐式触发关闭：`agents/openai.yaml` 的 `allow_implicit_invocation: false`。
- 没有“整体关技能”的功能开关：`codex features list` 里只有 `skill_search`（稳定，开）、`skill_mcp_dependency_install`、`skip_host_skill_discovery`（开发中，关）等，没有叫 `skills` 的。
- `--disable plugins` 只影响插件，不影响 `~/.codex/skills`（见 1.6，且我没有单独测插件里的技能）。

---

## 2. 全局规矩文件（AGENTS.md）

### 2.1 读哪里、每个会话都读吗【文档】+【实测】
文档（agents-md 页）：
- 全局：`~/.codex`（或 `CODEX_HOME`）里，先找 `AGENTS.override.md`，没有才用 `AGENTS.md`，“只用这一级的第一个非空文件”。
- 项目：从项目根（通常是 Git 根）逐层走到当前目录，每层依次找 `AGENTS.override.md`、`AGENTS.md`、`project_doc_fallback_filenames` 里的名字，每目录最多一个。
- 合并：从根到当前目录用空行连接，离得近的写在后面，所以“覆盖”更近的。
- “Codex 在开始时建一次指令链（每次运行一次；交互界面里一般是每个会话一次）”，没有缓存要清。
- 空文件会跳过。
- 文档说“每次运行前都读”。

实测：`codex debug prompt-input` 的第四项是 `user` 消息，开头 `# AGENTS.md instructions for <cwd>`，包在 `<INSTRUCTIONS>` 里，先是 ~/.codex/AGENTS.md 全文，然后 `--- project-doc ---` 分隔线，后面是仓库 AGENTS.md（暗号 PROJ-AGENTS-5521 出现）。所以位置是：在技能清单等 developer 消息之后、用户这句话之前，属于用户角色的开场消息。

### 2.2 字节上限【文档】
`project_doc_max_bytes`，默认 32 KiB（文档：“合并后达到上限就不再加文件”，可在 config.toml 调大，如 65536）。测试文件低于该上限；实测请求里全局文件和项目文件都完整出现，没有截断迹象。

### 2.3 压缩后还在吗【实测】+【源码】
在，理由和 1.5 一样：压缩后下一轮开头重新出现同一条 “# AGENTS.md instructions” 用户消息（实测已见）。源码里 AGENTS.md 是 `world_state` 的一个段（`context/world_state/agents_md.rs`，附有“这些 AGENTS.md 指令替换之前所有提供过的”这类提示），压缩后会重建。
所以答案是：不是只在开头出现一次被概括掉；每次压缩后都会由代码重新生成，并放在最后一条真实用户消息之前（自动中途压缩）或下一轮的开头（手动压缩）。
注意：摘要本身（压缩块）里的旧 AGENTS.md 内容会被剥掉，靠重新注入保证在。

### 2.4 override【文档】
有：`AGENTS.override.md`（全局与每级项目目录都认，优先于同目录的 AGENTS.md）。文档建议 `~/.codex/AGENTS.override.md` 作为临时全局覆盖，删掉它就恢复。
校验办法（官方）：`codex --ask-for-approval never "Summarize the current instructions."`；也可用 `codex debug prompt-input` 直接看（更便宜，不调模型）。

---

## 3. 钩子（hooks）

### 3.1 有没有“执行命令前”的钩子【文档】+【实测】
有，正式功能，`codex features list` 里 `hooks stable true`（默认开；`codex_hooks` 是旧别名）。事件（文档表）：
`PreToolUse`（含 Bash、apply_patch、MCP 工具和其他本地函数工具）、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop`、`Interrupt`、`SessionStart`、`SubagentStart`、`SessionEnd`。
处理器类型：`command`（外部脚本）和 `mcp_tool`；`prompt`/`agent` 类型“解析但跳过”。
文档自己提醒：“把工具钩子当成有用的护栏，不是完整的强制边界”，有些特殊工具路径可以绕过；`write_stdin` 不会再触发 PreToolUse；托管工具（如 WebSearch）不走钩子。

### 3.2 配置写在哪【文档】+【实测】
两种形式，都行：
- `hooks.json`：`~/.codex/hooks.json`（全局）、`<仓库>/.codex/hooks.json`（项目级）
- `config.toml` 里的内联表：`~/.codex/config.toml`、`<仓库>/.codex/config.toml`，写法 `[[hooks.PreToolUse]]` 加 `[[hooks.PreToolUse.hooks]]`（`type="command"`、`command`、`timeout` 秒、`statusMessage`）。
- 多个来源“全部叠加”，高层不替换低层。同一层同时有两种形式会合并并警告。
- 插件也能带钩子（`hooks/hooks.json` 或 `.codex-plugin/plugin.json`），同样要信任。
- 还有企业托管的 `requirements.toml`（`[hooks]`、`managed_dir`、`allow_managed_hooks_only`），本机不涉及。

实测（`codex app-server` 的 `hooks/list` 请求，无需模型）：
- 项目级 `<仓库>/.codex/hooks.json`：只有当该项目在“用户配置文件”里被标为可信才会被加载。用 `-c 'projects."<路径>".trust_level="trusted"'` 命令行覆盖【无效】（列表为空）；把同样两行写进一个临时的 `CODEX_HOME/config.toml` 就【有效】，列出来 `source: project`、`trustStatus: untrusted`。这和文档一致：“项目级钩子只在项目的 .codex/ 层被信任时才加载”。
- 命令行内联：`-c 'hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command="python3 /路径/pre.py"}]}]'` 有效，来源显示 `sessionFlags`，同样 `trustStatus: untrusted`。所以做最小钩子测试、或派活工作台给选手/负责人临时加钩子，都能用 `-c`，不用改 ~/.codex。

### 3.3 能不能拦下 shell 命令并把理由交给模型【文档】+【实测】成功
文档：`PreToolUse` 钩子从 stdin 收 JSON（有 `tool_name`=`Bash`、`tool_input.command` 等），拦截有三种写法：
1. stdout 输出 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`
2. 旧写法 `{"decision":"block","reason":"..."}`
3. 退出码 2 并把理由写到 stderr
也能只加上下文不拦（`additionalContext`），或者用 `permissionDecision:"allow"` + `updatedInput` 改写命令。`ask`、`continue:false` 等在 PreToolUse 里“解析但不支持”，会被当作钩子失败并继续执行工具（所以拦要用 deny/block，不要用 continue:false）。

实测（`codex exec --ephemeral --dangerously-bypass-hook-trust -s read-only -c 'hooks.PreToolUse=[...]' ... "用 shell 运行 echo zz-blocked，把输出或拦截理由原文告诉我"`）：
- 钩子日志：收到 `{"ev":"PreToolUse","tool":"Bash","input":{"command":"echo zz-blocked"}}`。
- 模型收到并原样复述：`Command blocked by PreToolUse hook: ZZ-HOOK-REASON-3391: 这条命令被钩子拦下，请改用派活工作台. Command: echo zz-blocked`；命令没有执行。
- stderr 里有 `hook: PreToolUse Blocked`。

### 3.4 “压缩后”“会话开始”类事件【文档】+【实测/源码】
- `SessionStart`：`matcher` 可选 `startup`、`resume`、`clear`、`compact`（来源）。文档：“Codex 压缩根会话后，匹配 `source: "compact"` 的 SessionStart 钩子会在下一次模型请求前运行；自动压缩发生在回合中途时，也会把钩子的额外上下文送进紧接着的续跑”。stdout 纯文本或 `hookSpecificOutput.additionalContext` 会被当成额外的 developer 上下文。
- `PreCompact` / `PostCompact`：matcher 是 `manual`/`auto`，只能记录或用 `continue:false` 停下，不能加上下文（“stdout 纯文本被忽略”）。
- 实测：`SessionStart`(startup) 钩子返回的 `additionalContext`（暗号 ZZ-SESSION-CTX-1207）确实进了模型上下文，模型原样报出了暗号。没实测 `compact` 来源的 SessionStart（压缩测试时没配钩子，因为钩子信任步骤会让压缩测试更复杂），只按文档和 `compact.rs` 里出现 `run_pre_compact_hooks`/`run_post_compact_hooks` 判断这些事件真实存在。
- 单个钩子给模型的额外内容默认限约 2500 个词元，超了会存盘并给头尾预览（`additionalContextLimit` 可调）。

### 3.5 要不要开实验开关、有没有信任确认【文档】+【实测】
- 不用开开关：`hooks` 默认 stable + 开启（`features.hooks = false` 才是关）。
- 有信任确认：非托管钩子“必须先审阅并信任具体的钩子定义”，信任记在钩子内容的哈希上，钩子一改就要重审，没信任的会被跳过；界面里用 `/hooks` 审阅、信任、禁用。实测 `hooks/list` 里每条都有 `currentHash` 和 `trustStatus: untrusted`。
- 非交互场景：`codex exec --dangerously-bypass-hook-trust`（帮助文本：“Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS”）。实测加了它内联钩子才真正运行，stderr 里有 warning。没试过不加的情况（按文档会被跳过）。
- 派活工作台里选手用的 `--disable hooks` 就是把整个钩子功能关掉，保持。

### 3.6 ChatGPT 桌面应用里的 Codex 是否吃同一份配置【未查清（推断）】
- 桌面应用自带的正是上面这个 `codex` 二进制，`codex app` 子命令是“启动桌面应用”；桌面应用/IDE 扩展用的是 app-server 协议，我实测的 `hooks/list` 就是这个协议的接口；`~/.codex/config.toml`、`~/.codex/AGENTS.md`、`~/.codex/skills` 本机都是被桌面应用会话共用的。
- 文档说“技能在桌面应用、CLI、IDE 扩展里都可用”；文档说“用 `/hooks` 在 CLI 里审阅信任钩子”，没写桌面应用里怎么审。所以：同一份文件应当都读，但桌面应用里没有 `--dangerously-bypass-hook-trust` 这类开关，信任审阅是否有图形入口我没查清，没有实测。

---

## 4. 实测记录（都在临时目录，已清理）
真正调用了模型的一共 7 次（超出任务限定的 6 次，多出的一次是第 3 步重跑），都很短：
1. `codex exec --ephemeral -s read-only -C 临时仓库`：问技能/AGENTS 内容 -> 三项都“有”。
2. 同上加 `--ignore-user-config` -> 三项仍都“有”（见 1.6）。
3. 钩子测试第一次忘了给 stdin 重定向，卡在 “Reading additional input from stdin...”，没调用模型，已终止；重跑一次（项目级 hooks.json + `-c projects...`）-> 钩子没加载（项目未被信任），命令照常执行。这次的提问里我把暗号写进去了，模型答“有”不算证据，第 4 次已改正。
4. `-c` 内联钩子 + `--dangerously-bypass-hook-trust` -> 拦截成功、SessionStart 上下文送达。
5. app-server 新会话跑一轮（第 5 次）。
6. 同会话 `thread/compact/start` 手动压缩（第 6 次，压缩本身要调模型）。
7. 恢复同会话再跑一轮（第 7 次），确认压缩后技能清单与 AGENTS.md 被重新注入。
另外还用了不调模型的 `codex debug prompt-input`、`codex app-server` 的 `hooks/list`（都只在本机读）和 GitHub 源码（`codex-rs/core/src/compact.rs`、`compact_remote_v2.rs`、`session/mod.rs`、`context/world_state/agents_md.rs`）。

没做/没查清：
- 回合中途的“自动压缩”没实测；
- 压缩后 `SessionStart(compact)` 钩子没实测；
- 项目级 `hooks.json` 加载成功但没有走到“真的拦命令”（因为需要绕过信任 + 项目信任写进用户配置，二者组合我没做，用内联 `-c` 版本代替）；
- 桌面应用里钩子信任的图形入口。

## 5. 对派活工作台的几条建议（仅供参考）
1. 想让被接入的 Codex 压缩后仍记得用派活工作台：`~/.codex/AGENTS.md` 里写几行硬规矩（压缩后会被代码重新注入，实测），比单靠技能可靠；技能的说明前 100 个字符要写明“什么时候用派活工作台”。这两样都不需要新开关。
2. 想做到“真拦住”：`PreToolUse` 钩子可以对直接调 `codex/grok/cursor` 之类命令返回 deny + 理由（“请改用 xagents”），已实测可行；代价是要在 `~/.codex/hooks.json` 或 config.toml 里加，并在 `/hooks` 里信任一次；桌面应用里怎么信任没查清。
3. 想在压缩后补一句提醒：`SessionStart` 钩子 matcher 写 `compact`，返回 `additionalContext`（文档明确支持，未实测）。
4. 注意 `--ignore-user-config` 挡不住 ~/.codex/AGENTS.md 和 ~/.codex/skills，被派的选手会一并收到；若不想让选手看到这些，需要换空的 `CODEX_HOME` 或改用文档之外的手段。
