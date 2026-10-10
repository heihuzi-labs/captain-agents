import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { buildView } from '../src/core/view.ts';
import { writeJson } from '../src/core/fsx.ts';
import type { Team, ChannelMessage, ReviewItem } from '../src/core/team.ts';
import { reasonText } from '../app/shared/attention.ts';
import { deliver, notices, notificationTracker } from '../app/main/notifications.ts';
import type { Notice } from '../app/main/notifications.ts';

const DEAD = 2_147_483_647;

async function registry(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'xa-team-view-'));
  const previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}
function team(id: string, extra: Partial<Team> = {}): Team {
  return {
    id, mode: 'pair', project: 'xagents', repo: '/repo', base: 'abc', kind: '实现', title: '小队题目', summary: '给主人看的说明', task: '# 题目',
    writer: { who: 'grok', effort: 'high' }, reviewer: { who: 'deepseek', effort: 'high' },
    round: 1, phase: 'write', maxRounds: 3, maxMinutes: 60, state: 'running', created: '2026-10-10T01:00:00.000Z', ...extra,
  };
}
function line(message: ChannelMessage) {
  return JSON.stringify(message);
}
async function save(home: string, record: Team, lines: string[] = []) {
  const dir = join(home, 'teams', record.id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'team.json');
  await writeJson(file, record);
  if (lines.length) await writeFile(join(dir, 'channel.jsonl'), lines.join('\n') + '\n');
  return file;
}

