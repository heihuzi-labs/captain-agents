# 参与船长派活

谢谢愿意来帮忙！修错字、补文档、报问题、写代码都欢迎。

## 动手之前

- 小改动（修 bug、改文档）直接提合并请求就行。
- 大一点的改动（新功能、改交互、动隔离规则），先开个议题聊一下思路，免得写完了方向对不上。
- 安全问题别公开，按 [SECURITY.md](https://github.com/heihuzi-labs/.github/blob/main/SECURITY.md) 私下报告。

## 跑起来

需要一台 Mac（目前只在苹果芯片上测过）、Node.js 24、pnpm。

```sh
pnpm install
npm run build && npx electron .     # 桌面应用
bin/xagents --help                  # 命令行
```

代码约定、目录分工都在 [AGENTS.md](AGENTS.md)，总体设计在 [docs/design.md](docs/design.md)，界面规矩在 [docs/ui-spec.md](docs/ui-spec.md)。

## 提交前跑这些

```sh
npm run typecheck
npm test            # 核心测试
npm run test:ui     # 界面测试
npm run build
npm run test:e2e    # 真实窗口冒烟测试，会开一个桌面窗口
```

`npm run verify` 会按顺序全跑一遍。测试不联网、不碰你真实的 `~/.xagents`，选手全用替身；新写的测试也请照这个来。冒烟测试开不了窗口的环境可以跳过，但请在合并请求里写明没跑。

## 这几条请特别注意

- **隔离规则只收紧、不放宽。** `sandbox/*.json`、`src/core/sandbox.ts`、`src/core/workers.ts` 里的每一条都来自实测。要改，请附上新的探针结果，说明在哪台机器、哪个版本的命令行上测的，测的过程可以参考 [docs/research/](docs/research/)。
- **选手名单只有一张表**：`src/core/roster.ts`。别在别处写死选手、模型或推理强度。
- **界面上的字都是中文**，只写人需要知道的；改界面先改 `docs/ui-spec.md`，只用 `app/renderer/ui/` 里的统一部件；附上浅色、深色、窄窗口的截图。
- 桌面应用自己不开端口、不联网、不读密钥和登录文件。

## 合并请求

写清楚改了什么、为什么、怎么验证的，模板里都有。一个合并请求只做一件事，方便看，也方便出问题时退回。

提交的代码按 [MIT](LICENSE) 许可证发布。

---

## Contributing (English)

Thanks for helping! Typos, docs, bug reports and code are all welcome.

- Small fixes: open a pull request directly. Bigger changes (new features, interaction changes, sandbox rules): open an issue first so we can agree on the direction. Security problems: report privately, see [SECURITY.md](https://github.com/heihuzi-labs/.github/blob/main/SECURITY.md).
- Setup: a Mac (tested on Apple silicon), Node.js 24, pnpm. `pnpm install`, then `npm run build && npx electron .` for the app or `bin/xagents --help` for the CLI. Conventions are in [AGENTS.md](AGENTS.md).
- Before submitting: `npm run typecheck`, `npm test`, `npm run test:ui`, `npm run build`, `npm run test:e2e` (or `npm run verify` for all). Tests stay offline, never touch your real `~/.xagents`, and use stand-ins for workers. If you can't open a desktop window for the smoke test, say so in the PR.
- Sandbox rules only get stricter. Any change to `sandbox/*.json`, `src/core/sandbox.ts` or `src/core/workers.ts` needs fresh probe results. Workers and models are listed only in `src/core/roster.ts`. UI text is Chinese; update `docs/ui-spec.md` first and use the shared components in `app/renderer/ui/`.
- Contributions are released under the [MIT](LICENSE) license.
