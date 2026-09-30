# 派活工作台（xagents）设计说明

**状态：** 已定稿。命令、任务记录、选手清单以代码为准（`src/cli/cli.ts`、`src/core/job.ts`、`src/core/roster.ts`）；本文写的是设计和理由。
**写于：** 2026-09-29。依据是当天的一轮实测：同样三道真题，交给 Codex、Grok 命令行、Cursor（Opus 5.5 / Grok 4.7）和我们自己的子代理各做一遍。桌面应用见 [design-desktop.md](design-desktop.md)，指挥手册、策略、评分见 [design-commander.md](design-commander.md)，界面规范见 [ui-spec.md](ui-spec.md)。

---

## 1. 要解决什么

负责人（Claude）把活派给本机的 Codex、Grok、Cursor 命令行去做，自己只管统筹、审查和验收。实测证明这样可行，但全靠临时脚本和会话里的记忆，不稳：

- 任务状态（谁在做、做到哪、副本在哪、测试过没过）只存在某一个会话里。会话一关、聊天被压缩，状态就丢了。
- 完成通知只发给派活的那个会话，换个会话就接不上。
- 安全设置靠每次记得加。实测里我就漏过两次，都是事后发现才补上：Codex 默认全放开，Cursor 自带的隔离形同虚设。
- 派活脚本在运行中被改过一次，导致三路任务的计时丢失。
- 15 份长报告全由负责人亲自读，很费精力。

**目标：** 做一个小命令行工具，把“开副本 → 派活 → 盯进度 → 收报告 → 外面验收 → 清理”固定下来。任务状态写进固定目录里的登记文件，任何会话都能接着管。安全设置写死在工具里。每次派活都留下记录，好比较各家在哪类活上更靠谱、各花多少额度。

## 2. 不做什么

- **不替负责人做判断。** 选派给谁、审改动、判真假、决定合并，仍然由负责人来做。工具只负责执行和记录。
- **不自动合并、不自动提交。** 提交和合并只有负责人手动做，而且按各项目自己的规矩（例如有的项目要先在桌面窗口里验收，主人点头后才合并）。
- **不在界面里派活、写题目、合并代码。** 桌面应用里主人只能看进度、记下决定（用这份、不要了、重做）、停下在跑的活、给负责人留言；派活、验收、合并、清理都走命令，由负责人来做。旧网页进度页和 `xagents board` 命令已下线。

## 3. 放在哪

| 位置 | 放什么 |
|---|---|
| `~/workspace/xagents/` | 工具本身（单独一个 git 仓库）：`src/core`（核心）、`src/cli`（命令行）、`app/`（桌面应用）、`sandbox/`（隔离模板）、`rules.md`（题目共同规则）、`skill/`、`test/`、`docs/` |
| `~/.local/bin/xagents` | 指向仓库 `bin/xagents` 的快捷方式，任何目录都能直接运行 |
| `~/.xagents/` | **登记处**：`jobs/`（任务记录）、`batches/`（批记录）、`projects/`（项目设置）、`cache/`（额度快照、自检结果、各种锁）、`config.json`（主人的设置）。不放进任何项目仓库，会话结束也不会删。用 `XAGENTS_HOME` 可改位置 |
| `~/.xagents/icons/` | 各家图标，安装时从本机已装的应用里导出，不进仓库 |
| `skill/SKILL.md` | 给负责人（Claude）的操作说明：什么时候派、派给谁、怎么验收。装到 `~/.claude/skills/xagents/` 使用 |
| 各项目的 `.claude/worktrees/xa-<任务号>` | 干活用的副本，沿用现有习惯，项目里已设为忽略 |

- 命令行和桌面应用共用 `src/core/` 的规则和数据：推理强度限制、额度拦截、自检拦截、“只能在锁里改任务记录”都只写在核心里，两个外壳不重复写。
- 用 Node 24 写，代码是 TypeScript，只用“可擦除”的写法，靠 Node 自带的“去掉类型直接运行”功能，命令行不用编译。命令行运行时只依赖外层隔离工具 `@anthropic-ai/sandbox-runtime`（`srt`，版本固定，装在工具目录里自己用）；桌面应用另用 Electron 和 React，见 [design-desktop.md](design-desktop.md)。

## 4. 命令

命令清单以 `xagents --help`（`src/cli/cli.ts`）为准。

