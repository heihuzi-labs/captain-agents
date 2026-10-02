---
name: xagents
description: 用派活工作台（xagents）把目标清楚的实现、修复、审查初筛或代码调研派给本机 Codex、Grok、Cursor 命令行（以及借 Codex 跑的 DeepSeek）去做，负责人只管拆活、审查、验收和记录决定。派活、查进度、查额度、隔离自检、验收、打分、采用或放弃时用。
---

## 什么时候用

- 有目标清楚的实现、修复、审查初筛、代码调研，可以交给本机的 Codex、Grok 命令行、Cursor 命令行、借 Codex 跑的 DeepSeek 去做，自己只管拆活、审查、验收。
- 要查派活工作台里的进度、额度、各家档案，或处理主人在派活工作台应用里的留言和拍板。

## 第一步：先运行 `xagents guide`，读完再动手

`xagents guide` 打印指挥手册全文，末尾附这台机器现在的情况：主人允许的选手和强度、各家额度、各家档案、手头的活和待办。怎么派、怎么审、怎么打分、出了故障怎么办，全在手册里，这里不重复。

## 常用命令一览

完整的命令和参数以 `xagents --help` 为准。

- 了解情况：`xagents guide`、`status`、`inbox`、`workers`、`quota`、`profiles`、`stats`
- 派活：`xagents project add`（登记项目）、`run`
- 盯进度：`xagents wait`、`status`、`stop`、`collect`
- 验收和记录：`xagents verify`、`real`、`adopt`、`drop`、`rate`、`clean`
- 主人的留言和拍板：`xagents inbox`、`reply`、`handled`
- 隔离和模型：`xagents selfcheck`、`models`
