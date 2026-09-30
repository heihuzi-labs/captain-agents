import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeSplit, describeTiming } from '../src/core/duration.ts';

const job = (extra: object) => ({ started: '2026-09-30T00:00:00.000Z', ended: '2026-09-30T00:20:00.000Z', seconds: 1200, ...extra });

test('每一步的时间：想和写 = 扣掉休眠的总用时 − 跑命令；没有记录给 null', () => {
  assert.equal(timeSplit(job({})), null);
  assert.deepEqual(timeSplit(job({ timing: { steps: 45, toolSeconds: 50 } })), { steps: 45, toolSeconds: 50, thinkSeconds: 1150 });
  const slept = job({ timing: { steps: 3, toolSeconds: 60 }, sleeps: [{ from: '2026-09-30T00:05:00.000Z', to: '2026-09-30T00:15:00.000Z' }] });
  assert.deepEqual(timeSplit(slept), { steps: 3, toolSeconds: 60, thinkSeconds: 540 });
  assert.equal(timeSplit(job({ timing: { steps: 1, toolSeconds: 5000 } }))!.toolSeconds, 1200, '跑命令不超过总用时');
  const live = { started: '2026-09-30T00:00:00.000Z', timing: { steps: 2, toolSeconds: 30 } };
  assert.deepEqual(timeSplit(live, Date.parse('2026-09-30T00:02:00.000Z')), { steps: 2, toolSeconds: 30, thinkSeconds: 90 });
});

test('每一步的时间：一句人话', () => {
  assert.equal(describeTiming(null), null);
  assert.equal(describeTiming({ steps: 45, toolSeconds: 50, thinkSeconds: 1150 }), '大部分时间在想，跑命令不到 1 分钟，共 45 步');
  assert.equal(describeTiming({ steps: 9, toolSeconds: 600, thinkSeconds: 120 }), '大部分时间在跑命令（约 10 分钟），想和写约 2 分钟，共 9 步');
  assert.equal(describeTiming({ steps: 20, toolSeconds: 300, thinkSeconds: 400 }), '想和写约 7 分钟，跑命令约 5 分钟，共 20 步');
  assert.equal(describeTiming({ steps: 1, toolSeconds: 0, thinkSeconds: 3900 }), '大部分时间在想，跑命令不到 1 分钟，共 1 步');
  assert.equal(describeTiming({ steps: 1, toolSeconds: 7200, thinkSeconds: 0 }), '大部分时间在跑命令（约 2 小时），想和写不到 1 分钟，共 1 步');
});
