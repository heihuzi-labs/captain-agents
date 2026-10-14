# Windows 应用内更新：交付与待验收记录

日期：2026-10-14。起点：主线 `2ac295f`。本记录只报告本副本内的实现和验证；未提交、未推送、未发布，没有启动桌面、浏览器或本机下载站。

## 结论

Windows 在线更新代码、EXE 发版支持、替身测试和 Windows 完整演练作业已补齐。macOS 原有 ZIP 解压、codesign 核对与独立安装脚本未改。正式配置已加入 `win-x64`，但 Windows 真包安装更新仍须负责人跑流水线确认，不能据本记录直接认定真机通过。

信任来自原有 Ed25519 签名清单及包大小、SHA-256。Windows 再核对正式文件名、PE 格式和内嵌版本，不做 Authenticode；不新增依赖。下载、主机名单、清单地址、桶优先与换源重试共用原链路。

## 每处改动与依据

以下行号指本副本最终文件。

| 文件与行号 | 改动 |
|---|---|
| `app/main/update-runtime.ts:14,35,44,57` | Windows 不再固定 off；启动清残留；下载和准备 EXE；重启前复核、直接起安装器、成功启动后退出 |
| `app/main/update-windows.ts:17` | 安装目录检查：程序、卸载器、app.asar；拒绝解压版、链接、不可写位置；实际创建空目录试权限 |
| `app/main/update-windows.ts:35,40,48` | 正式文件名和版本、大小/哈希、PE 内嵌版本；准备失败删下载 |
| `app/main/update-windows.ts:52,62,68` | 新版启动清 EXE，遇占用重试；构造 NSIS 参数、引用 argv0、直接 detached spawn，无外壳 |
| `app/main/update-exe.ts:5` | 有界读取 PE 头、资源目录和 VS_FIXEDFILEINFO，确认是 EXE 并返回四段版本，不运行下载文件 |
| `app/main/update-install.ts:7,20` | 现有安装位置入口转入 Windows 判断，其余 Mac 函数保留 |
| `app/main/update-download.ts:129,135` | 完整文件名可指定，`.part`、原子改名、大小和哈希、换源照旧；Mac 默认仍为 package.zip |
| `app/main/updater.ts:13,54` | 把已验签的清单版本传给下载适配器，状态机不另写 Windows 一套 |
| `build/installer.nsh:3` | 覆盖 NSIS 默认进程检查，用原生插件等进程退出，不启动 PowerShell/cmd、不杀后台任务 |
| `package.json:103` | NSIS 明确载入自定义检查；不改变向导、按用户默认、自选位置或包名 |
| `app/renderer/components/Update.tsx:45` | 仅 Windows 就绪提示改为先等活结束；Mac 文案、界面结构不变 |
| `docs/ui-spec.md:466` | 先登记 Windows 的入口和就绪文案规则 |
| `release/config.json:12` | 正式 targets 加 win-x64 |
| `scripts/release/make-update.mjs:8,43,57` | Windows 要 EXE，其他平台 ZIP；两份清单、二次大小/哈希复核沿用 |
| `scripts/release/publish-store.mjs:13` | Windows 桶对象名以 .exe 结束，不再错拼为 .zip |
| `test/update-windows.test.ts:32,51,73,91,104` | 安装目录、PE/版本/哈希拒绝、换源/状态机、篡改后禁止重启、参数/启动错误、无 PowerShell 检查 |
| `test/update-release.test.ts:49,179,228` | 三平台发版、双清单和 Windows 桶上传读回替身测试；拒绝跨平台错扩展名 |
| `test/update-state.test.ts:26` | Windows 带配置的正式版不固定 off |
| `test/update-install.test.ts:20` | 原“其他平台拒绝”的用例改用 Linux；Mac 原有安装测试保留 |
| `test/e2e/update-site.ts:31` | 原测试站的坏包、断开、慢速场景同时支持 EXE，ZIP 路径不变 |
| `test/e2e/update-windows.ts:1` | 两份真 NSIS 包、临时测试密钥、两份 HTTPS 测试站、真实按钮、原位置换版、自动打开窗口、下载清理；只准一次性 CI runner 跑 |
| `.github/workflows/windows-probe.yml:17` | 独立 online-update 作业，无正式机密，只上传报告与截图，不发布 |
| `docs/design-update.md:200` | 第 4.9 节写 Windows 做法、模板依据、旧 Mac 兼容与限制 |
| `docs/design-windows.md:184,223,235,255,286,354` | 第 5、7、9、11 节同步实现状态、无 Windows 代码签名、按用户更新；第 5 步标为“代码做了、待流水线验” |
| `docs/release-checklist.md:49,54,74,101` | 补三种包名、Windows 发版前演练、存桶命令的 Windows --package |
| `release/README.md:8` | 三种正式 targets 和 EXE/ZIP 说明 |
| `docs/windows-real-machine.md:110` | 真机清单改为检查 Windows 更新入口、解压版/不可写位置的手动安装原因 |

