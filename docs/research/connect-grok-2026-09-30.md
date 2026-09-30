# Grok 命令行调研：技能、全局规矩、钩子，能不能扛住压缩

调研日期 2026-09-30。对象：`~/.grok/bin/grok`（1.0.44）。
每条结论标：**文档**（本机官方文档写的）、**实测**（本机跑出来的）、**推断**（有依据但没直接测）、**未查清**。

文档出处简称：
- README = `~/.grok/README.md`
- 手册 = `~/.grok/docs/user-guide/NN-*.md`（08 技能、10 钩子、12 规矩、05 配置、26 配置项总表、18 沙箱、17 会话）
- 目录里没有其他官方网址可查；`docs/` 下只有 `user-guide`，与 README 同源。

---

## 0. 先回答：`~/.grok/bin/agent` 是什么

**实测**：`agent` 是符号链接，指向 `../downloads/grok-1.0.41-macos-aarch64`，就是 **旧版（1.0.41）的 grok 本体**，`agent --version` 输出 `grok 1.0.41`，`--help` 与 grok 完全一样（标题都是 Grok Build TUI）。它不是另一个产品。
另外 `grok agent` 是 grok 的一个子命令（无界面模式：`stdio` / `headless` / `serve` / `leader`），给编辑器或程序对接用，和 bin 下的 `agent` 文件不是一回事。

---

## 1. 技能（skills）

### 1.1 从哪些目录读，优先级

**文档**（手册 08-skills.md「Skill Locations」）：

| 位置 | 范围 | 优先级 |
|---|---|---|
| `./.grok/skills/`、`./.grok/commands/` | 当前目录 | 最高 |
| `<仓库根>/.grok/skills/` | 仓库 | 中 |
| `~/.grok/skills/`、`~/.grok/commands/` | 用户 | 最低 |
| `~/.claude/skills/` | 用户，Claude 兼容（可关） | 最低 |
| `./.claude/skills/` | 项目，Claude 兼容（可关） | 高 |
| `~/.cursor/skills/`、`./.cursor/skills/` | Cursor 兼容（可关） | 用户最低、项目高 |

- 同名按优先级覆盖（高的盖低的）。
- 手册还写了：每一层旁边也扫 `.agents/skills/`，并且从工作目录一路往上走到仓库根，每一级都扫。
- 配置文件 `[skills] paths / ignore / disabled` 可加目录、隐藏、停用某些名字。
- 技能扫描不看 `.gitignore`。

**实测**（`grok inspect --json`）：用户级 Grok、Agents、Claude、Cursor 技能目录、Grok 内置目录和某个 Claude 插件目录均出现在清单里。所以 **`~/.agents/skills` 确实会被读**，手册那句话属实。
**实测**：项目里的 `.grok/skills/` 与 `.agents/skills/` 会读；项目里的 `.claude/skills/` 受 `GROK_CLAUDE_SKILLS_ENABLED` 控制（关掉后 `zz-claude-skill` 不出现）。

### 1.2 名字和说明是否每轮都在上下文里，压缩后还在不在

**实测**（读会话记录 `~/.grok/sessions/.../chat_history.jsonl`）：
- 技能清单不在系统提示里（`system_prompt.txt` 里没有任何技能名），而是作为一条「系统提醒」用户消息（`synthetic_reason: system_reminder`），内容是 `<system-reminder>The following skills are available for use: ...`，每条含：名字、说明摘要、`Use when:` 触发语、`Absolute path: .../SKILL.md`。会话开头就放进去，之后每一轮都带着（它是对话历史的一部分）。
- **压缩后还在**：我对同一会话跑了 `/compact`，压缩后历史被改写成「系统提示 + 用户信息与规矩（标记 compaction_meta）+ 之前的用户提问 + 摘要 + 重新注入的 `## Available Skills` 提醒 + MCP 提醒」。技能清单被**重新塞了一遍**。再问一次模型，它仍能列出 `zz-` 技能并说出规矩暗号。
- 范围提醒：我测的是手动 `/compact`（无界面模式下 `-r <会话> -p "/compact"` 可以触发）。自动压缩（占用到 85% 触发）**文档**没说是否走同一条重注入路径，**推断**是同一路径，**没实测**。

### 1.3 说明有无字数上限

