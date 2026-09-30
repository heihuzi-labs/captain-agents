# 选手写各家全局配置：堵上逃出隔离的口子（2026-09-30 实测）

**结论：堵上了。** 以前 Cursor 选手能写整个 `~/.cursor`（和它的安装目录），Grok 选手能写 `~/.grok` 里没被点名的部分。这些地方放着钩子、技能、规矩、插件、管理员配置，甚至程序本身；选手写进去之后，主人在隔离外打开 Cursor 或 Grok 就会被加载，钩子还会以主人的账号直接执行，没有确认弹窗。现在两家的全局目录对选手一律只读，只放开它们干活真正要写的几处，自检每天用探针复查。

本机版本：cursor-agent 2026.09.28-64d2043，grok 1.0.44，srt（`@anthropic-ai/sandbox-runtime`）0.0.77。全部实测在临时目录和临时副本里做，未修改用户配置内容，探针产生的测试文件已清理。

前情：同日的两份调研（Cursor、Grok 的技能、规矩、钩子）指出了这个口子，依据是文档和程序字符串；本文是在此基础上的实测和改法。

## 1. 选手真正需要写的最小范围

| 选手 | 必须能写 | 怎么做到 | 依据 |
|---|---|---|---|
| Cursor | 副本；任务目录下的 `cursor-state/`；系统临时目录 | 启动时设 `CURSOR_CONFIG_DIR=<任务目录>/cursor-state/config`、`CURSOR_DATA_DIR=<任务目录>/cursor-state/data`；`~/.cursor`、`~/.local/share/cursor-agent` 都不放开 | 实测 1、2 |
| Grok | 副本；`~/.grok/sessions/<副本路径转义>` 这一个文件夹；系统临时目录 | 模板里用占位 `__GROK_SESSION__`，派活时按副本路径算出来；`~/.grok` 其余全部不放开；另设 `GROK_MEMORY=0`、`GROK_DISABLE_AUTOUPDATER=1` | 实测 3、4、5 |

登录：两家都照旧**读得到**自己的登录（Cursor 的登录凭据不在 `cli-config.json` 里，那里只存名字和缓存，把它搬走后仍显示已登录；Grok 读 `~/.grok/auth.json`）。Grok 的登录刷新见第 3 节。

## 2. 实测记录

同一个小题（“在 a.txt 末尾加一行，然后回答 done”），用派活工作台同款参数，外面套 srt。每次先 `touch` 一个标记文件，跑完用 `find -newer` 查家目录里被改过的东西。

1. **Cursor，旧模板（能写 `~/.cursor`）**：做完了。被改过的：`~/.cursor/cli-config.json`、`chats/`、`projects/<副本>/`（含 `.workspace-trusted`）、`ai-tracking/ai-code-tracking.db`、`skills-cursor/.sync-manifest.json`，以及 `~/.local/share/cursor-agent/versions/<版本>/.running`。
2. **Cursor，新做法（家目录一处不放开，状态搬到任务目录）**：`cursor-agent status` 显示已登录；小题做完，文件改对了。家目录里**没有任何文件被改**；配置、聊天记录、项目状态和信任标记都落在搬过去的目录里。搬家后的 `cli-config.json` 里隐私模式（`privacyMode`）与主人原来的一样。技能同步、用量记录写不进去，不报错、不影响干活。
3. **Grok，旧模板**：做完了。被改过的：`~/.grok/sessions/`（本副本的会话文件夹和 `session_search.sqlite`）、`models_cache.json`、`settings_cache.json`、`logs/unified.jsonl`，以及每次启动都重写的 `docs/user-guide/*.md`。
4. **Grok，`~/.grok` 全不放开**：启动失败，`Couldn't create session: Permission denied`（`FS_PERMISSION_DENIED`）。
5. **Grok，只放开本副本的会话文件夹**（先删掉旧文件夹，确认能新建）：做完了，只有这个文件夹被写；搜索索引、缓存、日志、文档写不进去，不报错、不影响干活。
6. **会话文件夹的命名**：检查测试生成的 `~/.grok/sessions/`，是把副本的完整路径逐段转义，`/` 写成 `%2F`，`.`、`-` 保留，中文按 UTF-8 百分号编码，和 `encodeURIComponent` 一致。拿不准的 `! ' ( ) * ~` 两种写法都放开；副本路径若经过符号链接，真实路径也算一份。srt 把 `* ? [ ]` 当通配符，所以带这些字符的写法不放开；副本路径必须是规范的绝对路径（不能是空、`.`、`..`、根目录、带通配符），否则不派。放开的每一处可写路径（副本、Cursor 状态目录、Grok 会话文件夹，以及模板里写死的）都做同样的检查，所以模板里也不能再用 `~/...` 放开写。算错了的后果是 Grok 启动就报错（上面第 4 条），不会悄悄放宽。

