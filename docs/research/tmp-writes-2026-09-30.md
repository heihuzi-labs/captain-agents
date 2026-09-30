# 选手写公用临时目录：改成每件活一个专用临时目录（2026-09-30 实测）

**结论：可行，已改。** 以前 Grok、Cursor 的隔离放开整个 `/private/tmp` 和 `/private/var/folders`，srt 还默认放开 `/private/tmp/claude` 和 `~/.npm/_logs`；Codex 的 `:workspace` 也放开 `/tmp` 和 `$TMPDIR`（系统给本用户的临时目录）。`/private/tmp/claude-<用户号>` 下是负责人（Claude Code）会话的草稿目录和后台任务输出，`/private/var/folders` 下有别的程序的临时文件和套接字；选手能写这些地方，就可能伪造负责人读到的输出，或影响别的程序。现在三家都只能写这件活自己的 `tmp/`（任务目录下，`xagents clean` 时删掉），`TMPDIR` 指向它；两家照常登录、干活，Codex 也照常。自检每天用探针复查。

本机版本：cursor-agent 2026.09.28-64d2043，grok 1.0.44，codex-cli 0.159.0，srt（`@anthropic-ai/sandbox-runtime`）0.0.77。实测都在临时副本（`~/.xa-tmpexp/`）和临时登记处里做，没改主人的配置；测完的清理见第 7 节。

## 1. 做法

| 选手 | 怎么只给一个专用临时目录 | 依据 |
|---|---|---|
| Grok、Cursor（srt） | 模板 `allowWrite` 只剩副本、各家状态和 `__TMP__`（派活时换成任务的 `tmp/`）；`denyWrite` 写上 `/private/tmp/claude`、`~/.npm/_logs`（srt 自己默认放开的两处）；启动 srt 时设 `CLAUDE_CODE_TMPDIR=<任务的 tmp>` | 实测 1–4 |
| Codex | 权限表加 `":slash_tmp"="read"`（`/tmp` 只读）、`":tmpdir"="read"`（`$TMPDIR` 只读）和 `"<任务的 tmp>"="write"`；启动 `codex exec` 时 `TMPDIR=<任务的 tmp>` | 实测 5、6、9 |
| 三家共同 | `rules.md` 写明临时文件放 `$TMPDIR`，`mktemp` 要写 `mktemp -p "$TMPDIR"` | 实测 7、8 |

srt 的相关源码（`dist/sandbox/sandbox-utils.js`）：`SANDBOX_OWN_WRITE_PATHS` 固定放开 `/tmp/claude`、`/private/tmp/claude`；`HOME_CONVENIENCE_WRITE_DIRS` 放开 `~/.npm/_logs`、`~/.claude/debug`（后者因为我们禁读 `~/.claude` 已被它自己去掉）；`generateProxyEnvVars` 给子进程设 `TMPDIR=$CLAUDE_CODE_TMPDIR`，没设就是 `/tmp/claude`。`/tmp/claude` 是所有 srt 隔离共用的，实测里面已经有 Cursor 选手的日志和派活工作台测试的残留，选手之间能互相改。macOS 上 `denyWrite` 的规则排在放行规则后面、按“后写的算”生效，实测能盖住这两处默认放行。

## 2. 实测记录

每项先写一个探针脚本，在隔离里逐个位置建一个随机名文件（`wx`，写成就删）；真实选手跑“在 a.txt 末尾加一行”这类小题。被隔离挡住的写操作用 `log show --predicate 'sender == "Sandbox"'` 看。

