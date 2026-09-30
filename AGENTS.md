# 派活工作台（xagents）项目规则

给在这个仓库里干活的人和助手看。总体设计见 [docs/design.md](docs/design.md)，桌面应用见 [docs/design-desktop.md](docs/design-desktop.md)，界面规范见 [docs/ui-spec.md](docs/ui-spec.md)。

## 说话

- 对主人的一切回复用中文大白话：先说做了什么、怎么验证的、有没有坑，少用术语。代码、命令、提交说明可以用英文。
- 界面上的字全部中文、给人看：只写人需要知道的，不写会引起误会的猜测（比如“可能卡住”），状态用颜色表达。

## 技术约定

- 现在是“命令行 + 桌面应用”，两边共用 `src/core/` 一份核心；命令行在 `src/cli/`，桌面应用在 `app/`（`main` 后台、`preload` 桥、`renderer` 界面、`shared` 共用类型）。规则只写在核心里，两个外壳不重复写。
- Node 24 + TypeScript，只用可擦除的写法（不用 `enum`、`namespace`、参数属性）。
- 命令行入口是 `bin/xagents`（`package.json` 的 `bin`），由 Node 直接运行 `src/cli/cli.ts`，不编译。桌面应用用 electron-vite：`npm run dev` 开发，`npm run build` 构建，应用入口 `out/main/index.js`。
- 运行时依赖（`package.json` 的 `dependencies`）：`@anthropic-ai/sandbox-runtime`（选手隔离）和桌面界面用的 `react`、`react-dom`、`react-markdown`。开发依赖是构建、打包、类型检查、测试、截图这几类工具（Electron、electron-vite、Vitest、Playwright 等）。加任何依赖先说明理由。
- 写登记文件一律先写临时文件再改名；改任务记录一律在锁里“读 → 改 → 写”。

## 测试与验收

- 三层测试，都不联网，不碰真实的 `~/.xagents`（用临时 `XAGENTS_HOME`），真实选手一律用替身：
  - 核心测试：`npm test`，`node:test` 跑 `test/*.test.ts`。
  - 界面测试：`npm run test:ui`，Vitest + Testing Library，测组件。
  - 真实窗口冒烟测试：`npm run test:e2e`（`test/e2e/smoke.ts`），用 Playwright 真的启动 Electron 窗口点一遍。它要开桌面窗口，**在隔离里跑不了**，交给负责人验收，报告里写明没跑。
- 验收命令是 `npm run verify`：类型检查 → 核心测试 → 界面测试 → 构建 → 冒烟测试，全过才算通过。
- 在隔离里能跑的是 `npm run typecheck`、`npm test`、`npm run test:ui`；没跑的项不许说“已通过”。

## 安全底线（不许为了方便放宽）

- 选手的名单和模型集中在 `src/core/roster.ts`，那是唯一的一张表；解析选手、启动参数、额度、隔离、自检都从它派生，不在别处写死选手。
- 选手的启动参数和隔离模板（`src/core/workers.ts`、`sandbox/*.json`，Codex 的在 `src/core/sandbox.ts`）每一条都来自 2026-09-29 的实测，改动要附新的探针结果。
- 推理强度只开中档、高档、超高档，不开最高档；Cursor 里只用 Claude、GPT、Grok 的模型（`roster.ts` 的底线）。
- 主人在设置里允许哪些选手、哪些强度、要不要快速版（`src/core/policy.ts`），平台在派活时强制执行，`--force` 也跳不过；设置只能在底线之内收窄，不能放宽。
- 不给选手开本机端口，不让选手写副本以外的地方（例外只有每件活自己的临时目录和各家必需的一处状态目录，公用的 `/tmp`、`/var/folders` 也不行，见 [docs/design.md](docs/design.md) 第 7 节；各家全局配置一律只读），不让选手读密钥和登录文件。
- 桌面应用自己不开端口、不联网、不读密钥和登录文件；窗口只能通过桥上白名单里的函数做事，参数先检查。
- 干活的一方不提交、不 push、不用 `git stash`；提交和合并只由负责人做。

## 界面

- 界面规矩以 [docs/ui-spec.md](docs/ui-spec.md)（统一规范）和桌面应用为准。改界面先改规范，再改代码。
- 只用统一部件（`app/renderer/ui/`）和规范里的变量，不另写一份图标、弹窗、按钮、颜色。
- 改完截图检查：浅色、深色、窄窗口，外加弹窗。
- 选手的动作、主人的留言等内容一律当纯文字显示，不当网页代码插入。
- 各家图标在安装时从本机已装的应用里导出，不进仓库。
- 旧的网页进度页已下线（2026-09-29），界面只有桌面应用一个。各家图标在 `~/.xagents/icons`。
