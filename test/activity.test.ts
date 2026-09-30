import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StreamParser, LogTail, unwrapCommand } from '../src/core/activity.ts';
import { parseResult } from '../src/core/workers.ts';
import { LiveProgress } from '../src/core/live.ts';
import { changedFiles } from '../src/core/worktree.ts';
import { createJob, readJob, updateJob } from '../src/core/job.ts';
import type { Job, Who } from '../src/core/job.ts';
import { context, root } from './helpers.ts';

const at = '2026-09-29T04:00:00.000Z';
const line = (row: unknown) => JSON.stringify(row) + '\n';
const sample = (name: string) => readFile(join(root, 'test/fixtures/streams', name), 'utf8');

test('三份真实流式样本的动作、报告与用量', async () => {
  const codex = new StreamParser('codex', '/Users/owner/workspace/xagents/.worktrees/xa-core');
  codex.feed(await sample('codex-json.jsonl'), at); codex.finish(at);
  const c = codex.result('独立 final.md 报告');
  assert.equal(c.report, '独立 final.md 报告');
  assert.deepEqual(c.usage, { read: 2282885, cached: 2169088, out: 45095 });
  assert.equal(c.activity.length, 50);
  assert.ok(c.activity.some(a => a.kind === 'cmd'));
  assert.ok(c.activity.some(a => a.kind === 'edit' && a.text.includes('src/')));
  assert.ok(c.activity.some(a => a.kind === 'say'));
  assert.ok(c.activity.every(a => a.at === at && Array.from(a.text).length <= 200 && !a.text.includes('\n') && !a.text.startsWith('/bin/bash -lc')));
  assert.ok(!JSON.stringify(c.activity).includes('/Users/owner/workspace/xagents/.worktrees/xa-core'));
  const grok = new StreamParser('grok', '/tmp/sample-repo');
  grok.feed(await sample('grok-streaming.jsonl'), at); grok.finish(at);
  const g = grok.result();
  assert.deepEqual(g.usage, { read: 87128, cached: 77056, out: 398 });
  assert.deepEqual(g.activity.map(a => a.kind), ['say', 'read', 'edit', 'cmd', 'say']);
  assert.equal(g.activity[1].text, 'm.py'); assert.equal(g.activity[2].text, 'm.py');
  assert.equal(g.activity[3].text, "python3 -c 'import m; print(m.add(2,3))'");
  assert.equal(g.report, "`add` 原先返回 `a - b`，已改为 `a + b`。`python3 -c 'import m; print(m.add(2,3))'` 输出 `5`。");
  for (const who of ['cursor-opus', 'cursor-grok'] as Who[]) {
    const cursor = new StreamParser(who, '/tmp/sample-repo');
    cursor.feed(await sample('cursor-stream.jsonl'), at); cursor.finish(at);
    const r = cursor.result();
    assert.deepEqual(r.usage, { read: 77596, cached: 57984, cacheWrite: 0, out: 366 });
    assert.deepEqual(r.activity.map(a => a.kind), ['say', 'read', 'read', 'edit', 'cmd', 'say']);
    assert.equal(r.activity[2].text, 'm.py'); assert.equal(r.activity[3].text, 'm.py');
    assert.equal(r.report, "`add` 原先用减法，已改成 `return a+b`；`python3 -c 'import m; print(m.add(2,3))'` 输出 `5`。");
    assert.equal(r.lastActivityAt, at);
  }
});

test('坏行与结构异常跳过；半行等待后续；动作只保留末尾 50 条和 200 字', () => {
  for (const who of ['codex', 'grok', 'cursor-opus'] as Who[]) {
    const p = new StreamParser(who);
    p.feed('坏行\nnull\n[]\n42\n{"type":"assistant","message":{"content":42}}\n{"type":"item.completed","item":{"type":"file_change","changes":[null]}}\n');
    assert.equal(p.activity.length, 0);
  }
  const p = new StreamParser('codex', '/repo');
  p.feed('{"type":"item.started","item":{"type":"command_execution","command":');
  assert.equal(p.activity.length, 0);
  p.feed(JSON.stringify("/bin/bash -lc 'cat /repo/文件.txt'") + '}}\n', at);
  assert.deepEqual(p.activity, [{ at, kind: 'cmd', text: 'cat 文件.txt' }]);
  for (let i = 0; i < 60; i++) p.feed(line({ type: 'item.completed', item: { type: 'agent_message', text: `${i} \n ${'文😀'.repeat(150)}` } }), at);
  assert.equal(p.activity.length, 50); assert.ok(p.activity[0].text.startsWith('10 '));
  assert.equal(Array.from(p.activity.at(-1)!.text).length, 200);
  assert.equal(p.activity.at(-1)!.text.includes('\n'), false);
  assert.equal(p.activity.at(-1)!.text.includes('\uFFFD'), false);
  assert.equal(unwrapCommand('/bin/bash -lc "echo \\"好\\""'), 'echo "好"');
  p.feed(line({ type: 'item.started', item: { type: 'command_execution', command: 'pwd /repo-other /repo /repo/file' } }), at);
  assert.equal(p.activity.at(-1)!.text, 'pwd /repo-other . file');
});