```
xagents project add <名字> <仓库路径> [--label 显示名] [--worktree-root 相对路径] [--setup 命令] [--verify 命令] [--deny-read 路径] [--rules 文件]
xagents project list
xagents project label <名字> <显示名>               # 改看板上显示的中文名（1–20 字），不动体检记录
xagents project archive|unarchive <名字>          # 归档：看板已完成列和历史页“全部”不显示，记录打分都留着；归档的项目派活会被拦下
xagents project check <名字> [--quick] [--json]   # 接入体检：仓库状态、没提交的改动、副本目录、疑似密钥文件；完整模式还在临时副本里装依赖、跑验收记下底子
xagents quota [--json]                查三家剩余额度
xagents models                        列出各位选手实际要启动的模型，并和各家服务器上现有的核对
xagents workers                       主人当前允许的选手、强度、快速版、开关和派活限制
xagents run <题目文件> --summary "一两句要做什么" --who 选手:强度[:fast] [--who …]   # 主目录有没提交的改动会被拦下，确认无关加 --dirty-ok
            [--project 名字] [--base 提交] [--kind 类型] [--title 标题] [--ro] [--force] [--real ["一句说明"]]
                                      开副本、派活；同一道题派给几家就是一“批”，从同一个起点开副本
xagents status [任务号|批号] [--all]   一张表：谁、做什么、跑了多久、状态
xagents wait <任务号|批号>            等到做完；主人有新动作时也会提前返回
xagents collect <任务号|批号>         把报告整理成统一格式，算出用量
xagents stop <任务号|批号>            停下在跑的活
xagents clean <任务号|批号|--done>    删副本和分支；改动先存成 diff.patch，任务记录保留；已拍板须先打分
xagents slim [--dry-run] [--force]    到期旧日志移到废纸篓；预览会清几件、腾出多少 MB；force 只忽略自动清理开关
xagents connect                      看四家 AI 接入状态
xagents connect <claude|codex|grok|cursor> [--undo]  写入常驻规矩；--undo 撤下，原文件备份到废纸篓
xagents selfcheck                     隔离自检
xagents verify <任务号>               在隔离外跑这个项目的全套验收，结果记进任务
xagents real <任务号> --pass|--fail --note "一句说明" [--shot 截图路径]…  记录真实验收
xagents real <任务号> --skip "为什么不需要"  写明不需要真实验收的理由
xagents adopt|drop <任务号> [--note 给主人看的结论]    记下“采用”或“放弃”，不替你合并
xagents inbox                         列出主人在应用里做了、还等负责人照办的事
xagents handled <任务号>              标记已照办
xagents reply <任务号> "回复"         回复主人的留言
xagents report [--range today|7d|30d] [--project 名字] [--json]  仪表盘汇总（默认近 7 天，含已归档）
xagents stats                         按“选手 × 活的类型”汇总
xagents rate <任务号> [--score 1-5] [--good "做得好的"] [--improve "要改进的"] [--tag 标签]... [--external "外部原因"]
                                      给已结束的任务评价，改分保留最近 5 版历史
xagents profiles [--json]             按“选手 × 普通/快速版 × 活的类型”汇总档案
```

- `wait` 的退出码：`0` 都做完了，`1` 有出错或失联，`3` 主人有新动作（留言、用这份、不要了、重做）要先处理。
- 隔离自检没过不能派活；`run --force` 只对额度有效，不能跳过自检，也不能绕过主人在设置里对选手的限制。
- 类型只有修复、实现、审查、调研、测量；默认“实现”，起点默认 `main`，`--summary` 必填（1–200 字）。
- 验收一律用 `xagents verify`：结果记进任务记录，“各家表现”里的合格率只认这个记录。
- `--real` 标记真实验收；报告中的 `## 真实环境检查步骤` 会追加到记录。负责人采用前必须通过或写明跳过理由；主人拍板不受此把关。`real` 只用于已结束任务，说明 1–200 字且不能含控制字符；最多 10 张 PNG/JPEG/WebP 截图，每张最多 10 MB，重编号放到任务的 `shots/`，重做时旧截图移到 `shots-old/` 保留。
- `rate` 只接受 done、failed、stopped、lost；分数为 1–5 整数，分数和非空外部原因至少填一个。评语和外部原因各最多 200 字；标签最多 8 个，每个 1–12 字，去重；文字不得含控制字符。每次提交替换整份评价，旧版按时间顺序保留最近 5 版。批量清理会先列出全部已拍板但未评价的任务并拒绝；没拍板的照旧可清，`clean --done` 仍保留已采用任务。
- `profiles` 包含已清理任务的历史，只汇总已结束任务；带分数的计入 `rated`，带外部原因的不计入平均分。返工比例是带分数且有“需要返工”标签的件数 / `rated`；优点、毛病按当前评价里的标签计次，各取前 3，同次数按中文标签排序；其他标签不混入两类。最近评语按评价时间倒序取有 `good` 或 `improve` 的 5 件，不展开旧版。`rated < 3` 提示“样本少，仅供参考”。平均用时复用 `stats`（仅 done，扣休眠）。
- 同时在跑或排队的任务上限读取设置 `limits.maxRunning`，缺省 6，可选 1–6 件。`XAGENTS_MAX_RUNNING` 只供测试或临时收紧，取它与设置上限的较小值；`--force` 不能跳过。

