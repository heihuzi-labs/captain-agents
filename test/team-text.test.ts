import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamReason, TeamState } from '../src/core/team.ts';
import { reasonText, stateText } from '../src/core/team-text.ts';

// 文案以 src/core/team-text.ts 的实测为准。不认识的值保持现在的落点，不改实现。

const reasonCopy: Record<TeamReason, string> = {
  passed: '审查说通过了',
  disagree: '轮数用完，还有必须改的没谈拢',
  unclear: '审查报告里找不到结论',
  brake: '到了刹车线',
  blocked: '叫醒前被拦下',
  failed: '有一轮没做完',
  lost: '推进小队的后台不在了',
};

const stateCopy: Record<TeamState, string> = {
  running: '在进行',
  lead: '等负责人',
  ended: '已收场',
};

test('reasonText：七种原因各自的文字，函数输出彼此不同', () => {
  const reasons = Object.keys(reasonCopy) as TeamReason[];
  for (const reason of reasons) assert.equal(reasonText(reason), reasonCopy[reason], reason);
  assert.equal(new Set(reasons.map(reasonText)).size, 7);
});

test('stateText：三种状态各自的文字，函数输出彼此不同', () => {
  const states = Object.keys(stateCopy) as TeamState[];
  for (const state of states) assert.equal(stateText(state), stateCopy[state], state);
  assert.equal(new Set(states.map(stateText)).size, 3);
});

test('reasonText：不认识的值写“原因不明”，不写出 undefined', () => {
  // 登记文件不校验 reason，字符串、null、undefined、数字、对象都可能出现。
  for (const reason of ['', 'pass', 'PASSED', 'lost ', null, undefined, 0, {}]) {
    assert.equal(reasonText(reason as TeamReason), '原因不明');
  }
});

test('stateText：不认识的状态写“状态不明”，和真正的 ended 分开', () => {
  for (const state of ['', 'done', 'running ', 'stopped', null, undefined, 0, {}]) {
    assert.notEqual(stateText(state as TeamState), stateText('ended'));
    assert.equal(stateText(state as TeamState), '状态不明');
  }
});
