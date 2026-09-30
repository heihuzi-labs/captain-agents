import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StreamParser } from '../src/core/activity.ts';
import type { Who } from '../src/core/job.ts';
import { root } from './helpers.ts';

const at = (seconds: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + seconds * 1000).toISOString();
const line = (row: unknown) => JSON.stringify(row) + '\n';
const fixtures: { who: Who; file: string; steps: number; seconds: number }[] = [
  { who: 'codex', file: 'codex-json', steps: 49, seconds: 122 },
  { who: 'grok', file: 'grok-streaming', steps: 3, seconds: 16 },
  { who: 'cursor-opus', file: 'cursor-stream', steps: 4, seconds: 8 },
  { who: 'cursor-grok', file: 'cursor-stream', steps: 4, seconds: 8 },
];
for (const { who, file, steps, seconds } of fixtures) {
  const rows = async () => (await readFile(join(root, `test/fixtures/streams/${file}.jsonl`), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  test(`${who} 完整真实素材逐行按 2 秒采样：步数和并集时长`, async () => {
    const source = await rows(), p = new StreamParser(who);
    source.forEach((r, i) => p.feed(line(r), at(i * 2)));
    p.finish(at(source.length * 2));
    assert.deepEqual(p.timing(undefined, at(1000)), { steps, toolSeconds: seconds });
    // 活动只留最后 50 条，计时仍覆盖完整日志。
    assert.ok(p.activity.length <= 50);
  });
  test(`${who} 真实工具记号交错到达：编号配对、同时开始、休眠并集、EOF 收尾`, async () => {
    const source = await rows();
    const starts = source.filter(r => who === 'codex' ? r.type === 'item.started' && ['command_execution', 'file_change'].includes(r.item?.type)
      : who === 'grok' ? r.type === 'tool_call' : r.type === 'tool_call' && r.subtype === 'started');
    const id = (r: any) => who === 'codex' ? r.item.id : who === 'grok' ? r.toolCallId : r.call_id;
    const ends = starts.map(s => source.find(r => (who === 'codex' ? r.type === 'item.completed'
      : who === 'grok' ? r.type === 'tool_call_update' && r.status === 'completed' : r.type === 'tool_call' && r.subtype === 'completed') && id(r) === id(s)));
    const p = new StreamParser(who);
    p.feed(line(starts[0]) + line(starts[1]), at(0));
    p.feed(line(starts[0]), at(1)); // 重复开始不增加步数，也不重置开始时间。
    p.feed(line(ends[1]), at(4)); // 后开始的先结束，不能按队列配对。
    assert.deepEqual(p.timing(undefined, at(6)), { steps: 2, toolSeconds: 6 });
    p.feed(line(ends[0]) + line(ends[1]), at(8));
    const sleeps = [{ from: at(-2), to: at(1) }, { from: at(2), to: at(5) },
      { from: at(3), to: at(6) }, { from: at(9), to: at(11) }, { from: at(100), to: at(200) }];
    assert.deepEqual(p.timing(sleeps, at(10)), { steps: 2, toolSeconds: 3 });
    p.feed(line(starts[2]), at(12));
    assert.deepEqual(p.timing(sleeps, at(16)), { steps: 3, toolSeconds: 7 });
    p.finish(at(18));
    assert.deepEqual(p.timing(sleeps, at(100)), { steps: 3, toolSeconds: 9 });
    p.finish(at(200));
    assert.deepEqual(p.timing(sleeps, at(300)), { steps: 3, toolSeconds: 9 });
  });
}

test('Grok 非终态更新继续计时，failed 结束；未知编号更新不计步', () => {
  const p = new StreamParser('grok');
  p.feed(line({ type: 'tool_call_update', toolCallId: 'unknown', status: 'completed' }), at(0));
  p.feed(line({ type: 'tool_call', toolCallId: 'one' }), at(0));
  for (const status of [null, 'pending', 'in_progress']) p.feed(line({ type: 'tool_call_update', toolCallId: 'one', status }), at(2));
  assert.deepEqual(p.timing(undefined, at(4)), { steps: 1, toolSeconds: 4 });
  p.feed(line({ type: 'tool_call_update', toolCallId: 'one', status: 'failed' }), at(6));
  assert.deepEqual(p.timing(undefined, at(20)), { steps: 1, toolSeconds: 6 });
});

test('Codex 只有 completed 也算一步，非工具和坏编号不算；EOF 末行按收尾时间解析', () => {
  const p = new StreamParser('codex');
  for (const type of ['command_execution', 'file_change', 'agent_message', 'reasoning']) {
    p.feed(line({ type: 'item.completed', item: { id: type, type } }), at(0));
  }
  p.feed(line({ type: 'item.started', item: { type: 'command_execution' } }), at(2));
  assert.deepEqual(p.timing(undefined, at(4)), { steps: 2, toolSeconds: 0 });
  p.feed(line({ type: 'item.started', item: { type: 'file_change', id: 'pending' } }), at(4));
  p.feed(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', id: 'pending' } }), at(6));
  p.finish(at(8));
  assert.deepEqual(p.timing(undefined, at(20)), { steps: 3, toolSeconds: 4 });
});

test('多个不足一秒的时段合计、扣休眠之后再取整', () => {
  const p = new StreamParser('grok');
  for (const [id, start] of [['a', 0], ['b', 2]] as const) {
    p.feed(line({ type: 'tool_call', toolCallId: id }), at(start));
    p.feed(line({ type: 'tool_call_update', toolCallId: id, status: 'completed' }), at(start + 0.8));
  }
  assert.deepEqual(p.timing([{ from: at(0), to: at(0.4) }], at(4)), { steps: 2, toolSeconds: 1 });
});