`--who` 的写法是“选手:强度[:fast]”。强度写 `medium`、`high`、`xhigh`，界面上叫中档、高档、超高档；不开 `low`，也不许拉满（没有 `max`）。末尾加 `:fast` 用快速版（同一个模型跑在更快的机器上，按 2 倍扣额度），现在只有 `grok`、`cursor-grok`、`cursor-opus` 有。

选手清单写在一张纯数据表里（`src/core/roster.ts`），现在有六位：

| 选手 | 是什么 |
|---|---|
| `codex` | Codex，GPT-6 Astra（最强，给难活） |
| `codex-luna` | Codex，GPT-6 Luna（同一代又快又省的小模型，给小活；和 `codex` 共用 Codex 的隔离和额度） |
| `grok` | Grok 命令行，Grok 4.7 |
| `cursor-grok` | Cursor 里的 Grok 4.7 |
| `cursor-opus` | Cursor 里的 Claude Opus 5.5 |
| `cursor-sonnet` | Cursor 里的 Claude Sonnet 5.5 |

解析 `--who`、校验、启动参数、展示名、额度池、隔离自检、模型核对都从这张表派生，新增选手或改模型只改这一处，模型名的来源和核对日期也记在那里。

**主人在设置里的选手策略（已实现）**：每位选手的开关、允许的强度、快速版，存在 `~/.xagents/config.json` 的 `workers`，在清单上叠一层，再过底线（强度不许 max，Cursor 只许 Claude、GPT、Grok 的模型）。`run` 和应用界面都由核心强制执行，规则见 [design-commander.md](design-commander.md) 的 3b。

## 5. 一条任务从头到尾

```
登记(排队) → 开副本 → 派出 → 运行中 → 做完 / 出错 / 失联 / 被停止
                                       ↓
                                  收报告 → 验收（通过 / 没过） → 采用 / 放弃 → 清理
```

- **派出后，活脱离会话独立运行。** 由一个独立的看管进程启动选手、写日志、记下结束时间和退出码。关掉 Claude 会话，活照样继续。
- **失联的判断。** 状态写着“运行中”，但看管进程已经不在了，就改记为“失联”；排队中的活，派发进程和看管进程都不在了，改记为“出错”。电脑重启后常见这种情况。
- **每一步都写进登记文件。** 先写临时文件，再改名替换，写到一半断电也不会写坏；改任务记录一律在锁里“读 → 改 → 写”。
- **运行时用的是快照。** 派出时把题目（`prompt.md`）、共同规则、隔离设置、实际启动命令、工具源码和版本（`runtime/`、`versions.json`）都复制一份到任务文件夹里，运行中改工具或题目也不影响已经派出的活。这是这次“运行中改脚本导致计时丢失”的教训。
- **主人的动作只是记下来。** 主人在应用里点“用这份”“不要了”“重做”或留言，核心只写进任务记录，不改任务状态，也不做任何 git 操作；负责人用 `xagents inbox` 看到后照办，办完用 `xagents handled`（回复留言用 `xagents reply`）。负责人正在 `wait` 时，主人一有新动作就会被叫醒（退出码 3）；开始等之前就已经在待办里的旧事项不会再叫醒。
- **电脑休眠会被记下。** 看管进程发现两次检查间隔超过 60 秒，就把这段时间记进 `sleeps`；统计用时时扣掉。

## 6. 登记文件

每条任务一个文件夹：`~/.xagents/jobs/<任务号>/`。任务号格式是 `日期-时间-选手-题目名`，例如 `0929-0938-codex-fix`，按上海时区生成；题目名只留 ASCII 字母、数字和连字符，全中文文件名退回 `task`。