## NSIS 参数与进程交接的事实

依据是本机 `electron-builder 26.15.3` 所带 `app-builder-lib`，位置前缀：

`node_modules/.pnpm/app-builder-lib@26.15.3_dmg-builder@26.15.3_electron-builder-squirrel-windows@26.15.3/node_modules/app-builder-lib/`

| 文件与行号（相对上述前缀） | 事实 |
|---|---|
| `templates/nsis/uninstaller.nsh:12–18` | 显式识别 /S 并设静默模式；安装程序本身也使用 NSIS 的 /S |
| `templates/nsis/multiUser.nsh:50–54,93–97` | /D 优先覆盖安装目录 |
| `templates/nsis/multiUser.nsh:102–141` | /D 必须最后、不能带引号；从原始命令行取其后完整文字，因此路径内空格不需要引用 |
| `templates/nsis/assistedInstaller.nsh:129–133` | /currentuser 强制按当前用户安装，避免静默路径走全局安装提权 |
| `templates/nsis/installSection.nsh:105–109` | 向导模式静默安装必须带 --force-run 才会装完自动打开 |
| `templates/nsis/common.nsh:123–132` | StartApp 经原生插件打开新版，更新时传给新版 --updated |
| `templates/nsis/installSection.nsh:33–37`、`templates/nsis/uninstaller.nsh:1–2` | 安装器和卸载器都调用 CHECK_APP_RUNNING |
| `templates/nsis/include/allowOnlyOneInstallerInstance.nsh:32–42,45–100,105–164` | 默认调用 PowerShell/cmd 查、杀进程；带 --updated 只先等约 300ms/1000ms，仍可能强杀后台任务；所以必须覆盖 |
| `templates/nsis/include/installUtil.nsh:205–206,224` | 升级时也会运行旧卸载程序，并传 --updated 保留用户数据 |
| `out/targets/nsis/NsisTarget.js:186`、`out/appInfo.js:66–85` | NSIS 固定文件版本来自 x.y.z 加构建号；当前 GitHub 配置没有额外 buildNumber，末段为 0 |