- **文档**：`name` 最多 64 字符；`description` 没写上限。
- **实测**：清单里会被截断加省略号。我写了 1900 字符的 `description` 和 `when-to-use`：清单里各只留约 **200 字符**（说明一行、`Use when` 一行各 200 左右，结尾 `…`）。说明里如果有「第一句。后面的话」，会被拆成摘要（首句）和 `Use when` 两部分。别的技能实测整条最长约 400 字符。某个中文用户技能约 140 个字就被截。
- 所以：**把最关键的触发词放在说明开头 100 字内**。
- `disable-model-invocation: true` 的技能**不进清单**（实测 `zz-nomodel` 没出现），只能人手敲 `/名字`，所以做「防遗忘」不能用它。

### 1.4 正文何时读

- **文档**：清单只有名字和说明；模型认为相关时才读正文。手册说「运行技能会把指令载入对话」；正文最多内联前 25,000 个 token（和 `read_file` 同一个上限），更长的放旁边文件让它按偏移读。
- **实测**：工具列表里**没有专门的技能工具**（只有 `read_file`、`run_terminal_command` 等），清单里给了 `Absolute path`，所以模型是自己用 `read_file` 去读 SKILL.md。人手敲 `/名字` 才是直接注入。
- **未查清**：压缩后，已经读过的技能正文会不会保留，没测。清单保得住，但正文可能只留摘要，所以技能说明本身要写成「一句话就能想起来该做什么」。

---

## 2. 全局规矩文件

### 2.1 有没有、叫什么、放哪

**文档**（README「AGENTS.md」；手册 12-project-rules.md）：
- 有用户级（全局）规矩：放在 `~/.grok/`（即 `$GROK_HOME`），认这些文件名：`Agents.md`、`Claude.md`、`CLAUDE.md`、`CLAUDE.local.md`、`AGENT.md`、`AGENTS.md`。手册还写了目录形式：`$GROK_HOME/rules/*.md`（`~/.grok/rules/`，总是扫，所有项目生效），以及 `[paths] extra_rule_dirs` 里列的目录。
- 项目级：从仓库根到当前目录，每一级目录里的同名文件都读（深的排后面，冲突时以后面的为准）。
- 不叫 `GROK.md`。
- 大小：README 写单文件上限 10,000 字符，手册 12 写「不截断、没有字符上限」。**两份文档互相矛盾，未查清**；建议规矩文件控制在 10,000 字符内。

**实测**（用临时 `GROK_HOME` 目录 + `grok inspect`，不联网、不动真目录）：
- 临时家目录里的 `AGENTS.md` 被识别为 `global`；`rules/r1.md` 被识别为 `global`；`GROK.md` **没被识别**。
- 技能 `skills/`、钩子 `hooks/*.json` 放在家目录也都被识别（新增钩子出现在清单中）。

### 2.2 会不会读 CLAUDE.md、~/.claude/CLAUDE.md、Cursor rules

**文档**（手册 05「Harness compatibility」、26 总表）：默认都读。
- `compat.claude.agents`（`GROK_CLAUDE_AGENTS_ENABLED`）：管 `~/.claude/` 下的具名规矩文件和项目里 `<dir>/.claude/CLAUDE*.md`。**项目顶层的 `CLAUDE.md`、`Claude.md`、`CLAUDE.local.md` 不受它管，始终识别**。
- `compat.claude.rules`（`GROK_CLAUDE_RULES_ENABLED`）：管 `~/.claude/rules/` 和 `<dir>/.claude/rules/`。
- Cursor 对应 `GROK_CURSOR_AGENTS_ENABLED`（`~/.cursor/` 具名文件）、`GROK_CURSOR_RULES_ENABLED`（`.cursor/rules/`）。

**实测**：
- 不设开关时，`grok inspect` 显示 `~/.claude/CLAUDE.md (global) [claude]` 被读（也就是**你的 `~/.claude/CLAUDE.md` 会被 Grok 负责人读到**）。
- 设了派活工作台那 10 个开关后，它变成 `[disabled]`。
- 关了 `GROK_CLAUDE_AGENTS_ENABLED` 后，**项目顶层 `CLAUDE.md` 仍然被读**（实测：模型说出了 `ZZ-RULE-CLAUDE-7788`），和文档一致。

### 2.3 压缩后是否仍在

**实测**：规矩不在系统提示里，而是会话第 2 条用户消息（`<rules><always_applied_workspace_rules>...`）。手动压缩后，这一块被重新放回（标 `compaction_meta`），模型压缩后仍能原样说出暗号。
- 我测的是**项目级**规矩。全局规矩在 `grok inspect` 里同属「Project Instructions」一类，**推断**走同一条重注入路径，没直接测（测它要么改 `~/.grok`，要么换 `GROK_HOME` 而丢登录，都不做）。