## 3. Grok 的登录刷新（为什么不放开 `auth.json`）

- Grok 的令牌 6 小时过期，默认提前 5 分钟刷新；刷新会换发新的续期令牌、旧的作废（程序里有 `sibling-rotation`、`refresh token reuse` 等处理）。
- 实测写法：在隔离外用 `GROK_AUTH_EARLY_INVALIDATION_SECS=30000 grok models` 触发一次刷新，`auth.json` 被新文件替换，过期时间也随之更新。说明它是先在 `~/.grok` 里建临时文件再改名替换，要写回就得放开整个 `~/.grok` 的新建权限，也就是口子本身。
- 放开 `auth.json` 本身也不安全：选手可以把主人的登录换成别人的账号，主人以后的对话就跑到那个账号里。
- 所以做法是：**派 Grok 活之前（开副本之前），平台在隔离外先刷新**（`GROK_AUTH_EARLY_INVALIDATION_SECS=18000 grok models`，剩不到 5 小时才换新）。几个派活进程排队刷新；刷新命令报错、超时、被杀，这件就不派，不开副本。实测剩余有效期大于阈值时不刷新。一件活一般 15–20 分钟，用不着自己刷新；而跑着的 Grok 发现别的进程刷新过，会直接用磁盘上的新令牌（程序里有 `another process already refreshed, using disk token`）。
- 剩下的风险：Grok 没有命令能报出令牌还剩多久（`grok --help` 没有登录状态命令，`grok inspect --json` 里也没有过期时间），它刷新失败时也可能先用着没过期的旧令牌、照样返回成功（程序里有 `refresh failed but token still valid (grace), using cached`）。平台不去解析登录文件，所以“至少剩 5 小时”不是百分之百。令牌若在选手干活时到期，它会在隔离里刷新而写不回去，主人的 Grok 登录可能失效，需要主人重新登录一次。

## 4. 自检探针

`src/core/selfcheck.ts` 的 `globalTargets` 列出 21 处全局位置，三种隔离（Codex、Grok、Cursor）都要写不进去，别家的也不行：

- Cursor：`~/.cursor/hooks.json`、`skills/`、`rules/`、`mcp.json`、`cli-config.json`、`projects/`（信任标记）、`~/.local/share/cursor-agent`（程序）。
- Grok：`~/.grok/skills/`、`AGENTS.md`、`rules/`、`hooks/`、`config.toml`、`requirements.toml`（管理员配置）、`memory/`、`installed-plugins/`、`bin/`、`sessions/`（别处的会话）、`auth.json`。
- 其他：`~/.claude`、`~/.agents`、`~/.codex`。

探针写法：已有的文件用只写、不截断、不新建的方式打开（`O_WRONLY`），不改内容；已有的目录里建一个随机名的空文件；还没有的按真实路径建出来。只要写成了就算没挡住，删不掉另记原因。建出的东西连同文件编号报给外面；外面在探针前记下哪些位置确实不存在（只认“不存在”这一种错误），跑完只删随机名文件和“探针报告过、编号对得上”的东西，其余新出现的一律不删、报错让负责人查。每种隔离跑完马上清，下一种看到的“原来有没有”才准。

实测：

- **新模板**：三种隔离的 21 项全部 `EPERM`（挡住），自检通过。
- **反向对照（换回旧模板跑同一套探针）**：自检不过。Cursor 隔离里能写 7 项：`cursor-hooks`、`cursor-skills`、`cursor-rules`、`cursor-mcp`、`cursor-config`、`cursor-trust`、`cursor-install`；Grok 隔离里能写 8 项：`grok-skills`、`grok-agents`、`grok-rules`、`grok-admin`、`grok-memory`、`grok-plugins`、`grok-sessions`、`grok-login`（`hooks`、`config.toml`、`bin` 旧模板已点名挡住）。Codex 隔离新旧都全部挡住。
- **审查后复测**（按第 5 节修完）：新模板仍全部挡住；旧模板（`~` 换成完整路径，否则直接被路径检查拒掉）仍查出同样的 7 + 8 项，探针建出的东西按文件编号全部清掉、没有报错；主人的 `~/.cursor/cli-config.json`、`~/.grok/auth.json`、`~/.grok/config.toml` 文件编号、修改时间、大小都没变。
- **清理核对**：每轮跑完，各全局目录里没有 `.xagents-selfcheck-*` 残留；原来不存在的钩子、外部连接、规矩和管理员配置文件仍不存在。