```
job.json        任务的全部状态（见下）
prompt.md       实际发出去的题目（共同规则 + 本题）
sandbox.json    实际用的隔离设置（Grok、Cursor 才有；Codex 用命令行传的权限档）
versions.json   Node 和本工具的版本
runtime/        派出时的工具源码快照
run.log         选手的原始输出
stderr.log      选手的错误输出
supervisor.log  看管进程的日志
setup.log       准备副本时项目 setup 命令的输出
report.md       整理后的报告（collect 或做完时生成）
verify.log      验收输出（verify 生成）
diff.patch      清理副本前保存的改动
tmp/            选手唯一可写的临时目录（它的 TMPDIR），清理时删掉
cursor-state/   Cursor 搬过来的配置和数据（只有 Cursor 活才有），清理时删掉
```

`job.json` 的字段（以 `src/core/job.ts` 的 `Job` 为准）：

| 字段 | 说明 |
|---|---|
| `id`、`batch` | 任务号、批号（同一道题派给几家时共用） |
| `project`、`repo`、`base` | 项目名、仓库位置、副本起点（提交号） |
| `worktree`、`branch` | 副本位置、分支名 `xa/<任务号>` |
| `who`、`model`、`effort`、`fast` | 选手、模型、推理强度、是否快速版（只在开着时写 `true`） |
| `mode` | `read-only`（`--ro`）或 `workspace-write` |
| `kind`、`title` | 活的类型（修复 / 实现 / 审查 / 调研 / 测量）、标题（默认题目文件名） |
| `summary` | 给主人看的“要做什么”，1–200 字，派活时必填；旧记录可以没有 |
| `state` | `queued` 排队 / `running` 运行中 / `done` 做完 / `failed` 出错 / `stopped` 被停止 / `lost` 失联 |
| `created`、`started`、`ended`、`seconds`、`exit` | 创建、开始、结束时间，用时（秒），退出码 |
| `pid`、`workerPid`、`setupPid`、`queuedBy` | 看管进程、选手进程、setup 进程、派发进程的进程号（判断失联用） |
| `stopRequested` | 已请求停止 |
| `command` | 实际启动的程序、参数、附加环境、输入输出约定 |
| `error` | 出错或失联的原因 |
| `usage` | 用了多少字：`read`（输入）、`cached`（缓存命中）、`out`（输出），Cursor 另有 `cacheWrite`，从各家输出里读 |
| `quota_before`、`quota_after` | 派出前后的额度快照，`stats` 据此估算每类活的额度花费 |
| `verify` | 验收结果：`ok`、`at`、`seconds`、每一步的命令 / 是否通过 / 摘要 |
| `decision` | 采用 / 放弃：`kind`（`adopt` / `drop`）、`note`（给主人看的结论，≤200 字）、`at`、`by`（`owner` 主人 / `lead` 负责人；旧记录缺这项按 `lead`）、`handled`（主人拍的板，负责人照办后记下时间） |
| `rating` | 负责人评价：`score?`（1–5）、`good?`、`improve?`、`tags`、`external?`、`at`、`by: lead`；有外部原因不计平均分；`previous?` 保留最近 5 版完整旧评价，每版不嵌套历史 |
| `realCheck` | 真实验收：`needed`、`steps`；`result` 含 `ok`、`note`、`shots`（任务目录 `shots/` 下文件名）、`at`、`by: lead`；或 `skipped` 含 `reason`、`at`。看板仅暴露截图张数，不暴露路径 |
| `redo` | 主人点了“重做”：`at`、`by`（只会是 `owner`）、`handled` |
| `comments` | 主人和负责人的往来留言：`by`、`text`（1–500 字）、`at`、`handled`（只写在主人的留言上，负责人回复或标记照办时记下） |
| `sleeps` | 任务运行期间电脑休眠过的时段：`from`、`to` |
| `activity` | 最近 50 条动作：`at`、`kind`（`cmd` 命令 / `edit` 改文件 / `read` 读 / `say` 说话）、`text` |
| `lastActivityAt`、`changedFiles` | 最近一次有动作的时间、副本里已改的文件数 |
| `cleaned` | 副本清理的时间 |
| `slimmed` | 旧日志已移到废纸篓：`at` 清理时间、`bytes` 移走前的总字节数、`files` 相对任务目录的文件或目录名；报告、改动、打分保留 |

