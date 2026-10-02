# 接入 DeepSeek Harness（dsh）当负责人：调研（2026-10-02）

每条标了出处：文档 / 源码 / 实测 / 未查清。源码看的是官方仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，当天最新是预发布 0.2.0-rc.2（2026-09-29）。另外对照过 `dsh-v0.1.7-rc.1` 标签：下面用到的两个包（agent-instructions、skill-filesystem）在两个版本之间没有差别。

## 1. 它是什么

- DeepSeek 官方开源的 AI agent 框架，“一切皆插件”。命令行是 `dsh`（`dsh web` 开网页界面，`dsh --profile headless "任务"` 直接跑）（文档：`apps/cli/README.md`）。
- 网上的几个“DeepSeek Harness 桌面应用”都是第三方做的壳，里面跑的是官方 dsh 核心。所以接入针对的是 dsh 本身，和用哪个壳无关。

## 2. 家目录

- 默认是 `~/.dsh`，可以用环境变量 `DSH_HOME` 改（源码：`packages/util/home-paths/src/index.ts`）。
- 派活工作台只认默认的 `~/.dsh`，暂不跟 `DSH_HOME`。

## 3. 常驻规矩（能不能接入的关键）

- **全局规矩文件**：`$DSH_HOME/AGENTS.md`。文件名写死，没有规矩目录，也不读 `~/.claude/CLAUDE.md`（源码：`packages/context/agent-instructions/src/render.ts`、`files.ts`）。
- **项目里的**：从项目根到当前目录，每一级读 `AGENTS.md`、`CLAUDE.md` 和对应的 `.local.md`；总量默认上限 64 KiB（源码）。
- **怎么进对话**：第一次请求前，把全局规矩和项目规矩合成一条用户消息，外面注明“可能相关、当作指导、不覆盖系统和用户指令”（文档）。分量比系统提示轻，所以那段话要短、说得明白。
- **压缩之后**：压缩会把这条消息概括掉，下一次请求前插件会再放回去（单元测试：`tests/agent-instructions.spec.ts` 里先模拟压缩、再验证重新带上的两个用例）。本机没有真跑一次。
- **哪些预设有**：默认的 `standard` 和 `ptc` 预设挂了这个插件；`minimal` 预设没有，切到它规矩就不生效（源码：`presets/*.patch.yml`）。
- **格式**：纯 Markdown，原样塞进去，不解析文件头（源码）。

结论：可以接入，写 `~/.dsh/AGENTS.md`。主人可能也往这个文件里写自己的东西，所以和 Codex 一样只写起止标记之间那一段，撤下时逐字节还原。

## 4. 能不能跑终端命令

- 有 `bash` 工具（文档）。
- 默认沙箱 `workspace-write`、批准策略 `ask`：命令在沙箱里直接跑，只能写工作目录和部分临时目录（源码：`bundle/base/cordis.patch.yml`）。
- **坑**：`xagents` 要写 `~/.xagents`，在默认沙箱里会被挡住，模型要带理由重试并由主人点批准；或者主人自己把 dsh 切到完全访问（`danger-full-access`）。这等于放宽 dsh 的安全，**派活工作台不替主人改**，只在设置页那一行的小字里提醒。
- 沙箱只管文件，不限制网络（文档）。

## 5. 其他

- **技能**：支持，写法和 Claude 的一样（目录里放 `SKILL.md`）。读项目的 `.dsh/skills`、`.agents/skills`，全局的 `~/.dsh/skills`、`~/.agents/skills`（文档）。压缩后技能清单还在不在：未查清。和其他家一样，技能只算锦上添花，不另装。
- **钩子**：有能复用 Claude 钩子格式的插件，执行前拦截可以拒绝；但默认没启用，要改 dsh 的配置才能装（文档、源码）。一键接入不装钩子。
- **选手读不读得到**：`~/.dsh/AGENTS.md` 只有 dsh 读，Codex、Grok、Cursor 选手都不读。

## 6. 验收时要真做的

在装了 dsh 的电脑上：接入以后开一个新的 dsh 会话（默认预设），问它“要把开发活交给别的 AI，该用什么命令”，应答出 `xagents`、先运行 `xagents guide`；再手动压缩一次，重新问，答案不变。