test('文件计数包括重命名和嵌套未跟踪文件，不改 Git 索引', async t => {
  const c = await context(t);
  await c.git(['mv', 'base.txt', 'renamed.txt']);
  await mkdir(join(c.repo, 'nested'));
  await writeFile(join(c.repo, 'nested/a.txt'), 'a');
  await writeFile(join(c.repo, 'nested/b.txt'), 'b');
  await writeFile(join(c.repo, 'renamed.txt'), '改过的已暂存文件\n');
  const before = await readFile(join(c.repo, '.git/index'));
  assert.equal(await changedFiles({ worktree: c.repo } as Job), 3);
  assert.deepEqual(await readFile(join(c.repo, '.git/index')), before);
});

test('正文边界、后备报告、工具种类和最后一次用量', () => {
  const g = new StreamParser('grok', '/repo');
  g.feed(line({ type: 'text', data: '前半' }) + line({ type: 'text', data: '后半' }));
  assert.equal(g.activity.length, 0);
  g.feed(line({ type: 'tool_call', kind: 'search', rawInput: { path: '/repo/src', query: '目标词' } }), at);
  assert.deepEqual(g.activity.map(a => [a.kind, a.text]), [['say', '前半后半'], ['read', 'src、目标词']]);
  assert.equal(g.result().report, '前半后半');
  g.feed(line({ type: 'text', data: '末尾' }) + line({ type: 'text', data: '报告' }) + line({ type: 'end' }), at);
  assert.equal(g.result().report, '末尾报告'); assert.equal(g.activity.at(-1)!.text, '末尾报告');
  g.feed(line({ type: 'tool_call', title: 'web_search' }) + line({ type: 'tool_call', kind: 'edit', rawInput: { target_file: '/repo/a.ts' } }), at);
  assert.equal(g.activity.at(-2)!.text, 'web_search'); assert.equal(g.activity.at(-1)!.text, 'a.ts');
  assert.equal(g.result().report, '前半后半末尾报告');
  const c = new StreamParser('cursor-grok', '/repo');
  c.feed(line({ type: 'assistant', message: { content: [{ text: '开始' }, { text: '说明' }] } }));
  c.feed(line({ type: 'tool_call', subtype: 'started', tool_call: { grepToolCall: { args: { path: '/repo/src', pattern: 'TODO' } } } }), at);
  c.feed(line({ type: 'result', result: '后备报告', usage: { inputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 12 } }));
  assert.equal(c.result().report, '后备报告'); assert.equal(c.activity.at(-1)!.text, 'src、TODO');
  assert.deepEqual(c.result().usage, { read: 100, cached: 60, cacheWrite: 10, out: 12 });
  c.feed(line({ type: 'assistant', message: { content: [{ text: '最终' }, { text: '报告' }, null] } }));
  assert.equal(c.result().report, '最终报告');
  c.feed(line({ type: 'tool_call', subtype: 'completed' }));
  assert.equal(c.result().report, '后备报告');
  assert.equal(parseResult('codex', line({ type: 'turn.completed', usage: { input_tokens: 10 } }) + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2 } })).usage?.read, 2);
  assert.equal(parseResult('grok', '{坏').report, '');
});

test('日志按字节增量读，中文被截在 UTF-8 字符中间也不丢、不重复', async t => {
  const c = await context(t, false), file = join(c.temp, 'run.log');
  const raw = Buffer.from(line({ type: 'assistant', message: { content: [{ text: '中文动作' }] } }));
  const split = raw.indexOf(Buffer.from('中')) + 1;
  const tail = new LogTail(), parser = new StreamParser('cursor-opus');
  await tail.read(file, parser, at);
  await writeFile(file, raw.subarray(0, split)); await tail.read(file, parser, at);
  assert.equal(parser.activity.length, 0);
  await appendFile(file, raw.subarray(split, raw.length - 1)); await tail.read(file, parser, at);
  assert.equal(parser.activity.length, 0);
  await appendFile(file, '\n坏行\n'); await tail.read(file, parser, at);
  assert.equal(parser.activity[0].text, '中文动作');
  await tail.read(file, parser, at); assert.equal(parser.activity.length, 1);
  assert.equal(tail.offset, (await stat(file)).size);
});