1. **srt 探针，旧模板**：`/private/tmp/claude-<用户号>`、`/private/tmp`、`/tmp`、`/private/tmp/claude`、系统给本用户的临时目录（`getconf DARWIN_USER_TEMP_DIR`）和缓存目录（`DARWIN_USER_CACHE_DIR`）、`~/.npm/_logs` 全部可写。
2. **srt 探针，新模板**：上面 7 处全部 `EPERM`；`TMPDIR` 和 Node 的 `os.tmpdir()` 都是任务的 `tmp/`，可写。`~/.npm/_logs` 只放进 `denyWrite` 前仍可写，放进去后挡住。
3. **Cursor 真跑，新模板**：照常登录，小题做完、文件改对。它的日志落在任务 `tmp/cursor-agent-logs-501/`（以前落在公用的 `/tmp/claude` 里）。这段时间它被挡住的写操作只有以前就挡住的（`~/.local/share/cursor-agent/.../.running`、`~/.cursor/skills-cursor/.sync-manifest.json.tmp`）和 npm 的日志、缓存，没有任何临时目录。stderr 里 8 行“failed to copy trust settings of system certificate”旧任务里也一样有，不是这次引起的。
4. **Grok 真跑，新模板**：小题做完，只写了副本和本副本的会话文件夹。被挡住的除以前就挡住的 `~/.grok` 缓存、日志、文档外，多了一条：它每次都想建 `/private/tmp/sessions/<会话号>`（程序里叫 scratch_dir，写死在 `/tmp`，不看 `TMPDIR`），建不成不报错、不影响干活。
5. **Codex 探针，旧权限表**：`/private/tmp/claude-<用户号>`、`/private/tmp`、`/tmp`、`/private/tmp/claude`、系统给本用户的临时目录都可写；缓存目录和 `~/.npm/_logs` 本来就挡住。
6. **Codex 探针，新权限表 + `TMPDIR` 指向任务的 tmp**：上面全部 `EPERM`，只有任务的 `tmp/` 可写。
7. **三家真跑，要用临时文件的小题**（“用 mktemp 建临时文件、写 hello、把路径追加到 a.txt、再删掉”），题目前拼上新的 `rules.md`：三家都做对了，临时文件都建在任务的 `tmp/` 里并删掉。Codex 一次做对（用了 `${TMPDIR}/task.XXXXXXXX`）；Grok、Cursor 第一次直接写 `mktemp` 被挡住，下一步自己改成 `mktemp -p "$TMPDIR"` 做完。
8. **为什么 `mktemp` 会撞墙**：macOS 自带的 `mktemp` 不带 `-p` 时，优先用 `_CS_DARWIN_USER_TEMP_DIR`（系统给本用户的临时目录），`TMPDIR` 只是后备（`man mktemp`；隔离外 `TMPDIR=<别处> mktemp -u` 实测仍给出 `/var/folders/.../T/tmp.XXXX`）。`mktemp -p "$TMPDIR"`、Python 的 `tempfile`、Node 的 `os.tmpdir()` 都看 `TMPDIR`。所以规则里补了一句写法。另外 Grok 的系统提示里写着“草稿文件放 `/tmp/`，除非用户或项目规矩另指地方”，`rules.md` 这句正好是“另指地方”。
9. **Codex 的 `:tmpdir`（审查后补测）**：只加 `":slash_tmp"="read"` 时，若启动时没设 `TMPDIR`，`:workspace` 放开的 `$TMPDIR` 就是系统给本用户的临时目录，实测可写。再加 `":tmpdir"="read"` 后，设不设 `TMPDIR` 系统临时目录都 `EPERM`，任务的 `tmp/` 仍可写（写明的路径比 `:tmpdir` 优先）。只读题那一档（继承 `:read-only`）两种情况下也都只有任务的 `tmp/` 可写。之后真跑一次 `codex exec`：照常做完，`TMPDIR` 是任务的 tmp，`touch` 系统临时目录 `Operation not permitted`。
10. **硬链接（审查后补测）**：在隔离里 `ln <隔离外的文件> <可写目录里的新名字>`，srt 和 Codex 两种隔离都是 `Operation not permitted`，外面的文件没变。所以选手不能借任务 `tmp/` 或副本里的硬链接去改 `job.json`、`report.md` 或家目录里的文件。

## 3. 自检探针

`src/core/selfcheck.ts` 的 `tempTargets` 加了 6 处，三种隔离都要写不进去：

- `tmp-lead`：`/private/tmp/claude-<用户号>`（负责人会话的临时目录）
- `tmp-shared`：`/private/tmp`
- `tmp-srt`：`/private/tmp/claude`（srt 的公用临时目录）
- `tmp-user`、`tmp-cache`：`getconf DARWIN_USER_TEMP_DIR`、`DARWIN_USER_CACHE_DIR` 的真实路径（在隔离外算好传进探针；查不到就算拿不准，自检不过）
- `npm-logs`：`~/.npm/_logs`

另加 `hardlink`：在任务 `tmp/` 里给隔离外的一个文件（自检目录里专门建的）建硬链接，必须被挡住。再加一项 `tmpdir`，必须**写得进去**：`TMPDIR` 正好指向这次自检给的任务 `tmp/`，且能建文件。写法沿用全局配置探针：已有目录里只建随机名文件，没有的按真实路径建；写成就算没挡住。不同的是这些是公用目录：探针万一在里面建出了固定名的目录（例如 `/private/tmp/claude-<用户号>`），里外都不删，只报错让负责人查（核对编号和删除之间，别的程序可能已换成它自己的同名目录）。没有 `~/.npm` 的机器上 `npm-logs` 改查家目录本身（建不出 `_logs` 会报“不存在”，误判成拿不准）。自检缓存升到第 3 版，旧缓存作废、派活时自动重检。

实测（临时登记处，不碰主人的 `~/.xagents`）：

- **新做法**：三种隔离的 6 处全部 `EPERM`，`tmpdir` 可写，全局配置等其余探针照旧通过，自检通过。审查后按第 6 节改完（加 `:tmpdir` 只读、硬链接探针等）重跑：仍全部通过，`hardlink` 三种隔离都 `EPERM`。
- **反向对照（换回旧模板、旧 Codex 权限表、不设临时目录变量，跑同一套探针）**：自检不过。Codex 能写 4 处（`tmp-lead`、`tmp-shared`、`tmp-srt`、`tmp-user`），Grok、Cursor 各能写 6 处；三种隔离的 `tmpdir` 都是“拿不准”（`TMPDIR` 不是任务的 tmp）。
- **清理核对**：两轮跑完，`/private/tmp`、`/private/tmp/claude`、`/private/tmp/claude-<用户号>`、系统给本用户的临时和缓存目录、`~/.npm/_logs` 里没有 `.xagents-selfcheck-*` 残留。