正式调用为：`/S --updated --force-run /currentuser /D=<当前安装目录>`。安装程序是唯一直接启动的文件，不经 PowerShell/cmd。`windowsVerbatimArguments: true` 保留 /D 原文，同时单独给 argv0 加双引号以支持下载目录中的空格；依据是 [libuv 参数生成](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c#L490-L551) 与同文件的 CreateProcessW 调用。

自定义检查只等待，不杀进程，最长 60 秒。任何同名应用进程（包括使用同一个程序的后台任务）还在时停止安装。这是 Windows 与 Mac 的区别，不能照搬“在跑的活不受影响”的 Mac 更新说明。待负责人定的 Windows 文案已经写进规范和代码：**“安装时会关闭并重新打开应用，请先等待正在运行的活结束。”**

## 老 Mac 版与发版脚本核对

- 0.2.0、0.2.1 的解析器取自历史提交 `54c6a7b:app/main/update-feed.ts`；0.2.2、0.2.3 取自 `f9ee590:app/main/update-feed.ts`。对照文件只复制在本任务 TMPDIR 内。
- 用临时测试 Ed25519 密钥签了同时含 `darwin-arm64`、`darwin-x64`、`win32-x64` 的清单；前两个旧版读取旧 url 格式，后两个读取 urls 格式，逐一调用各自原始 verifyFeed/selectUpdate。
- 结果：四个版本全部能验签、解析，并在两种 Mac 架构上选中自己的包。旧解析器没有 ZIP 扩展名或固定平台枚举限制。因此 latest.json 也保留 Windows 条目；不改旧协议字段、不改最低版本，老 Mac 不会被新 Windows 包挡住。
- `.github/workflows/build.yml:188–197,274–278` 已有 Windows 安装器收集和通用 artifacts/* 上传，不用改；`release.yml:104–109,139,147–149` 按 package-* 下载、packages/* 上传草稿并逐字节 diff，没有 ZIP 过滤，也不用改。`release-inputs.mjs:22,79–84` 原来已映射 Windows 包名并按 targets 生成三平台清单。
- make-update 和 publish-store 两处原来的 ZIP 限制已修；新增替身测试覆盖 EXE 签名清单、桶路径、上传读回和错扩展名拒绝。

## 已运行的验证

| 命令 | 结果 |
|---|---|
| `CI=true pnpm install --frozen-lockfile --store-dir "$TMPDIR/pnpm-store"` | 成功；锁文件未改、没有加依赖 |
| `npm run typecheck` | 通过，包含新增端到端脚本的类型检查 |
| `npm test` | 746 项：通过 740，跳过 6，失败 0 |
| `npm run test:ui` | 32 文件，290 项通过 |
| `node --test test/update-windows.test.ts test/update-release.test.ts test/update-install.test.ts test/update-download.test.ts test/update-state.test.ts` | 106 项全部通过；也覆盖最终 argv0 引用改动 |
| `npm run build` | 主进程、preload、renderer 都构建成功，没有打开窗口 |
| `node --check test/e2e/update-windows.ts`、`node --check test/e2e/update-site.ts` | 语法通过，未执行脚本 |
| 用已安装的 js-yaml 解析 windows-probe.yml、release.yml、build.yml | 都可解析；分别 5、3、1 个作业 |
| 用 windowsExecutableVersion 只读依赖自带的真实 rcedit.exe | 正常返回 0.2.0.0；没有执行 EXE |
| `node "$TMPDIR/check-old-feeds.mjs"` | 四个旧 Mac 版本的历史解析器兼容验证全部通过 |
| `git diff --check` | 通过 |

输出都在本任务 TMPDIR：`typecheck.log`、`core-tests.log`、`ui-tests.log`、`update-tests-final.log`、`build.log`、`old-feed-compatibility.log`。测试及构建进程已结束。

## 没跑与最容易出问题的地方

- **Windows 端到端检查：没跑。真实窗口冒烟 npm run test:e2e：没跑。npm run verify 整体：没跑。** 本机是 macOS 隔离，不能开桌面或监听本机端口；没有绕过限制。
- **Windows 真 NSIS 包的编译和安装：没跑。** 新增自定义宏、插件返回码以及 ExecShellAsUser 在 GitHub 桌面会话中的实际表现，首先要看 online-update 作业；该作业先确认自动出现了新版窗口，再另起新版检查 UI，不会把“手动又启动了一次”冒充自动启动成功。
- 最容易出错的是 /D 原文和 argv0 引用、旧应用退出释放文件、NSIS 打开新版时丢掉启动环境、安装器尚未退出时清下载。探针故意用含空格的临时路径、含中文/空格/& 的安装路径，并使用 runner 账户默认数据目录，避免新旧两版读不同数据造成假成功。
- “给所有人装”以及管理员运行的全局安装不在本次自动更新真机验收范围；实现按用户启动安装程序，不替用户提权。写不进的安装目录提示手动安装，普通用户下应实测这一点。
- 已发出去的不带更新功能的 Windows 包，需要先手动装第一版带此功能的安装包。旧卸载器已经内置的默认 PowerShell 检查不能由新应用改写；本次构建的安装器和卸载器都使用新的原生检查。
- Windows 失败处理交给 NSIS；没有实现 Mac 那套废纸篓备份和自动回退。后台进程 60 秒内不退出时更新不会继续，也不会强杀任务。

## 真实环境检查步骤

1. 负责人把代码放到探针分支或手动触发 Windows probe，打开 Real NSIS online update 作业；应完成两次构建且上传 update-windows 附件。
2. 看 result.json：passed 应为 true，检查项包含坏签名、坏包、半截下载、发布页兜底、自动打开新版、自带平台版本和无下载残留。
3. 看 ready.png、新版截图与两份 requests.log；旧版应为 0.0.81，新版为 0.0.82，安装路径始终相同。
4. 在 Windows 隔离外测试账户手动启动 win-unpacked，打开设置→通用→更新；应提示正常安装目录/手动安装，不给在线更新按钮。
5. 在普通用户下把测试安装目录设为不可写再启动，设置→更新应提示手动安装，不能弹提权或启动安装程序。
6. 用测试包走检查→下载→重启，在任务管理器核对只直接启动 NSIS 安装程序；新安装器/卸载器不得启动 PowerShell 或 cmd。
7. 浅色、深色、窄窗口分别打开更新弹窗，检查文字、进度和按钮不遮挡；Windows 就绪文案应提醒先等活结束。
8. 有后台任务时点重启，确认任务不被结束；60 秒仍占用时安装停止，原目录保持旧版。结束任务后重新打开旧版再更新应成功。
9. 负责人在隔离外跑 npm run test:e2e 和正式发版演练，确认三个安装包与两份清单齐全；先验收再发版。