---

## 3. 钩子（hooks）

### 3.1 有没有「执行命令前」的钩子

**文档**（手册 10-hooks.md）+ **实测**：有，事件叫 **`PreToolUse`**，可以拦。

### 3.2 配置写在哪（会合并，全部生效）

**文档**：

| 位置 | 需要信任？ |
|---|---|
| `~/.grok/hooks/*.json`（全局） | 不需要，总是信任 |
| `~/.grok/config.toml` 里的 `[[hooks.<事件>]]` | 不需要 |
| `~/.claude/settings.json`（及 `settings.local.json`） | 不需要，Claude 兼容，可关 |
| `~/.cursor/hooks.json` | 不需要，Cursor 兼容，可关 |
| `<项目>/.grok/hooks/*.json` | **需要信任项目** |
| `<项目>/.claude/settings.json`、`.cursor/hooks.json` | 需要信任项目 |
| `managed_config.toml`、`requirements.toml`（组织下发） | 不需要，`requirements` 的可强制 |
| 插件自带 | 按插件信任 |

- `~/.grok/hooks-paths`：文档（手册 18-sandbox）说它是「登记文件」，里面写**绝对路径**的目标才会被当作钩子来源加载（相对路径行会被忽略）。手册对它的正式用法只在沙箱一节提到，**加载语义的细节未查清**（没测）。

### 3.3 格式、事件名

**文档**：JSON 文件 `{"hooks": {"事件名": [{"matcher": "正则", "hooks": [{"type":"command","command":"脚本","timeout":10}]}]}}`；`type` 还可以是 `http`。脚本从标准输入收到事件 JSON。工具名匹配支持 Claude 风格别名（`Bash` 匹配 `run_terminal_command`，`Edit/Write` 匹配 `search_replace` 等）。