`config.json` 的 `storage` 保存自动清理开关 `slim` 和天数 `days`（7 / 14 / 30，缺省开启、14 天）。只有已结束、已拍板、已打分、副本已清理且结束满指定天数的任务才清理；只移动 `run.log`、`runtime/`、`stderr.log`、`supervisor.log`、`setup.log` 中存在的项。默认放入 `~/.Trash/派活工作台-<任务号>`，重名加编号；`XAGENTS_TRASH` 可覆盖废纸篓目录。`--dry-run` 不移动文件、不写清理记录；逐件失败会输出说明并继续处理其余任务。清理后 `collect` 会提示保留的报告和改动位置。

批的记录放在 `~/.xagents/batches/<批号>.json`：`id`、`kind`、`title`、`summary`、`started`、`base`、`jobs`（成员任务号）。单个选手也生成批记录。

看板 `View.profiles` 与原有 `View.stats` 并存，档案字段由核心实时汇总：

| 字段 | 说明 |
|---|---|
| `who`、`fast`、`kind` | 选手、是否快速版、活的类型，三者共同分组 |
| `count`、`rated`、`small` | 已结束件数、有分数件数、有分数是否不足 3 件 |
| `avgScore`、`reworkRate`、`avgSeconds` | 平均分、返工比例（0–1）、仅 done 扣休眠后的平均秒数；无样本为 `null` |
| `good`、`bad` | 优点和毛病的 `{tag, n}` 列表，按次数降序，各最多 3 个 |
| `recent` | 最近 5 条有评语的任务：`id`、`title`、`at`、可选 `score`、`good`、`improve` |

### 正在做什么从哪来

看管进程边跑边读选手的输出，整理成统一的动作记录（`activity`：时间、类别〔命令 / 改文件 / 说 / 读〕、一句话），只留最近 50 条，写进任务记录；同时每 30 秒数一次副本里改了几个文件（`changedFiles`）。这就要求三家都用“边做边输出”的格式：
- Codex 本来就是（`--json`）；
- Grok 用 `--output-format streaming-json`；
- Cursor 用 `--output-format stream-json`。

结果（报告、用量）也从这些流里取。三份原始样本放在 `test/fixtures/streams/`，用于解析测试。

### 真实验收记录约定

#### 任务记录字段（`src/core/job.ts` 的 `Job`）

```ts
realCheck?: {
  needed: boolean;          // 这件活需要真实环境验收
  steps: string[];          // 检查步骤，每条一句（来自选手报告，或派活时负责人写的说明）
  result?: { ok: boolean; note: string; shots: string[]; at: string; by: 'lead' };  // shots 是任务文件夹里 shots/ 下的文件名
  skipped?: { reason: string; at: string };   // 负责人写明理由不做
};
```

- **派活时标记**：`xagents run … --real ["一句说明"]` → `needed: true`，说明（如有）作为第一条步骤。
- **从选手报告收步骤**：任务结束收报告时，如果 `report.md` 里有标题为 `## 真实环境检查步骤` 的一节，取这一节里的条目（`-`、`*` 或 `1.` 开头的行，去掉前缀，最多 20 条，每条最多 200 字）追加进 `steps`，并置 `needed: true`。
- **给选手的规矩**（`rules.md`）：活里有需要真实浏览器或桌面才能看到的效果时，报告里必须写这一节，写清“点哪几步、看到什么才算对”。

#### 记录命令

```
xagents real <任务号> --pass|--fail --note "一句说明" [--shot 截图路径]...
xagents real <任务号> --skip "为什么不需要"
```

- 只能用在已结束的任务上；`--note` 必填（1–200 字，不含控制字符）；截图最多 10 张，只收 `.png/.jpg/.jpeg/.webp`，每张不超过 10 MB，复制进 `~/.xagents/jobs/<任务号>/shots/`（文件名重编号，不用原名）。
- 可以重做：新结果覆盖旧结果，旧截图移走（移进任务文件夹里的 `shots-old/`，不删）。
- **采用把关**：`decide(…, 'adopt', …, 'lead')` 时，如果 `needed` 为真，且没有 `result.ok === true`，也没有 `skipped` → 拒绝，中文说明：“这件活需要真实环境验收，还没做（或没过）。先用 xagents real <号> --pass 记下结果，或 --skip 写明为什么不需要。”主人在应用里点“用这份”（`by: 'owner'`）不受这个把关（主人的决定只是记下来，负责人照办时才采用）。

#### 看板数据

`ViewJob` 提供：
```ts
realCheck: { needed: boolean; steps: string[]; result: { ok: boolean; note: string; at: string; shotCount: number } | null; skipped: { reason: string; at: string } | null } | null;
```
截图路径不进看板数据（这一版应用里只显示张数）。

## 7. 三家怎么派（安全设置写死在代码里）