test('buildView().teams：频道、意见、一行摘要、未处理的话和队员任务号', async t => {
  const home = await registry(t);
  const oldItems: ReviewItem[] = [{ n: 1, level: 'suggest', text: '旧意见', reply: null }];
  const items: ReviewItem[] = [
    { n: 1, level: 'must', text: '必须改这里', reply: 'fixed', replyText: '已经改了' },
    { n: 2, level: 'question', text: '这处为什么', reply: 'declined', replyText: '不改的理由' },
    { n: 3, level: 'suggest', text: '可以更好', reply: null },
  ];
  const at = (n: number) => `2026-10-10T02:0${n}:00.000Z`;
  const rich: ChannelMessage[] = [
    { id: 1, at: at(1), round: 1, from: 'platform', kind: 'event', text: '开队' },
    { id: 2, at: at(2), round: 1, from: 'writer', kind: 'report', text: '较早的报告' },
    { id: 3, at: at(3), round: 1, from: 'reviewer', kind: 'review', text: '旧审查', items: oldItems },
    { id: 4, at: at(4), round: 2, from: 'owner', kind: 'say', text: '先说一句' },
    { id: 5, at: at(5), round: 2, from: 'reviewer', kind: 'review', text: '新审查', verdict: 'changes', items },
    { id: 6, at: at(6), round: 2, from: 'owner', kind: 'say', text: '已处理', handled: at(6) },
    { id: 7, at: at(7), round: 2, from: 'reviewer', kind: 'report', text: '***\n\n# 标题行跳过\n*第一行* `保留`\n第二行不该出现' },
    { id: 8, at: at(8), round: 2, from: 'platform', kind: 'event', text: '叫醒写手' },
  ];
  const richFile = await save(home, team('1010-0300-rich', {
    created: '2026-10-10T03:00:00.000Z', title: '小队题目', summary: '给主人看的说明', kind: '实现', project: 'xagents',
    round: 2, phase: 'review', maxRounds: 3, maxMinutes: 45, state: 'running', pid: process.pid, note: '备注',
    writer: { who: 'grok', effort: 'high', job: 'w-1' }, reviewer: { who: 'deepseek', effort: 'high', job: '' },
  }), ['{', ...rich.map(line)]);
  const longLines = [line({ id: 1, at: at(1), round: 1, from: 'owner', kind: 'say', text: '窗口外的话' })];
  for (let id = 2; id <= 200; id++) {
    longLines.push(id === 50
      ? line({ id, at: at(1), round: 1, from: 'owner', kind: 'say', text: '已处理', handled: at(1) })
      : id === 10
        ? line({ id, at: at(1), round: 1, from: 'reviewer', kind: 'review', text: '没有意见表' })
        : line({ id, at: at(1), round: 1, from: 'platform', kind: 'event', text: '平台' }));
  }
  longLines.push(line({ id: 201, at: '2026-10-10T05:00:00.000Z', round: 1, from: 'reviewer', kind: 'report', text: '* ' + '字'.repeat(81) }));
  await save(home, team('1010-0100-long', {
    created: '2026-10-10T01:00:00.000Z', title: '长频道', state: 'ended', ended: '2026-10-10T04:00:00.000Z', pid: DEAD,
    writer: { who: 'grok', effort: 'high', job: '' }, reviewer: { who: 'deepseek', effort: 'high', job: 'rev-1' },
  }), longLines);
  const before = await readFile(richFile, 'utf8'), info = await stat(richFile);
  const view = await buildView();
  assert.deepEqual(view.teams.map(item => item.id), ['1010-0300-rich', '1010-0100-long']);
  const row = view.teams[0];
  assert.deepEqual(Object.keys(row).sort(), 'id mode project title summary kind state reason note round maxRounds phase maxMinutes started ended writer reviewer writerWho reviewerWho items lastLine channel pendingOwner tasks'.split(' ').sort());
  assert.equal(row.mode, 'pair'); assert.equal(row.project, 'xagents'); assert.equal(row.title, '小队题目');
  assert.equal(row.summary, '给主人看的说明'); assert.equal(row.kind, '实现');
  assert.equal(row.state, 'running'); assert.equal(row.reason, null); assert.equal(row.note, '备注');
  assert.equal(row.round, 2); assert.equal(row.maxRounds, 3); assert.equal(row.phase, 'review'); assert.equal(row.maxMinutes, 45);
  assert.equal(row.started, '2026-10-10T03:00:00.000Z'); assert.equal(row.ended, null);
  assert.equal(row.writer, 'w-1'); assert.equal(row.reviewer, null);
  assert.equal(row.writerWho, 'grok'); assert.equal(row.reviewerWho, 'deepseek');
  assert.deepEqual(row.items, items);
  assert.deepEqual(row.lastLine, { from: 'reviewer', text: '第一行 保留', at: at(7) });
  assert.deepEqual(row.channel.map(message => message.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(row.pendingOwner, 1);
  assert.equal(JSON.stringify(row).includes('较早的报告') && !JSON.stringify(row).includes('<'), true);
  const long = view.teams[1];
  assert.equal(long.state, 'ended', '已经收场的小队不因为进程不在改成 lost');
  assert.equal(long.reason, null); assert.equal(long.ended, '2026-10-10T04:00:00.000Z');
  assert.equal(long.writer, null); assert.equal(long.reviewer, 'rev-1');
  assert.equal(long.channel.length, 200); assert.equal(long.channel[0].id, 2); assert.equal(long.channel.at(-1)?.id, 201);
  assert.deepEqual(long.items, []);
  assert.equal(long.pendingOwner, 1, '窗口外还没处理的话也要算');
  assert.equal(long.lastLine?.from, 'reviewer'); assert.equal(long.lastLine?.text, '字'.repeat(80)); assert.equal(long.lastLine?.at, '2026-10-10T05:00:00.000Z');
  assert.equal(await readFile(richFile, 'utf8'), before);
  assert.equal((await stat(richFile)).mtimeMs, info.mtimeMs);
});

test('坏的小队文件跳过，其余照常显示，坏文件保持原样', async t => {
  const home = await registry(t);
  await save(home, team('good', { pid: process.pid, title: '好的' }));
  await mkdir(join(home, 'teams', 'bad'), { recursive: true });
  await writeFile(join(home, 'teams', 'bad', 'team.json'), '{');
  await mkdir(join(home, 'teams', 'nullish'), { recursive: true });
  await writeFile(join(home, 'teams', 'nullish', 'team.json'), 'null');
  await mkdir(join(home, 'teams', 'mismatch'), { recursive: true });
  await writeJson(join(home, 'teams', 'mismatch', 'team.json'), team('other'));
  await mkdir(join(home, 'teams', 'emptywho'), { recursive: true });
  await writeJson(join(home, 'teams', 'emptywho', 'team.json'), team('emptywho', { writer: { who: 'nope', effort: 'high' } }));
  await writeFile(join(home, 'teams', 'broken.json'), '{"id":"broken.json"}');
  const view = await buildView();
  assert.deepEqual(view.teams.map(item => item.id), ['good']);
  assert.equal(view.teams[0].title, '好的');
  assert.equal(await readFile(join(home, 'teams', 'bad', 'team.json'), 'utf8'), '{');
  assert.equal(await readFile(join(home, 'teams', 'nullish', 'team.json'), 'utf8'), 'null');
});

test('推进进程不在时视图显示 lead/lost，不写文件；已是 lead 的原因保留', async t => {
  const home = await registry(t);
  const lostFile = await save(home, team('lost', { title: '失联题', pid: DEAD, note: '原备注', state: 'running' }));
  await save(home, team('live', { title: '还在跑', pid: process.pid, created: '2026-10-10T02:00:00.000Z' }));
  await save(home, team('parked', { title: '通过题', state: 'lead', reason: 'passed', note: '通过了', pid: DEAD, created: '2026-10-10T03:00:00.000Z' }));
  const before = await readFile(lostFile, 'utf8'), info = await stat(lostFile);
  const view = await buildView();
  const byId = (id: string) => view.teams.find(item => item.id === id)!;
  assert.equal(byId('lost').state, 'lead'); assert.equal(byId('lost').reason, 'lost'); assert.equal(byId('lost').note, '原备注');
  assert.equal(byId('live').state, 'running'); assert.equal(byId('live').reason, null);
  assert.equal(byId('parked').state, 'lead'); assert.equal(byId('parked').reason, 'passed'); assert.equal(byId('parked').note, '通过了');
  assert.equal(await readFile(lostFile, 'utf8'), before);
  assert.equal((await stat(lostFile)).mtimeMs, info.mtimeMs);
  assert.equal(JSON.parse(before).state, 'running');
});

test('小队进入 lead 才通知：标题是题目，正文按原因；沿用去重和通知开关', async t => {
  assert.equal(reasonText('passed'), '审查说通过了，等负责人验收');
  assert.equal(reasonText('disagree'), '还有必须改的没谈拢，等负责人裁决');
  for (const reason of ['unclear', 'brake', 'blocked', 'failed', 'lost', null] as const) assert.equal(reasonText(reason), '小队停下了，等负责人处理');
  const home = await registry(t);
  await save(home, team('passed', { title: '通过题', state: 'lead', reason: 'passed', round: 2, created: '2026-10-10T05:00:00.000Z' }));
  await save(home, team('disagree', { title: '谈不拢', state: 'lead', reason: 'disagree', round: 3, created: '2026-10-10T04:00:00.000Z' }));
  await save(home, team('moving', { title: '还在跑', state: 'running', pid: process.pid, created: '2026-10-10T03:00:00.000Z' }));
  await save(home, team('ended', { title: '收场了', state: 'ended', ended: '2026-10-10T02:00:00.000Z', created: '2026-10-10T02:00:00.000Z' }));
  const lostFile = await save(home, team('lost', { title: '失联题', state: 'running', pid: DEAD, round: 1, created: '2026-10-10T01:00:00.000Z' }));
  const before = await readFile(lostFile, 'utf8');
  const view = await buildView();
  const found = notices(view).filter(notice => notice.target.kind === 'team');
  assert.deepEqual(found.map(notice => [notice.key, notice.title, notice.body, notice.target]), [
    ['team:passed:lead:2:passed', '通过题', '审查说通过了，等负责人验收', { kind: 'team', id: 'passed' }],
    ['team:disagree:lead:3:disagree', '谈不拢', '还有必须改的没谈拢，等负责人裁决', { kind: 'team', id: 'disagree' }],
    ['team:lost:lead:1:lost', '失联题', '小队停下了，等负责人处理', { kind: 'team', id: 'lost' }],
  ]);
  assert.equal(found.some(notice => notice.title === '还在跑' || notice.title === '收场了'), false);
  assert.equal(deliver(view, found)[0].title, '通过题');
  assert.equal(await readFile(lostFile, 'utf8'), before);
  const sent: Notice[] = [];
  const track = await notificationTracker(join(home, 'notify'), notice => { sent.push(notice); });
  const baseline = await buildView();
  await track(baseline); assert.equal(sent.length, 0, '启动时已是 lead 的不补发');
  const movingFile = join(home, 'teams', 'moving', 'team.json');
  const moving = JSON.parse(await readFile(movingFile, 'utf8')) as Team;
  moving.state = 'lead'; moving.reason = 'disagree';
  await writeJson(movingFile, moving);
  const next = await buildView();
  await track(next);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '还在跑'); assert.equal(sent[0].body, '还有必须改的没谈拢，等负责人裁决');
  assert.deepEqual(sent[0].target, { kind: 'team', id: 'moving' });
  await track(next); assert.equal(sent.length, 1, '同一轮同一原因不重复发');
  next.settings.notifications = false;
  moving.round = 2;
  await writeJson(movingFile, moving);
  const muted = await buildView(); muted.settings.notifications = false;
  await track(muted); assert.equal(sent.length, 1, '关掉通知时只记账不发');
  muted.settings.notifications = true;
  await track(muted); assert.equal(sent.length, 1, '重新打开不补发');
  moving.round = 3; moving.reason = 'passed';
  await writeJson(movingFile, moving);
  const again = await buildView();
  await track(again); assert.equal(sent.length, 2);
  assert.equal(sent[1].body, '审查说通过了，等负责人验收');
  assert.equal(sent[1].key, 'team:moving:lead:3:passed');
});
