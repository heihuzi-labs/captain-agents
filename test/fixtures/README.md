测试样本和替身，全部离线，不启动真实选手，不联网，不监听端口。

- `streams/`：三家“边做边输出”的原始 JSONL（`codex-json.jsonl`、`grok-streaming.jsonl`、`cursor-stream.jsonl`），用于解析动作、报告和用量（`test/activity.test.ts`），也是 `worker.ts` 的 `stream` 模式的回放来源。
- `worker.ts`：离线选手替身。`stream` 模式按原行分段输出（省略 thought、thinking、available_commands），用任务目录中的 `continue-1`、`continue-2` 文件控制继续；Codex 的报告仍模拟独立的 `final.md`。
- `fs-child.ts`：进程中断和锁测试用的子进程。
- `node-test-summary.txt`：`node --test` 的汇总输出样本，用于验收结果的数字解析（`test/verify.test.ts`）。
- `quota/`：额度、模型清单的样本和查询替身，说明见 `quota/README.md`。