以下全部来自这次实测，每条都有探针结果作依据。

| 选手 | 启动方式 | 隔离 | 能写 | 能连网 |
|---|---|---|---|---|
| Codex | `codex exec --ignore-user-config`，关掉插件、连接、操作屏幕、操作浏览器、钩子、记忆；`TMPDIR` 指向任务的 `tmp/` | 自带权限档 `xa`，继承 `:workspace`（`/tmp`、`$TMPDIR` 改只读）；只读题继承 `:read-only` | 副本、任务的 `tmp/` | 命令一律不能联网，本机端口也不行 |
| Grok 命令行 | `grok --sandbox off`，关掉顺带 Claude 和 Cursor 的规则、钩子、外部连接、技能，关掉记忆和自动更新；派活前平台先在隔离外刷新登录 | 外层 `srt`（它自带的隔离在 Mac 上管不住网络，只读档在本机起不来） | 副本、任务的 `tmp/`、`~/.grok/sessions` 里本副本自己的会话文件夹 | 只能连 Grok 自家服务器 |
| Cursor | `cursor-agent -p --force --trust`；只读题用 `--mode ask`；配置和数据目录搬到任务目录 | 外层 `srt`（它自带的实测无效） | 副本、任务的 `tmp/`、任务目录下的 `cursor-state/` | 只能连 Cursor 自家服务器 |

所有选手都遵守：
- **不开放本机端口。** 本机上常有浏览器调试口、代理软件、API 转发服务在监听。
- 各家隔离都挡住读取：`~/.ssh`、`~/.npmrc`、包括自身在内的登录文件、设置里额外禁读的目录（`config.json` 的 `denyReadHome`）、项目的 `.data/`、`~/.claude`、`~/.aws`、`~/.config/gh`。（Grok、Cursor 整个跑在外层隔离里，自己的登录文件必须能读，否则启动不了；挡住的是别家的。）
- **各家的全局配置对选手一律只读**：`~/.cursor`、`~/.local/share/cursor-agent`、`~/.grok`、`~/.claude`、`~/.agents`、`~/.codex` 都写不进去。这些地方放着钩子、技能、规矩、外部连接、插件、管理员配置和程序本身，主人之后在隔离外打开 Cursor 或 Grok 就会被加载，钩子还会以主人的账号直接执行、没有确认弹窗；选手能写就等于能逃出隔离。所以选手能写的只有：副本、这件活自己的临时目录（见下一条），外加各家必需的一处：Cursor 用 `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR` 把配置、聊天记录、项目状态和信任标记搬到任务目录（`xagents clean` 时删掉）；Grok 只放开本副本自己的会话文件夹（按副本路径转义算出，带通配符 `* ? [ ]` 的写法不放开，路径不规范就不派）。Grok 的登录刷新要写 `~/.grok`，所以派 Grok 活前由平台在隔离外先刷新（剩不到 5 小时就换新，刷新报错就不派），选手干活期间一般用不着刷新。依据是 [2026-09-30 实测](research/global-config-writes-2026-09-30.md)。
- **公用临时目录也不许写，每件活一个专用的 `tmp/`**（任务目录下，`xagents clean` 时删掉）。`/private/tmp` 下有负责人（Claude Code）会话的草稿和后台任务输出（`/private/tmp/claude-<用户号>`），`/private/var/folders` 下有别的程序的临时文件和套接字，选手能写就能伪造负责人读到的输出、影响别的程序。做法：Grok、Cursor 的模板只放开 `__TMP__`（任务的 `tmp/`），并显式禁写 srt 自己默认放开的 `/private/tmp/claude` 和 `~/.npm/_logs`；启动 srt 时设 `CLAUDE_CODE_TMPDIR=<任务的 tmp>`，srt 据此给选手设 `TMPDIR`（不设就是公用的 `/tmp/claude`）。Codex 的权限表把 `:slash_tmp`、`:tmpdir` 都设为只读、任务的 `tmp/` 写明可写，启动时 `TMPDIR` 也指向它。硬链接也挡住了：选手不能在可写目录里给外面的文件建硬链接、借此改它。共同规则 `rules.md` 告诉选手临时文件写 `$TMPDIR`：Grok 的系统提示叫模型把草稿写到 `/tmp/`，“除非用户或项目规矩另指地方”；macOS 自带的 `mktemp` 不带 `-p` 时优先用系统给用户的临时目录、不看 `TMPDIR`。依据是 [2026-09-30 临时目录实测](research/tmp-writes-2026-09-30.md)。
- **不准提交代码、不准用 `git stash`。** 副本的提交记录库在隔离外面，想提交也写不进去。
- **Codex 禁读缺口已堵上：** 启动和自检共用 `permissions.xa` 权限表，禁读研究推荐路径与项目 `denyReadExtra`（仓库、副本各一份），仅将 `~/.codex/tmp` 重新开放为可读。依据是 [2026-09-29 权限研究](research/codex-permissions-2026-09-29.md)。禁止混用 `-s` 或 `sandbox_mode`，否则权限档会失效；真实 `codex exec` 仍须负责人验收。

