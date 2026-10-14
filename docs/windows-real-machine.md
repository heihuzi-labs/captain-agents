# 在真的 Windows 电脑上验收

给在主人的 Windows 电脑上开的负责人会话用。流水线的 Windows 机器上能测的都测过了（[探针报告](research/windows-codex-sandbox-2026-10-12.md)），这里做的是流水线做不了的：真的登录、真的弹管理员确认框、真的让模型干一件活、有真密钥文件的家目录、真的窗口。设计见 [design-windows.md](design-windows.md)。

规矩：

- 每一步把命令的原样输出记下来。没跑的写“没跑”，不许写“应该可以”。
- 出了和预期不一样的结果，先记下来、停在那一步，不要为了往下走去放宽隔离或改判定。
- 要主人本人做的只有三件：装 Codex 并登录、在管理员确认框上点“是”、看一眼窗口截图。别的都自己做。
- 不在这台电脑上跑 `npm test`（测试会起很多进程，这台电脑上有主人真的东西）。测试在流水线上跑。

## 0. 准备

需要：Windows 10 或 11、Git for Windows、Node 24、pnpm。

```powershell
git --version; node --version; pnpm --version
```

取代码（公开仓库的探针分支；验收过后会合进主线）：

```powershell
git clone -b probe/windows https://github.com/heihuzi-labs/captain-agents.git
cd captain-agents
pnpm install --frozen-lockfile
```

下面的 `xagents` 都是 `node src/cli/cli.ts` 的简写；装了桌面应用和命令行之后可以直接敲 `xagents`。

## 1. Codex

主人做：按 Codex 官方的办法装命令行（官方安装脚本会装到 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`），运行一次 `codex` 完成登录。

```powershell
& "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe" --version
& "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe" login status
```

记下版本号。探针是对着 0.162.1 做的；版本不同也照跑，结果里写明版本。

## 2. 装隔离、自检

```powershell
node src/cli/cli.ts selfcheck        # 预期：没过，“还没装好 Windows 上的隔离…”
node src/cli/cli.ts windows-setup    # 系统弹管理员确认框，主人点“是”。预期：四行“好了”
node src/cli/cli.ts selfcheck        # 预期：自检通过
```

要记的：

- 确认框弹了几次（预期一次）；主人如果用的是普通账户、要输管理员密码，也记下来，并看装完后自检过不过。
- 自检没过时，原样记下是哪几项。流水线的机器是空的，这台电脑上有真的 `.ssh`、`.npmrc`、PowerShell 配置和历史、凭据库条目，所以“读密钥”这一类在这里才是真的测到了。
- 自检前后家目录里有没有多出东西：

```powershell
$before = Get-ChildItem -Force $env:USERPROFILE | Select-Object -ExpandProperty Name
node src/cli/cli.ts selfcheck
Get-ChildItem -Force $env:USERPROFILE | Where-Object { $before -notcontains $_.Name }   # 预期：什么都不列出
```

- 这台电脑上如果开着代理软件，记下它监听的本机端口；自检里“本机监听端口”那一项要是“连接被拒”。
- 重启电脑以后再跑一次 `selfcheck`：平台加的那几条规则是按“重启后还在”装的，流水线上验不了，这里要验。

## 3. 派一件小活

建一个只有一个文件的小仓库当项目（不要拿主人真的项目来试）：

```powershell
mkdir $HOME\xa-try; cd $HOME\xa-try; git init -b main
"hello" | Set-Content note.txt; git add .; git commit -m init
cd <代码目录>
node src/cli/cli.ts project add try $HOME\xa-try --label 试一试 --verify "git status --short"
node src/cli/cli.ts project check try
```

题目文件 `try.md` 写一句：“在 note.txt 末尾加一行‘第二行’，别的都不动。报告里写你实际跑了哪些命令。”

```powershell
node src/cli/cli.ts run try.md --project try --summary "往文件里加一行" --title "加一行" --who codex:medium
node src/cli/cli.ts wait <任务号>
node src/cli/cli.ts status <任务号>
```

要看的：

1. 活做完了，报告在，副本里 `note.txt` 多了一行。
2. 选手在隔离里：任务目录的 `run.log` 里它跑的命令能写副本；让它顺手试一下也行，但自检已经覆盖，不强求。
3. 副本外没被动过：`git -C $HOME\xa-try status --short` 是空的；家目录里没有多出东西（办法同第 2 步）。
4. 没有残留进程：活结束后，任务管理器里没有这件活留下的 `codex.exe`、`node.exe`、`powershell.exe`。
5. `node src/cli/cli.ts verify <任务号>` 通过。
6. 再派一件让它卡住的活（题目写“运行 `ping -t 127.0.0.1`，不要停”），跑起来以后 `node src/cli/cli.ts stop <任务号>`：十秒内记成“被停止”，任务管理器里它起的进程都没了。
7. 关着联网总开关时，题目里让它 `curl https://example.com`：要失败。
8. 最后 `node src/cli/cli.ts clean <任务号>`，副本和分支删掉了。

DeepSeek（主人愿意的话）：`node src/cli/cli.ts login deepseek`，再用 `--who deepseek-flash:high` 派同样的小活。

## 4. 桌面应用

安装程序从探针分支最近一次“Build desktop”流水线的附件里取（`captain-agents_<版本>_windows-x64.exe`），或在本机 `npm run pack -- win-x64`。安装包没有代码签名，Windows 会提醒“未知发布者”，这是已知的。

安装向导可选“只给我装 / 给所有人装”和安装位置（给所有人装需要管理员确认）。分别检查默认位置和另一个英文目录，安装后的程序文件应叫 `captain-agents.exe`，开始菜单和窗口显示名仍是“派活工作台”。

装过命令行以后，退出应用，再改位置重装并打开新位置的应用：不必点“替换”，设置里的命令行应显示已安装，新开命令提示符、PowerShell、Git 终端运行 `xagents workers` 都应成功。若曾手动改过启动脚本，启动应用应保留原文件，仍需手动确认替换。带中文的安装目录另测代码页兼容性，英文程序名不保证解决目录里的中文。

装好打开，逐项看并截图（浅色、深色、窗口拉窄各一张，外加一个弹窗）：

- 顶栏：左边没有空出一大块；右上角三个窗口按钮在顶栏里，颜色跟着深浅走，不压住设置按钮和额度圆环；拖顶栏空白处能移动窗口。
- 快捷键：Ctrl+1 到 Ctrl+4 切页，Ctrl+R 刷新，Ctrl+, 开设置；悬停提示写的是 Ctrl。
- 托盘：右下角有蓝色的三列图标；有活在跑时悬停提示写“在跑 N 件”；左键打开窗口，右键出菜单。
- 设置 → 通用：“更新”一组写的是 Windows 版暂时不带在线更新，没有点了没反应的按钮；“命令行”一组点“安装”，然后**新开**一个 PowerShell 和一个 Git 的终端，各敲 `xagents workers`，都能出结果。
- 看板上能看到第 3 步派的活；隔离自检的小圆点是绿的。
- 关窗口后应用还在托盘里；从托盘“退出”后进程没了。

## 5. 收尾

- 不再用的话：`xagents windows-setup --remove` 撤掉平台加的规则；Codex 自己的隔离用它自己的卸载办法。
- 把上面每一步的输出、截图、和预期不一样的地方交回给主会话。预期不一样的每一条都要有结论：是哪里的毛病、改了什么、重跑的结果。