test('进度落盘每 5 秒至多一次，30 秒才数文件，收尾补读并保留并发登记字段', async t => {
  const c = await context(t), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  const job: Job = { id: 'live-test', batch: 'batch', who: 'grok', model: 'grok-4.7', effort: 'high', repo: c.repo, worktree: c.repo, branch: 'main', base: c.base, project: '测试', title: '节流', kind: '实现', mode: 'workspace-write', state: 'running', created: at };
  await createJob(job);
  const log = join(c.home, 'jobs/live-test/run.log'), record = join(c.home, 'jobs/live-test/job.json');
  const live = new LiveProgress(job, 0), original = (await stat(record)).mtimeMs;
  await writeFile(log, line({ type: 'tool_call', kind: 'read', rawInput: { path: join(c.repo, 'base.txt') } }));
  for (const now of [2000, 4000]) { await live.sample(false, now); assert.equal(await live.persist(now), false); }
  assert.equal((await stat(record)).mtimeMs, original);
  await live.sample(false, 6000); assert.equal(await live.persist(6000), true);
  assert.equal((await readJob(job.id)).activity?.length, 1);
  await updateJob(job.id, j => { j.decision = { kind: 'drop', note: '并发字段' }; });
  await appendFile(log, line({ type: 'tool_call', kind: 'edit', rawInput: { path: join(c.repo, 'base.txt') } }));
  await writeFile(join(c.repo, 'base.txt'), '修改\n');
  await writeFile(join(c.repo, '新文件.txt'), '新增\n');
  await live.sample(false, 10000); assert.equal(await live.persist(10000), false);
  await live.sample(false, 12000); assert.equal(await live.persist(12000), true);
  assert.equal((await readJob(job.id)).decision?.note, '并发字段');
  await live.sample(false, 29000); await live.persist(29000);
  assert.equal((await readJob(job.id)).changedFiles, undefined);
  await live.sample(false, 30000); assert.equal(await live.persist(30000), true);
  assert.equal((await readJob(job.id)).changedFiles, 2);
  await writeFile(join(c.repo, '另一文件.txt'), '新增\n');
  await appendFile(log, line({ type: 'text', data: '结束报告' }) + line({ type: 'end', usage: { output_tokens: 12 } }));
  await live.sample(true, 31000);
  await updateJob(job.id, j => live.apply(j));
  const done = await readJob(job.id);
  assert.equal(done.changedFiles, 3); assert.equal(done.activity?.at(-1)?.text, '结束报告');
  assert.equal(done.lastActivityAt, new Date(31000).toISOString());
  assert.equal(done.usage?.out, 12);
});

test('LiveProgress 无新日志也更新工具时长；用最近采样时间和锁内最新休眠记录落盘', async t => {
  const c = await context(t), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  const job: Job = { id: 'live-timing', batch: 'batch', who: 'grok', model: 'test', effort: 'high', repo: c.repo,
    worktree: c.repo, branch: 'main', base: c.base, project: '测试', title: '计时', summary: '测试', kind: '实现', mode: 'workspace-write', state: 'running', created: at };
  await createJob(job);
  const start = (await sample('grok-streaming.jsonl')).split('\n').map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(r => r.type === 'tool_call');
  await writeFile(join(c.home, 'jobs', job.id, 'run.log'), line(start));
  const live = new LiveProgress(job, 0);
  await live.sample(false, 2000);
  await live.sample(false, 6000);
  assert.equal(await live.persist(6000), true);
  assert.deepEqual((await readJob(job.id)).timing, { steps: 1, toolSeconds: 4 });
  await updateJob(job.id, j => { j.sleeps = [{ from: new Date(7000).toISOString(), to: new Date(9000).toISOString() }]; });
  await live.sample(false, 12000);
  assert.equal(await live.persist(15000), true);
  assert.deepEqual((await readJob(job.id)).timing, { steps: 1, toolSeconds: 8 });
  await live.sample(true, 16000);
  await updateJob(job.id, j => live.apply(j));
  assert.deepEqual((await readJob(job.id)).timing, { steps: 1, toolSeconds: 12 });
  await live.sample(false, 20000);
  await updateJob(job.id, j => live.apply(j));
  assert.deepEqual((await readJob(job.id)).timing, { steps: 1, toolSeconds: 12 });
});