## 4. 真派小活验收

用新代码、临时登记处（`XAGENTS_HOME` 指向临时目录，不碰主人的 `~/.xagents`），登记一个临时仓库，经 `xagents run` 真派三家中档（Codex、Grok、Cursor · Grok）。题目：报告 `$TMPDIR`；用 `mktemp -p "$TMPDIR"` 建临时文件、写 hello、把路径追加到 a.txt、再删掉；试着 `touch /private/tmp/claude-<用户号>/xa-acc-probe` 和 `touch /private/tmp/xa-acc-probe`。

- 派活前自动自检通过（第 3 版）；三件都做完。
- 三家报告的 `TMPDIR` 都是各自任务目录下的 `tmp/`；a.txt 都改对，临时文件都建在 `tmp/` 里并删掉。
- 两次 `touch` 三家都是 `Operation not permitted`；外面核对两个文件都不存在。
- Cursor 的日志照旧落在任务 `tmp/cursor-agent-logs-501/`。

## 5. 剩下的代价和风险

- **只认系统临时目录的程序会报“没有权限”**：macOS 自带的 `mktemp` 不带 `-p`、用 `NSTemporaryDirectory` 或 `confstr` 的苹果工具（例如 Xcode、Swift 的部分命令）。前者规则里已写明；后者在隔离里本来也用不了（它们还要写 `~/Library`）。
- **任务目录路径较长**：`~/.xagents/jobs/<任务号>/tmp` 约 90 个字符，放在里面的 Unix 套接字文件名可能超过 macOS 的 104 字节上限。隔离本来就不让选手开本机通道，影响不大。
- **Grok 的 `/tmp/sessions/<会话号>` 建不成**：从程序里的提示词看，是它的“目标模式”叫模型用这个草稿目录，派活工作台不用这个模式；实测普通模式不受影响。
- **自检只跑可写题那一档**：只读题的隔离（srt 不放开副本、Codex 继承 `:read-only`）没有单独跑探针，靠第 2 节实测 9 手测。这是原来就有的做法。
- 选手仍能**读** `/private/tmp` 和 `/private/var/folders`（只是写不进去）。负责人会话的草稿、后台输出里若有敏感内容，选手读得到；这一点这次没改，另议。

## 6. 独立审查（Codex 高档、Grok 高档，只读）

两家都没发现“没挡住却判成挡住”、比以前更宽、或清理会跟着符号链接误删的地方；都核对了 srt 源码，确认 `denyWrite` 排在默认放行之后、能盖住 `/private/tmp/claude` 和 `~/.npm/_logs`，`CLAUDE_CODE_TMPDIR` 会盖过负责人环境里已有的值。提出的几条，负责人逐条核实：

1. **Grok：Codex 只把 `/tmp` 改了只读，`$TMPDIR` 仍可写，系统临时目录挡不挡全靠启动时设了 `TMPDIR`。** 成立（实测 9：不设 `TMPDIR` 时可写）。改：权限表加 `":tmpdir"="read"`。
2. **Grok：自检不跑只读题那一档。** 手测只读档没问题（实测 9）；自检仍只跑可写档，记在第 5 节。
3. **Grok：没有 `~/.npm` 的机器上 `npm-logs` 会误报拿不准。** 成立。改：这时改查家目录本身。
4. **Grok：能不能在任务 `tmp/` 里建硬链接改同级的 `job.json`（待核实）。** 实测挡住（实测 10）。改：加 `hardlink` 探针每天复查。
5. **Codex：公用目录里探针建出的固定名目录，核对编号和删除之间可能被别的程序换掉，误删别人的空目录。** 只在隔离已经漏了时才会发生，但成立。改：公用临时目录里新出现的固定名目录里外都不删，只报错。

两家自己跑 `npm test` 时，在当时的只读隔离里有大量“建临时目录被拒”，不能据此判断；负责人在隔离外跑，见下。

## 7. 清理

- 实验目录 `~/.xa-tmpexp/`（临时副本、临时登记处、验收用的临时仓库和它的副本）整个挪进废纸篓“派活工作台-临时目录实验-0930”。
- 实验在 `~/.grok/sessions` 留下的 3 个会话文件夹、验收时查额度在 `~/.cursor/projects` 留下的 1 个目录、`~/.codex/sessions` 里工作目录在 `~/.xa-tmpexp` 下的 3 份会话记录，同样挪进废纸篓。
- 核对：`/private/tmp`、`/private/tmp/claude`、`/private/tmp/claude-<用户号>`、系统给本用户的临时和缓存目录、`~/.npm/_logs`、家目录里没有 `.xagents-selfcheck-*`、`xa-probe-*`、`xa-acc-probe` 残留；隔离里被挡住的写操作本来就没建成东西。
- 主人的 `~/.xagents` 只在合并后跑了一次 `xagents selfcheck`（缓存升到第 3 版）；两件审查按规矩采用、打分、清理。