派活前检查**自检**结果：用最终权限设置测副本内写、目录外写、Chrome 调试口、本机监听端口、外网，SSH、npmrc 和三家登录文件，21 处全局配置，以及 6 处公用临时位置（负责人会话的临时目录、`/private/tmp`、srt 的 `/private/tmp/claude`、系统给本用户的临时和缓存目录、`~/.npm/_logs`；三种隔离都要写不进去，别家的也不行）；同时要求 `TMPDIR` 正好指向这件活的 `tmp/` 且写得进去、在里面给外面的文件建硬链接被挡住。公用临时目录里探针万一建出了固定名的目录，不自动删，只报错。全局配置探针对已有文件用只写、不截断、不新建的方式打开，不改内容；对已有目录只建随机名空文件；还没有的按真实路径建出来。只要写成了就算没挡住（删不掉另记原因）；建出的东西连同文件编号报给外面，外面只删编号对得上的，对不上或探针没报告的一律不删、报错。Codex 探针用空的临时 `CODEX_HOME` 和 `codex sandbox -P xa -C <副本> -c <共用权限表> -- node <探针>`，结束后清理。srt 探针向代理发送 HTTP Basic 或 SOCKS5 用户名密码认证；直连与代理都明确拒绝才算挡住，HTTP 403 算拒绝，407、超时或文件不存在都算拿不准。自检不过，就不派活。自检结果缓存一天，旧缓存缺少新探针不能放行；探针做法改了就升缓存版本号，旧版本缓存作废、派活时自动重检。

## 8. 额度

- **Codex**：读最近一次会话记录里它的服务器报回来的额度（每周窗口、已用百分比、重置时间）。
- **Grok**：通过 `grok agent stdio` 调它内部的 `_x.ai/billing` 接口。
- **Cursor**：模拟终端打开交互界面，敲 `/usage`，分别读出“自家模型池”和“其他模型池”的用量。在隔离外跑，工作目录是 `~/.xagents/cache/cursor-usage-*` 临时目录，同派活一样用 `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR` 把配置和项目状态（含信任标记）搬进这个临时目录，查完一起删，不在 `~/.cursor/projects` 留目录（2026-09-30 实测：换目录后仍是登录状态，`/usage` 照常读出）。

规则：派出前先查。某家本期已用到设置里的 `limits.quotaStop` 就拒绝派给它（缺省 80%，可选 50%、60%、70%、80%），确实要派得加 `--force`。两条派活限制都在设置 → 选手与模型 → 派活限制调整，`workers` 和 `guide` 会显示当前设置值。前后两次快照都记进任务，`stats` 据此估算每类活大概花多少额度。实测参考：Codex 或 Grok 做一题约占每周额度的 0.3%，Cursor + Grok 约占当月自家模型池的 0.3%，Cursor + Opus 约占当月其他模型池的 3.7%。

## 9. 项目设置

每个项目一份设置：`~/.xagents/projects/<名字>.json`。放在项目外面，不改动项目仓库。例如：

```json
{
  "repo": "/Users/me/code/my-app",
  "worktreeRoot": ".claude/worktrees",
  "setup": ["pnpm install --offline --frozen-lockfile", "pnpm -r run build"],
  "verify": ["pnpm verify"],
  "denyReadExtra": [".data"]
}
```
另有可选的 `rules`（这个项目自己的题目共同规则文件）和 `verifyTimeoutMinutes`（验收超时，默认 20 分钟）。

主人的设置（防休眠、通知、看板列颜色、选手策略、额外禁读的家目录位置 `denyReadHome`）在 `~/.xagents/config.json`，由应用的设置窗口和核心读写，见 [design-desktop.md](design-desktop.md)。

验收一次只跑一个：同时跑会互相拖慢，检查进程收尾的那个测试还会卡住。

`verify` 带排队锁：同一个项目同一时间只跑一份验收。

## 10. 题目