事件（15 个）：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionDenied`、`Stop`、`StopFailure`、`StopCancelled`、`Notification`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`SessionEnd`。也认 Cursor 的驼峰写法。

**有压缩事件**：`PreCompact`、`PostCompact`（`matcher` 可选 `manual` 或 `auto`）。**实测**它们真的会触发（见 5.2）。但它们**不能拦，也不能往上下文塞话**（文档表里 Blocking 列写 No，被动事件的输出只记录）。

### 3.4 能不能拦下一条 shell 命令并把理由返回给模型

**实测：能。** 项目钩子 `PreToolUse`（匹配 `Bash`）读到 `{"toolName":"run_terminal_command","toolInput":{"command":"echo zz-blocked"}}` 后，输出
`{"decision":"deny","reason":"ZZ-HOOK-REASON-9921: ..."}`，命令没有执行，模型收到并原样复述：
`Hook denied: ZZ-HOOK-REASON-9921: 这条命令被拦截，请改用 xagents 派活`。
即使带 `--always-approve`（权限模式 `bypassPermissions`）也照样拦（**文档**也写了「always-approve 下钩子仍生效」）。

其他能力（**文档**）：
- `decision` 可选 `allow` / `deny` / `ask` / `defer`；`hookSpecificOutput.updatedInput` 能改写命令；`additionalContext` 能给模型带一句话（在工具执行后跟结果一起送到，包在系统提醒里，最长 10,000 字符）。
- **钩子出错、超时、输出不合格一律放行（fail-open）**；只有明确的 `deny` 才拦。默认超时 5 秒。
- `Stop` 钩子可以阻止模型「收工」并把理由送回，让它接着干（默认超时 600 秒，最多连续 8 次）。
- `SessionStart` 和 `UserPromptSubmit` 的输出**不进上下文**（文档明说：`SessionStart` 输出被忽略；`UserPromptSubmit` 只能拦，放行时输出丢弃）。所以没法靠 SessionStart 钩子给模型「补记忆」。能往上下文补话的只有 `PreToolUse`（`additionalContext`）、`PostToolUse`、`Stop`。
- 钩子进程会收到 `GROK_HOOK_EVENT`、`GROK_SESSION_ID`、`GROK_WORKSPACE_ROOT`、`CLAUDE_PROJECT_DIR` 环境变量。是否继承 grok 自己的环境变量（例如派活工作台设的任务标记）文档没写，**未查清、没测**。事件 JSON 里有 `cwd`、`workspaceRoot`、`permissionMode`，可用来区分场合。

### 3.5 要不要信任确认

- 全局钩子（`~/.grok/hooks`、`config.toml`、Claude/Cursor 全局文件）**不要**。
- 项目钩子**要**信任项目，否则**静默跳过**。**实测**：`grok inspect` 在未信任目录里只显示用户级钩子，把信任关掉（`GROK_FOLDER_TRUST=0`）后新增了测试用的项目钩子（含 `matcher=Bash` 那个）。
- 信任记在 `~/.grok/trusted_folders.toml`。`--trust` 与 `/hooks-trust` 会往里写，**我没用**。`GROK_FOLDER_TRUST=0`（或 `[folder_trust] enabled=false`）会把项目的钩子、MCP、LSP、规矩、技能一起放开，只用于本次测试。
- 手册说「信任」同时管：项目的 MCP、LSP、钩子、项目规矩、项目技能，覆盖同一仓库的子目录，嵌套的独立 git 仓库另算。

### 3.6 会不会读 Claude 的钩子

**文档 + 实测**：默认会。`grok inspect` 未设开关时列出 `user [claude]` 钩子，来源是 `~/.claude/settings.json`；用户若装了其他 Claude 钩子也会被加载。设 `GROK_CLAUDE_HOOKS_ENABLED=false` 后全部 `[disabled]`。
所以：**Grok 负责人默认会跑你 Claude 的钩子**；派活工作台的 Grok 选手关掉了。

---

## 4. 选手视角：往 `~/.grok` 装东西，选手会不会也读到

### 4.1 结论

**会，而且没有官方开关能关。** 派活工作台现在的启动方式（10 个 `GROK_{CLAUDE,CURSOR}_{AGENTS,HOOKS,MCPS,RULES,SKILLS}_ENABLED=false`）只挡 **Claude / Cursor 来源**，不挡 `~/.grok` 自己和 `~/.agents`。

**实测**（用派活工作台同款 10 个开关 + `--prompt-file --cwd -m --effort --sandbox off --always-approve` 跑无界面）：模型上下文的技能清单里仍有
- `~/.grok/skills/<某个用户技能>`（`~/.grok` 原生技能）；
- `~/.agents/skills/` 下的用户技能；
- `~/.grok/bundled/skills/` 内置的；
- **某个 Claude 插件带的技能**（`~/.claude/plugins/cache/...`）——`grok inspect` 标了 `[disabled]`，但实际仍进了模型上下文的清单，而且该插件的 MCP 服务器也没被 `GROK_CLAUDE_MCPS_ENABLED=false` 关掉（来自插件而不是 `~/.claude.json`）。这说明 `CLAUDE_*_ENABLED` 只管 `~/.claude/` 本身，管不到插件。
- 被关掉的、确实没进清单：`~/.claude/skills` 里的用户技能，以及 `~/.cursor/skills` 里的用户技能。

所以：
- 往 `~/.grok/skills` 或 `~/.agents/skills` 装「你是负责人，用派活工作台派活」的技能 → **选手也会看到**（名字和说明进清单，选手可自行读正文）。
- 写 `~/.grok/AGENTS.md` 或 `~/.grok/rules/*.md` → 选手也读（全局规矩不需要项目信任；**实测**用临时家目录确认被识别为 global；选手也走同样的加载器，**推断**必读，未用真选手实跑）。
- 写 `~/.grok/hooks/*.json` 或 `config.toml` 的 `[[hooks.*]]` → 选手也会被这些钩子管（总是信任）。
- 选手的隔离规则里只禁写 `config.toml`、`hooks`、`hooks-paths` 等，读是放的，所以读得到。

### 4.2 有没有开关能让 grok 无界面运行时不加载用户自己的技能/规矩/钩子

- `GROK_GROK_SKILLS_ENABLED`、`--no-skills` 之类：**不存在**（`grok --help`、`grok agent --help` 没有；对二进制做字符串扫描也没有 `GROK_GROK_*`）。
- 配置文件的 `[skills] disabled` 能停用某些名字，但只能写 `~/.grok/config.toml`（用户级），选手也读同一份，无法按角色区分。项目 `.grok/config.toml` 只认 `[mcp_servers]`、`[plugins]`、`[permission]`、`[mcp] max_output_bytes`。`GROK_CONFIG` / `GROK_CONFIG_PATH` 覆盖层只放行 `models`、`features`、`toolset`、`shell_environment_policy`（手册 05、26），**不含 `skills`、`hooks`、`compat`**。
- `--tools` / `--disallowed-tools` 只管内置工具，不管技能清单。
- `--system-prompt-override` 只换系统提示；技能清单和规矩是另外的用户消息，不受它影响（**推断**，没测）。
- 可能的「隔离办法」：给选手单独一个 `GROK_HOME`（文档：可整体改配置目录）。但登录信息 `auth.json` 在里面，得想办法让它也能登录（复制、软链、或用 `XAI_API_KEY`），这既涉及密钥处理又没测过，**未查清，不建议直接做**。
- 想让某个技能对选手不可见，只能靠**技能自己的说明写明「只给负责人；被派活工作台派来的选手忽略本技能」**，或者把负责人专用的东西放在选手看不到的地方（比如只放在负责人会加载而选手已关的 `~/.claude/skills`，见下）。

### 4.3 所有 `GROK_*` 里带 ENABLED 的开关（文档 + 二进制字符串核对）

跟「读用户自己的配置」有关的 10 个（`config.toml` 的 `[compat.*]` 同名键也可设，优先级：环境变量 > config.toml > 默认开）：

| 环境变量 | 管什么 |
|---|---|
| `GROK_CLAUDE_SKILLS_ENABLED` / `GROK_CURSOR_SKILLS_ENABLED` | `~/.claude/skills` 与 `.claude/skills`；`~/.cursor/skills` 与 `.cursor/skills` |
| `GROK_CLAUDE_RULES_ENABLED` / `GROK_CURSOR_RULES_ENABLED` | `~/.claude/rules`、`.claude/rules`；`~/.cursor/rules`、`.cursor/rules` |
| `GROK_CLAUDE_AGENTS_ENABLED` / `GROK_CURSOR_AGENTS_ENABLED` | `~/.claude/` 下具名规矩文件、`.claude/CLAUDE*.md`；`~/.cursor/` 下的具名文件（另手册 26 写 Cursor 这一项还含自定义代理定义） |
| `GROK_CLAUDE_HOOKS_ENABLED` / `GROK_CURSOR_HOOKS_ENABLED` | `~/.claude/settings.json`（含项目里的）；`~/.cursor/hooks.json` |
| `GROK_CLAUDE_MCPS_ENABLED` / `GROK_CURSOR_MCPS_ENABLED` | `~/.claude.json` 的 MCP；`.cursor/mcp.json` |

其他带 ENABLED 的（和技能规矩钩子无关）：`GROK_TELEMETRY_ENABLED`、`GROK_TELEMETRY_MIXPANEL_ENABLED`、`GROK_FEEDBACK_ENABLED`、`GROK_MANAGED_MCPS_ENABLED`、`GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED`、`GROK_ZDR_ACCESS_ENABLED`、`GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED`。
不带 ENABLED 但相关：`GROK_FOLDER_TRUST`（0 = 关掉项目信任门槛）、`GROK_HOME`（换配置目录）、`GROK_CONFIG` / `GROK_CONFIG_PATH`（覆盖层，限白名单）、`GROK_MEMORY`、`GROK_SUBAGENTS`、`GROK_WORKFLOWS`、`GROK_SANDBOX`、`GROK_AGENT`。
`compat.codex.*`：手册 05 说 Codex 的 skills/rules/agents/mcps/hooks 「保留、目前无效」，26 总表却写「扫描 Codex 技能目录」，两处不一致；没有对应环境变量，`~/.codex` 实测不在清单里。

### 4.4 一个对派活工作台很重要的顺带发现：项目级文件在选手那边默认不生效

**实测**（第 1 次调用）：用派活工作台同款参数，在一个 git 仓库里放了项目 `AGENTS.md`、`CLAUDE.md`、`.grok/skills`、`.agents/skills`，模型的回答是「技能：无；暗号：无」。`grok inspect` 显示 `Project trusted: no`。会话记录里也确认没注入。原因：项目未信任时，项目规矩、项目技能、项目钩子一起被跳过；`--always-approve` 不等于信任。
只有打开 `GROK_FOLDER_TRUST=0` 后才全部生效（第 2 次调用）。
含义：**派活工作台的 Grok 选手，默认读不到工作副本里的 AGENTS.md / CLAUDE.md**（除非提示词里把要点贴进去，或把工作副本登记进信任列表，或派活工作台设 `GROK_FOLDER_TRUST=0`；后两者要不要做是安全取舍，我没有改）。这一点也意味着：项目里的钩子对选手同样默认不生效，选手身上的钩子只有全局那些。

---

## 5. 实测记录

临时目录：`.../scratchpad/grok-probe`（git 仓库，含项目技能、项目规矩、项目钩子）。全部用派活工作台同款 10 个 `GROK_*_ENABLED=false`、`--sandbox off --always-approve`、模型 `grok-4.7-build-fast`、`--effort medium`。共 **5 次模型调用**（没超）。

### 5.1 技能与规矩

| # | 条件 | 结果 |
|---|---|---|
| 1 | 默认信任（未信任项目），问 zz- 技能与 ZZ-RULE 暗号 | 「无 / 无」。项目文件全没进上下文（原因见 4.4）。清单中的技能来自 `~/.grok`、`~/.agents`、内置、某个 Claude 插件 |
| 2 | `GROK_FOLDER_TRUST=0` | 列出 `zz-long-skill`、`zz-probe-skill`、`zz-agents-skill`；暗号 `ZZ-RULE-AGENTS-5566`、`ZZ-RULE-CLAUDE-7788` 都读到。`zz-claude-skill`（`.claude/skills`）被开关挡掉；`zz-nomodel`（禁止模型调用）不在清单。规矩位于会话第 2 条用户消息的 `<rules>` 块，技能清单是独立的 system-reminder |

关于「再试一下能否用某个开关让它不加载」：`GROK_CLAUDE_SKILLS_ENABLED=false` 能挡项目 `.claude/skills`（实测）；`GROK_CLAUDE_AGENTS_ENABLED=false` **挡不住**项目顶层 `CLAUDE.md`（实测，文档也这么写）；没有开关能挡项目 `.grok/`、`.agents/` 技能和 `AGENTS.md`，只能靠「不信任项目」。

### 5.2 钩子与压缩

| # | 条件 | 结果 |
|---|---|---|
| 3 | 项目 `.grok/hooks/probe.json`：`PreToolUse`（`Bash`）拦 `echo zz-blocked` | 拦住，模型收到 `Hook denied: ZZ-HOOK-REASON-9921: ...`。事件 JSON 含 `toolName=run_terminal_command`、`toolInput.command`、`permissionMode=bypassPermissions`、`cwd`、`sessionId`。`SessionStart` 钩子触发（`source: new`） |
| 4 | 对第 2 次的会话 `-r <id> -p "/compact"` | 无界面下**可以**触发压缩。`PreCompact`、`PostCompact` 钩子触发（`source: manual`）；`SessionStart` 在恢复会话时再触发一次（`source: load`）。压缩后历史里技能清单和规矩块被**重新注入** |
| 5 | 压缩后再问一次 | 仍能列出三个 zz- 技能、两个暗号 |

**没实测**：自动压缩（85%）；全局（`~/.grok`）级技能/规矩/钩子在压缩后的表现（因为不许改 `~/.grok`）；`hooks-paths` 的加载；钩子进程是否继承 grok 的环境变量；技能正文压缩后是否保留。

---

## 6. 对三种手段的直接结论（给负责人参考）

1. **技能**：清单（名字+说明前约 200 字）每轮都在，**压缩后会被重新注入**（实测），够用。缺点：只是「提醒有这个技能」，模型不一定去读正文；说明要把触发词写在最前。
2. **规矩文件**：最稳。内容直接整段进上下文（不是摘要），压缩后重新放回（实测）。全局路径 `~/.grok/AGENTS.md`（或 `~/.grok/rules/*.md`），项目级 `AGENTS.md`。注意：**Grok 负责人默认已经在读你的 `~/.claude/CLAUDE.md` 和 `~/.claude/skills/<某个用户技能>`**（`grok inspect` 显示），所以如果 Claude 那边已经写了，Grok 负责人不需要另装就有。
3. **钩子**：`PreToolUse` 拦命令并把理由送回模型，实测有效，且 `--always-approve` 也拦不掉；坏了就放行（fail-open），所以只能当「提醒/纠偏」而非硬保证。`PostToolUse` / `Stop` 的 `additionalContext` 可以在中途往模型上下文补话。全局钩子不用信任；项目钩子需要信任项目。

**要小心的一点**：往 `~/.grok/skills`、`~/.agents/skills`、`~/.grok/AGENTS.md`、`~/.grok/hooks` 装的东西，派活工作台的 Grok 选手**都会读到**，而且现在没有开关关。所以负责人专用的内容要么写明「选手忽略」，要么放在 `CLAUDE_*` 系列开关能关掉的位置（`~/.claude/skills`、`~/.claude/CLAUDE.md`），后者对 Grok 负责人默认生效、对已设开关的选手不生效。