## 5. 独立审查（Codex 高档）

第一版提交后派 Codex 独立审了一遍，指出 5 条，负责人逐条核实都成立，已全部改掉：

1. 会话文件夹名里的 `*` 会被 srt 当通配符，空路径、`.`、`..` 会让放开范围变成整个 `~/.grok/sessions` 甚至 `~/.grok`。改：带通配符的写法不放开，所有可写路径必须是规范绝对路径，否则不派。
2. 探针“写成了但删不掉”会被判成挡住；已有文件用读写方式打开，读被禁时也会误判。改：写成了就算放行；已有文件改用只写方式打开。
3. 外面的清理不能证明东西是探针建的，可能误删主人同时新建的空配置。改：只删随机名文件和探针报告过、文件编号对得上的。
4. 登录刷新失败照样派活。改：失败就不派、不开副本，几个派活进程排队刷新。
5. 文档有几处说过头。改：本文、`docs/design.md`、`guide/commander.md`、`AGENTS.md` 的相关说法。

修完后派它复审：第 1、2 条确认改对；另指出 3 处，负责人核实都成立，再改：

- 清理只比对文件编号，没再看文件是否为空；探针建出、没删掉之后若被别的程序写进内容，仍会被删。改：有内容就不删、报错。
- 刷新最多跑 30 秒，排队的锁却只等 10 秒，后一件会白白失败。改：刷新排队最多等 2 分钟（测试用拨快时钟验证：10 秒时失败，2 分钟时通过）。
- 上一版的自检缓存探针名字一样，新版会直接认它，不重跑修正后的探针。改：自检缓存升到第 2 版，旧版本缓存一律作废、派活时自动重检。

它另外提到的：主人全局配置里若有指向选手可写位置的符号链接，也会被改。实测检查了相关全局目录的符号链接，未发现指向选手可写位置的配置链接。srt 自己默认还放开 `~/.npm/_logs`（`HOME_CONVENIENCE_WRITE_DIRS`），只是 npm 日志，没发现会被加载执行。

## 6. 还没堵的（另议）

- ~~`/private/tmp`、`/private/var/folders` 仍对选手可写（两家都要用临时目录），srt 还默认放开 `~/.npm/_logs`。别的程序若从这些地方加载东西，也可能被利用；负责人会话的草稿目录也在 `/private/tmp` 下。~~ 同日已堵上：每件活一个专用临时目录，见 [临时目录实测](tmp-writes-2026-09-30.md)。
- 选手仍能**读**其他全局位置（例如主人的 `~/.grok/memory`、`~/.cursor/skills`），只是写不进去。

## 7. 查额度也搬状态目录（同日补）

- 问题：查 Cursor 额度（隔离外，每 10 分钟一次）用临时目录当工作目录起 `cursor-agent --trust --mode ask`，查完删了临时目录，但 cursor-agent 为这个工作目录在 `~/.cursor/projects/` 建的项目目录（`.workspace-trusted`、`repo.json`、`worker.log`、`worker.sock`，有的还有 `mcp-auth.json`）留下了，当天数到 126 个（104 个来自真实查询，22 个来自早先的测试）。
- 改法：同派活，设 `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR` 指向本次临时目录下的 `state/config`、`state/data`，工作目录改为临时目录下的 `work/`，查完整个临时目录一起删。
- 实测（隔离外真实 cursor-agent 2026.09.28-64d2043，临时 `XAGENTS_HOME`，没改主人配置）：仍是登录状态，`/usage` 照常读出套餐和各池用量，与同时段缓存一致；项目目录建在搬过去的 `data/projects/` 里，查完随临时目录删掉；`~/.cursor/projects` 前后项数不变。
- 以前留下的残留已挪进废纸篓（没直接删），剩下的都不是派活工作台建的。
- 另外看到（`.running` 已在下面处理）：每次查询 cursor-agent 还会在 `~/.local/share/cursor-agent/versions/<版本>/.running/` 留两个以进程号命名的空文件（伪终端桥用 SIGKILL 收尾，它来不及删），当天已有 556 个，都是 0 字节；`~/.cursor/skills-cursor/.sync-manifest.json` 也会被改写，这是 cursor-agent 平时启动都会做的。

