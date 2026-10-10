import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamTasks } from '../src/core/team-tasks.ts';
import type { ChannelMessage, ReviewItem, Team } from '../src/core/team.ts';
import type { TeamTask } from '../src/core/view-types.ts';

type BoardTeam = Pick<Team, 'state' | 'reason' | 'round' | 'phase'> & { title?: string };

function team(extra: Partial<BoardTeam> = {}): BoardTeam {
  return { state: 'running', round: 1, phase: 'write', title: '小队题目', ...extra };
}
function line(id: number, round: number, from: ChannelMessage['from'], kind: ChannelMessage['kind'], text: string, extra: Partial<ChannelMessage> = {}): ChannelMessage {
  return { id, at: '2026-10-10T00:00:00.000Z', round, from, kind, text, ...extra };
}
function item(n: number, level: ReviewItem['level'], text: string): ReviewItem {
  return { n, level, text, reply: null };
}
function review(id: number, round: number, verdict: ChannelMessage['verdict'], items: ReviewItem[], text = '## 结论\n要改\n'): ChannelMessage {
  return line(id, round, 'reviewer', 'review', text, { verdict, items });
}
function report(id: number, round: number, text: string): ChannelMessage {
  return line(id, round, 'writer', 'report', text);
}
function card(tasks: TeamTask[], n: number): TeamTask {
  const found = tasks.find(task => task.n === n);
  assert.ok(found, `缺少编号 ${n}`);
  return found;
}

test('只有交付：还没有审查时只有这一张卡', () => {
  const tasks = teamTasks(team(), [line(1, 1, 'platform', 'event', '开队：Grok 写，DeepSeek 审')]);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], {
    n: 0, kind: 'deliver', text: '小队题目', column: 'doing', holder: 'writer', note: '在写',
    round: 1, updated: 1, history: [],
  });
  const bare = teamTasks({ state: 'running', round: 1, phase: 'write' }, []);
  assert.equal(bare[0]?.text, '');
});

test('交付跟着阶段走：在改、在审；通过之后才算完成', () => {
  const passed = review(2, 1, 'pass', [item(1, 'suggest', '可以更好')], '## 结论\n通过\n');
  const writing = teamTasks(team({ round: 2, phase: 'write' }), [report(1, 1, '## 结论\n写完了\n'), passed]);
  assert.equal(writing[0]?.column, 'doing');
  assert.equal(writing[0]?.holder, 'writer');
  assert.equal(writing[0]?.note, '在改');
  const reviewing = teamTasks(team({ phase: 'review' }), [passed]);
  assert.deepEqual(
    { column: reviewing[0]?.column, holder: reviewing[0]?.holder, note: reviewing[0]?.note },
    { column: 'review', holder: 'reviewer', note: '在审' },
  );
  const done = teamTasks(team({ state: 'lead', reason: 'passed', round: 2, phase: 'review' }), [passed]);
  assert.equal(done[0]?.column, 'done');
  assert.equal(done[0]?.holder, null);
  assert.equal(done[0]?.note, '第 1 轮通过');
});

test('停下等负责人时，交付按原因写那一句', () => {
  const changes = review(1, 2, 'changes', [item(1, 'must', '还要改')]);
  const note = (extra: Partial<BoardTeam>) => teamTasks(team({ state: 'lead', phase: 'review', ...extra }), [changes])[0]?.note;
  assert.equal(note({ reason: 'disagree', round: 3 }), '轮数用完还没谈拢');
  assert.equal(note({ reason: 'unclear', round: 1 }), '审查没写结论');
  for (const reason of ['brake', 'blocked', 'failed', 'lost'] as const) assert.equal(note({ reason, round: 2 }), '停下了');
  assert.equal(teamTasks(team({ state: 'ended', phase: 'write', round: 2 }), [])[0]?.note, '停下了');
  assert.equal(teamTasks(team({ state: 'ended', phase: 'write', round: 2 }), [])[0]?.holder, null);
  assert.equal(teamTasks(team({ state: 'ended', phase: 'write', round: 2 }), [])[0]?.column, 'review');
});

