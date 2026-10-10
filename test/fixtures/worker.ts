import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
const codex = args.includes('exec');
const grok = args.includes('grok');
const final = codex ? value('-o') : undefined;
const dir = codex ? dirname(final!) : dirname(process.env.CLAUDE_CODE_TMPDIR!);
const prompt = codex ? readFileSync(0, 'utf8') : grok ? readFileSync(value('--prompt-file'), 'utf8') : args.at(-1)!;
// 群聊测试按成员、轮次指定汇报和行为；只读替身默认不写工作副本。
const chatJob = process.env.XA_TEST_CHAT_REPORTS || process.env.XA_TEST_CHAT_MODES
  ? JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { who: string; resume?: { round: number } } : undefined;
const chatRound = chatJob?.resume?.round ?? 1;
const chatModes = JSON.parse(process.env.XA_TEST_CHAT_MODES || '{}') as Record<string, string>;
const chatReports = JSON.parse(process.env.XA_TEST_CHAT_REPORTS || '{}') as Record<string, string | string[]>;
const chatReport = chatJob ? chatReports[chatJob.who] : undefined;
const mode = (chatJob && chatModes[chatJob.who]) || process.env.XA_TEST_MODE || 'ok';
writeFileSync(join(dir, 'observed.json'), JSON.stringify({ args, prompt, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GROK_'))), keys: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'DEEPSEEK_API_KEY'].filter(k => k in process.env), secrets: Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE/i.test(k)), plain: process.env.XA_TEST_PLAIN ?? null, codexHome: process.env.CODEX_HOME ?? null, cursorAuth: process.env.CURSOR_AUTH_TOKEN ?? null, credentialStore: process.env.AGENT_CLI_CREDENTIAL_STORE ?? null, cwd: process.cwd() }));
// 续接时把原会话号再打出来，方便平台从本轮日志里对上号。Codex 在 exec resume 的倒数第二个参数，Grok 在 --resume 后面。
const resumedSession = () => {
  const flag = args.lastIndexOf('--resume');
  if (flag >= 0 && args[flag + 1]) return args[flag + 1];
  const exec = args.indexOf('exec');
  if (exec >= 0 && args[exec + 1] === 'resume' && args.at(-1) === '-') return args.at(-2);
  return undefined;
};
// 先认审查：审查提示词会引用写手报告，写手报告里不再出现“你是审查”。
const role = prompt.includes('你是审查') ? 'reviewer' : prompt.includes('你是搭档审改里的写手') || prompt.includes('请逐条处理上面的审查意见') ? 'writer' : 'plain';
const reviewKind = () => {
  const raw = process.env.XA_TEST_REVIEW;
  if (!raw) return 'pass';
  const allowed = ['pass', 'changes', 'unclear'];
  const list = raw.split(/[,|]/).map(part => part.trim()).filter(part => allowed.includes(part));
  if (!list.length) return 'unclear';
  if (list.length === 1) return list[0];
  const file = join(dir, 'xa-review-seq');
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) || 0 : 0;
  writeFileSync(file, String(n + 1));
  return list[Math.min(n, list.length - 1)];
};
const reviewReport = () => {
  const kind = reviewKind();
  if (kind === 'unclear') return '## 结论\n还没看明白\n\n## 意见\n需要负责人看。\n';
  if (kind === 'changes') return '## 结论\n要改\n\n## 意见\n1. [必须改] writer-round.txt:1 —— 这里要改\n2. [疑问] writer-round.txt:1 —— 为什么这样\n';
  return '## 结论\n通过\n\n## 意见\n1. [建议] writer-round.txt:1 —— 可以再写清楚\n';
};
const writerReport = (text: string) => {
  const items = text.split('\n').map(line => line.trim()).filter(line => /^\d+\s*[.、，,．。]\s*[\[［【](必须改|建议|疑问)[\]］】]/.test(line.replace(/\u3000/g, ' ')));
  const replies = items.length ? items.map((line, index) => {
    const n = /^(\d+)/.exec(line)?.[1] ?? String(index + 1);
    return index % 2 === 0 ? `${n}. 已改：按意见改了。` : `${n}. 不改：这一条先保持原样。`;
  }).join('\n') : '1. 已改：这一轮没有点名的意见。';
  return `## 结论\n测试替身完成。\n<script>throw new Error("不能执行")</script>\n\n## 逐条回复\n${replies}\n`;
};
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
  if (mode === 'hold') while (!existsSync(join(dir, 'release'))) await sleep(25);
  if (mode === 'change') {
    writeFileSync(join(process.cwd(), 'base.txt'), '改过的起点\n');
    writeFileSync(join(process.cwd(), 'new file.txt'), '新增内容\n');
  }
  // 计数放在任务目录，不进副本，避免每一轮的补丁被计数文件干扰。XA_TEST_FREEZE 时不改副本。
  if (role === 'writer' && mode !== 'empty' && mode !== 'fail' && mode !== 'malformed' && !process.env.XA_TEST_FREEZE) {
    const ticks = join(dir, 'writer-ticks');
    const n = (existsSync(ticks) ? Number(readFileSync(ticks, 'utf8')) || 0 : 0) + 1;
    writeFileSync(ticks, String(n));
    writeFileSync(join(process.cwd(), 'writer-round.txt'), `第${n}轮\n`);
  }
  const report = chatReport !== undefined ? (Array.isArray(chatReport) ? chatReport[Math.min(chatRound - 1, chatReport.length - 1)] : chatReport) : mode === 'real' ? '## 结论\n测试替身完成。\n## 真实环境检查步骤\n- 打开页面，看到任务列表\n* 切换深色，文字清楚\n1. 点击详情，显示说明\n## 其他\n- 不应收取\n' : mode === 'empty' ? '' : role === 'reviewer' ? reviewReport() : role === 'writer' ? writerReport(prompt) : '## 结论\n测试替身完成。\n<script>throw new Error("不能执行")</script>\n';
  const session = resumedSession() || randomUUID();
  if (mode === 'malformed') process.stdout.write('{bad');
  else if (codex) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
    writeFileSync(final!, report);
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 12 } }));
  } else if (grok) {
    console.log(JSON.stringify({ sessionId: session }));
    console.log(JSON.stringify({ type: 'text', data: report }));
    console.log(JSON.stringify({ type: 'end', usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 12 } }));
  } else console.log(JSON.stringify({ type: 'result', result: report, usage: { inputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 12 } }));
  if (mode === 'fail') { console.error('模拟选手失败'); process.exitCode = 7; }
}