### 7.1 `.running` 运行标记（同日补）

- 原因（读 cursor-agent 2026.09.28-64d2043 的 `index.js`，`install-in-use-marker`）：它启动时在自己安装目录的 `.running/` 下按进程号写空文件，只在进程的 `exit` 事件里删；安装目录不受 `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR` 影响。它对 SIGTERM、SIGINT 有自己的处理，会走正常退出。查一次额度有两个进程写标记：主进程和它起的子进程（另外还会经 `npm exec` 起一个 `typescript-language-server`，不写标记）。
- 实测（隔离外真实 cursor-agent，查到 `/usage` 结果后换不同收尾方式，各看 `.running/` 新增了什么；工作目录和状态目录都在临时目录，未修改用户配置）：

  | 收尾方式 | 退出 | 留下的标记 |
  |---|---|---|
  | 整组 SIGKILL（原做法） | 立即 | 2 个（主进程、子进程都留） |
  | 只给主进程 SIGTERM | 0.02 秒，退出码 143 | 1 个（子进程的） |
  | 只给主进程 SIGINT | 0.02 秒，退出码 130 | 1 个（子进程的） |
  | 关掉伪终端（SIGHUP） | 0.06 秒，退出码 1 | 2 个 |
  | 界面里按 Esc 再按两次 Ctrl-C | 0.86 秒，退出码 0 | 1 个（子进程的） |
  | **整组 SIGTERM** | **0.02 秒，退出码 143** | **0 个**（连做 5 次都是 0，含启动后 0.5 秒、2 秒就收到的） |

- 改法：伪终端桥（`src/core/pty-bridge.py`）收尾时先给整个程序组发 SIGTERM，等主进程退出、组里没人了就走；最多等 1.5 秒，还没退干净就整组 SIGKILL，超时、出错时也一样，保证不留进程。`quota.ts` 给 Cursor 查询的收尾宽限从 0.3 秒改成 3 秒（新字段 `graceMs`，要比桥的 1.5 秒长，否则桥会被先杀掉、来不及收尾）；Grok 查询仍是 0.3 秒。正常情况下查询只多等约 0.02 秒。
- 验证：新测试用替身模拟“主进程加子进程各写标记、收到 SIGTERM 才删”，查完标记必须为空；再用不理 SIGTERM 的替身确认等满宽限后整组强杀、查询超时时也杀干净。新测试在旧桥上失败（留下 2 个标记），新桥上通过。隔离外用本分支命令行、临时 `XAGENTS_HOME` 对真实 cursor-agent 查两次额度，都正常读出套餐和各池用量，`.running/` 没有新增。
- 旧残留：两个版本目录里攒了几百个空标记，逐个核对：绝大多数进程号已不存在；少数进程号还在用，但都是别的程序，启动时间都晚于标记写入时间，是进程号被重用，原来的 cursor-agent 早已退出。全部用 `/usr/bin/trash` 挪进废纸篓，没直接删。
- 另外看到（未处理）：`--mode ask` 启动时会经 `npm exec` 起 `typescript-language-server`，会用到 `~/.npm` 的缓存，查完随整组 SIGTERM 一起退出。

## 8. Cursor 的状态目录要短（同日补）

- 现象：收窄临时目录之后，任务号长的 Cursor 活 2 秒就失败，报 `EPERM: operation not permitted, mkdir '/tmp/.cursor/<副本名截断>-<哈希>'`。
- 原因（读 cursor-agent 2026.09.28 源码 `../cursor-config` 里算 worker 套接字目录的函数）：套接字目录先取 `<数据目录>/projects`，超过 84 个字符就改用 `<数据目录>`，再超过 84 就改用写死的 `/tmp/.cursor`；拼上副本名后超过 92 个字符，就截到 84 再加 7 位哈希。原来数据目录放在 `<登记处>/jobs/<任务号>/cursor-state/data`，任务号一长就超过 84，退到 `/tmp/.cursor`。以前公用临时目录可写，所以没出事。
- 改法：不放开 `/tmp/.cursor`（那里也有主人在隔离外用 Cursor 时的套接字，选手能写就可能冒充），而是把状态目录挪到 `<登记处>/cursor/<任务号的 12 位哈希>`，数据目录长度固定在 84 以内；派活时再检查一次，超长（登记处路径太长）就拒绝派活并说明原因。清理时照旧删掉。
- 测试：长任务号下数据目录不超过 84 个字符；登记处路径太长时拒绝。