test('第 1 轮审查要改、写手还没开工是待处理；开工后是进行中', () => {
  const asked = review(2, 1, 'changes', [item(1, 'must', '这里要改'), item(2, 'question', '为什么')]);
  const channel = [
    report(1, 1, '## 结论\n第一稿\n'),
    asked,
    line(3, 2, 'lead', 'say', '先看第 1 条'),
    line(4, 2, 'platform', 'event', '叫醒 DeepSeek 复核，第 2 轮'),
  ];
  const waiting = teamTasks(team({ round: 2, phase: 'write' }), channel);
  assert.deepEqual(waiting.map(task => task.n), [0, 1, 2]);
  for (const n of [1, 2]) {
    const task = card(waiting, n);
    assert.equal(task.column, 'todo');
    assert.equal(task.holder, 'writer');
    assert.equal(task.note, '第 1 轮提出');
    assert.equal(task.round, 1);
  }
  const started = teamTasks(team({ round: 2, phase: 'write' }), [
    ...channel,
    line(5, 2, 'platform', 'event', '第 2 轮开始，叫醒 Grok'),
  ]);
  for (const n of [1, 2]) {
    const task = card(started, n);
    assert.equal(task.column, 'doing');
    assert.equal(task.holder, 'writer');
    assert.equal(task.note, '在改');
  }
  const lead = teamTasks(team({ state: 'lead', reason: 'brake', round: 1, phase: 'review' }), [asked]);
  assert.equal(card(lead, 1).column, 'todo');
  assert.equal(card(lead, 1).holder, null);
  assert.equal(card(lead, 1).note, '第 1 轮提出');
});

test('写手回已改、不改后进入待复核，note 写对；后一份报告覆盖前一份', () => {
  const asked = review(1, 1, 'changes', [item(1, 'must', '这里要改'), item(2, 'suggest', '可以更好')]);
  const reason = `因为${'长'.repeat(50)}`;
  const tasks = teamTasks(team({ round: 2, phase: 'write' }), [
    asked,
    report(2, 2, '## 逐条回复\n1. 已改：先说改了\n2. 不改：先不动\n'),
    report(3, 2, `1. 已改：写在节外面\n## 逐条回复\n1. 已改：以后一条为准\n2. 不改：${reason}\n`),
  ]);
  const fixed = card(tasks, 1);
  assert.equal(fixed.column, 'review');
  assert.equal(fixed.holder, 'reviewer');
  assert.equal(fixed.note, '已改，等复核');
  const declined = card(tasks, 2);
  assert.equal(declined.column, 'review');
  assert.equal(declined.holder, 'reviewer');
  assert.equal(declined.note, `不改：${[...reason].slice(0, 40).join('')}`);
  assert.equal([...declined.note.replace('不改：', '')].length, 40);
  assert.deepEqual(fixed.history.map(row => row.text), ['这里要改', '已改：先说改了', '已改：以后一条为准']);
});

test('全角标点的逐条回复也认', () => {
  const tasks = teamTasks(team({ round: 2, phase: 'review' }), [
    review(1, 1, 'changes', [item(1, 'must', '甲'), item(2, 'suggest', '乙')]),
    report(2, 2, '## 逐条回复\n1．已改：改好了\n2、不改：先不动\n'),
  ]);
  assert.equal(card(tasks, 1).note, '已改，等复核');
  assert.equal(card(tasks, 2).note, '不改：先不动');
  assert.deepEqual(card(tasks, 1).history.at(-1), { round: 2, from: 'writer', text: '已改：改好了' });
  assert.deepEqual(card(tasks, 2).history.at(-1), { round: 2, from: 'writer', text: '不改：先不动' });
});

