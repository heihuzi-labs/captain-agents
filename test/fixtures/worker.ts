import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
const codex = args.includes('exec');
const grok = args.includes('grok');
const final = codex ? value('-o') : undefined;
const dir = codex ? dirname(final!) : dirname(value('--settings'));
const prompt = codex ? readFileSync(0, 'utf8') : grok ? readFileSync(value('--prompt-file'), 'utf8') : args.at(-1)!;
const mode = process.env.XA_TEST_MODE || 'ok';
writeFileSync(join(dir, 'observed.json'), JSON.stringify({ args, prompt, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GROK_'))), cwd: process.cwd() }));
if (mode === 'hang' || mode === 'ignore-term') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'grandchild.pid'), String(child.pid));
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'stream') {
  const sample = codex ? 'codex-json.jsonl' : grok ? 'grok-streaming.jsonl' : 'cursor-stream.jsonl';
  const raw = readFileSync(join(import.meta.dirname, 'streams', sample), 'utf8');
  const lines = raw.trim().split('\n').filter(line => !['thought', 'thinking', 'available_commands'].includes(JSON.parse(line).type));
  const action = (line: string) => {
    const r = JSON.parse(line);
    return codex ? r.type === 'item.started' : r.type === 'tool_call' && (grok || r.subtype === 'started');
  };
  const starts = lines.flatMap((line, i) => action(line) ? [i] : []);
  const waitGate = async (stage: number) => {
    while (!existsSync(join(dir, `continue-${stage}`))) await sleep(25);
  };
  const emit = async (rows: string[]) => {
    for (const line of rows) { process.stdout.write(line + '\n'); await sleep(5); }
  };
  writeFileSync(join(process.cwd(), 'base.txt'), '改过的起点\n');
  await emit(lines.slice(0, starts[1]));
  await waitGate(1);
  writeFileSync(join(process.cwd(), 'new file.txt'), '新增内容\n');
  await emit(lines.slice(starts[1], starts[2]));
  await waitGate(2);
  await emit(lines.slice(starts[2]));
  if (codex) writeFileSync(final!, '## 结论\n流式样本完成。\n');
} else {
  if (mode === 'change') {
    writeFileSync(join(process.cwd(), 'base.txt'), '改过的起点\n');
    writeFileSync(join(process.cwd(), 'new file.txt'), '新增内容\n');
  }
  const report = mode === 'real' ? '## 结论\n测试替身完成。\n## 真实环境检查步骤\n- 打开页面，看到任务列表\n* 切换深色，文字清楚\n1. 点击详情，显示说明\n## 其他\n- 不应收取\n' : mode === 'empty' ? '' : '## 结论\n测试替身完成。\n<script>throw new Error("不能执行")</script>\n';
  if (mode === 'malformed') process.stdout.write('{bad');
  else if (codex) {
    writeFileSync(final!, report);
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 12 } }));
  } else {
    if (grok) {
      console.log(JSON.stringify({ type: 'text', data: report }));
      console.log(JSON.stringify({ type: 'end', usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 12 } }));
    } else console.log(JSON.stringify({ type: 'result', result: report, usage: { inputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 12 } }));
  }
  if (mode === 'fail') { console.error('模拟选手失败'); process.exitCode = 7; }
}