- **共同规则**（工具里的 `rules.md`）：只在副本里干活；不提交、不用 `git stash`；不开桌面程序和浏览器；不读密钥和 `.data/`；忽略全局规则里只对负责人有效的部分（比如改会话标题）；本机端口不能用，需要端口的测试写明跑不了、交给负责人跑；最后用中文写报告，包括结论、依据（带文件和行号）、改了什么、怎么验证的、没做完或不确定的地方。
- 每道题一个 Markdown 文件，写清任务、要求和“查清再改”。
- 派出时把共同规则和本题拼成 `prompt.md`，存进任务文件夹。

## 11. 多个会话同时用

- 登记处按文件夹划分：每条任务一个文件夹，任务号唯一，建文件夹这一步本身就能保证不会撞号。
- 同一时间只有一个会话能修改某条任务。修改时先加文件锁，锁坏了（持有者已经不在）自动解除。
- 任何会话都能 `status`，都能接手收报告、跑验收。

## 12. 怎么测

三层，都不联网、不碰真实的 `~/.xagents`（用临时 `XAGENTS_HOME`），真实选手一律用替身：

- **核心**：`npm test`（`node:test`，`test/*.test.ts`）。用临时登记处、临时 git 仓库和离线选手替身（`test/fixtures/worker.ts`），覆盖拼题目、写登记文件（包括写到一半断掉的情况）、失联判断、隔离设置、三家输出和额度的解析、加锁、决定 / 留言 / `wait`、选手策略，以及界面规范里能自动检查的部分（`test/ui-spec.test.ts`）。
- **界面**：`npm run test:ui`（`vitest` + jsdom + Testing Library，`test/ui/`）。用假的看板数据驱动组件，检查显示、按钮和键盘操作。
- **真实窗口冒烟**：`npm run test:e2e`（`test/e2e/smoke.ts`，Playwright 启动构建好的 Electron 应用）。必须先 `npm run build`，要能打开窗口；用临时登记处和临时用户数据，截图放进已忽略的 `test/e2e/artifacts/`。隔离环境里不能跑，交给负责人。

`npm run verify` 依次执行类型检查、核心、界面、构建、冒烟，失败即停。

真实选手的冒烟（每家跑一道“往文件里写一句话”的小题，要花一点额度）不在自动测试里，由负责人手动做；隔离自检的探针用 `xagents selfcheck`。

## 13. 风险和还没解决的

- **安全加固靠自检和真实小活验收。** Codex 禁读缺口按[权限研究](research/codex-permissions-2026-09-29.md)已改为权限档；Grok、Cursor 的全局配置已改为只读（[2026-09-30 实测](research/global-config-writes-2026-09-30.md)）。改隔离后负责人须在隔离外运行自检、真派小活；不能以放宽读写来绕过失败的自检。自检只查列出的那些位置，不能证明所有会被加载的位置都安全。
- **Grok 活跑得很久时可能让主人的 Grok 登录失效。** 派活前平台在隔离外刷新登录（剩不到 5 小时就换新），刷新命令报错就不派。但 Grok 没有命令能报出令牌还剩多久，它刷新失败时也可能先用着没过期的旧令牌、照样返回成功，所以“至少剩 5 小时”不是百分之百。令牌在选手干活时到期，它会在隔离里刷新、写不回去，旧令牌又已作废，主人要重新登录一次。这期间派过别的 Grok 活（会再刷新一次）就没事。
- **只认系统临时目录的程序在隔离里写不了临时文件。** 公用临时目录已对选手关上（[2026-09-30 实测](research/tmp-writes-2026-09-30.md)），选手只能写这件活的 `tmp/`。不看 `TMPDIR`、直接用系统给用户的临时目录的程序（macOS 自带的 `mktemp` 不带 `-p`、部分苹果开发工具）会报“没有权限”；共同规则里已告诉选手怎么写，实测模型撞一次就会改用 `$TMPDIR`。Grok 每次还想在 `/tmp/sessions/<会话号>` 建一个草稿目录，建不成不影响干活。
- **Cursor 的额度要靠模拟终端去读界面文字。** 它改了界面就会读不出来，所以读不出来时只报“查不到”，不拦派活。
- **Grok 用量太少时，它的服务器不给数字，只能显示“不到 1%”。**
- **各家程序会自动更新，参数可能改名。** 自检会发现派不出去，但不会自动修好，需要人来改设置文件。
- **大量任务同时跑会拖慢整台电脑。** 默认同一时间最多跑 6 路，可以改。
