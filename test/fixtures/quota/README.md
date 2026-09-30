样本说明：
- 脱敏输出（保留原输出结构，账号套餐、账期、用量等均为虚构值；已去掉路径、自定义技能名等个人信息）：`cursor-real.txt`（/usage 界面，含终端控制字符）、`grok-real.jsonl`（`_x.ai/billing` 回复及前后的通知）、`codex-models-real.json`（`codex debug models`，只留了必要字段）、`grok-models-real.txt`、`cursor-models-real.txt`。
- 匿名合成样本：`cursor.txt`、`grok.json`、`grok-under-one.json`、`codex.jsonl`、`codex-models.json`、`grok-models.txt`、`cursor-models.txt`，字段按真实输出的结构手写，用来覆盖真实输出里没出现的情形（如用量不到 1%、按量付费有金额）。
- `query.ts` 是命令行的离线查询替身；`tty.ts` 是伪终端桥的测试替身。