test('第 2 轮不再提的完成，照原编号再提的仍待处理，新意见用更大编号', () => {
  const tasks = teamTasks(team({ round: 3, phase: 'write' }), [
    report(1, 1, '## 结论\n第一轮写完了\n第二行不要\n'),
    review(2, 1, 'changes', [item(2, 'suggest', '先提的建议'), item(1, 'must', '第一次提出')]),
    report(3, 2, '直接是正文\n\n## 逐条回复\n1. 已改：已经改了\n2. 不改：这条后来被拿掉\n'),
    review(4, 2, 'changes', [item(1, 'must', '第二次还在'), item(4, 'question', '新增的大编号')]),
  ]);
  assert.deepEqual(tasks.map(task => task.n), [0, 1, 2, 4]);
  const dropped = card(tasks, 2);
  assert.equal(dropped.column, 'done');
  assert.equal(dropped.holder, null);
  assert.equal(dropped.note, '复核通过');
  assert.equal(dropped.kind, 'suggest');
  assert.equal(dropped.round, 1);
  assert.equal(dropped.updated, 2);
  const again = card(tasks, 1);
  assert.equal(again.column, 'todo');
  assert.equal(again.note, '第 2 轮提出');
  assert.equal(again.kind, 'must');
  assert.equal(again.text, '第二次还在');
  assert.equal(again.round, 1);
  assert.equal(again.updated, 2);
  assert.deepEqual(again.history, [
    { round: 1, from: 'reviewer', text: '第一次提出' },
    { round: 2, from: 'writer', text: '已改：已经改了' },
    { round: 2, from: 'reviewer', text: '第二次还在' },
  ]);
  const added = card(tasks, 4);
  assert.equal(added.column, 'todo');
  assert.equal(added.kind, 'question');
  assert.equal(added.round, 2);
  assert.equal(added.updated, 2);
  assert.deepEqual(added.history, [{ round: 2, from: 'reviewer', text: '新增的大编号' }]);
  assert.equal(tasks[0]?.updated, 2);
  assert.deepEqual(tasks[0]?.history, [
    { round: 1, from: 'writer', text: '第一轮写完了' },
    { round: 2, from: 'writer', text: '直接是正文' },
  ]);
  assert.deepEqual(dropped.history, [
    { round: 1, from: 'reviewer', text: '先提的建议' },
    { round: 2, from: 'writer', text: '不改：这条后来被拿掉' },
  ]);
});

test('最近一份审查通过：意见全部完成，建议和疑问写没要求改', () => {
  const tasks = teamTasks(team({ state: 'lead', reason: 'passed', round: 2, phase: 'review' }), [
    review(1, 1, 'changes', [item(1, 'must', '必须改过'), item(2, 'suggest', '建议留着'), item(5, 'suggest', '早先的建议')]),
    review(2, 2, 'pass', [item(2, 'suggest', '建议留着'), item(3, 'question', '问一句')], '## 结论\n通过\n'),
  ]);
  assert.equal(tasks[0]?.column, 'done');
  assert.equal(tasks[0]?.note, '第 2 轮通过');
  assert.equal(tasks[0]?.holder, null);
  const must = card(tasks, 1);
  assert.equal(must.column, 'done');
  assert.equal(must.holder, null);
  assert.equal(must.note, '复核通过');
  assert.equal(must.kind, 'must');
  assert.equal(card(tasks, 2).note, '没要求改');
  assert.equal(card(tasks, 2).kind, 'suggest');
  assert.equal(card(tasks, 2).column, 'done');
  assert.equal(card(tasks, 3).note, '没要求改');
  assert.equal(card(tasks, 3).kind, 'question');
  assert.equal(card(tasks, 3).round, 2);
  assert.equal(card(tasks, 5).note, '没要求改');
  assert.equal(card(tasks, 5).column, 'done');
});

test('意见原文截到 120 字，history 保留全文', () => {
  const full = `字${'长'.repeat(120)}`;
  const tasks = teamTasks(team({ state: 'lead', reason: 'disagree', round: 1, phase: 'review' }), [
    review(1, 1, 'changes', [item(1, 'must', full)]),
  ]);
  const task = card(tasks, 1);
  assert.equal(task.text, [...full].slice(0, 120).join(''));
  assert.equal([...task.text].length, 120);
  assert.equal(task.history[0]?.text, full);
  assert.equal(task.updated, 1);
});
