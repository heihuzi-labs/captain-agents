import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildView } from '../src/core/view.ts';
import { entries } from '../app/shared/attention.ts';
import { notices, notificationTracker } from '../app/main/notifications.ts';
import type { Notice } from '../app/main/notifications.ts';
import { chatContext, putChat, sampleChat, say } from './chat-helpers.ts';

test('群看板只读：成员状态、纯文字、负责人待处理、跳过坏文件；成员的活归到群这一件，不混进一批', async t => {
  const c = await chatContext(t);
  const chat = sampleChat('chat-one', { busy: { who: 'grok', job: 'member-job', message: 1, since: 'now' }, queue: [{ who: 'deepseek', message: 2, hop: 1 }], members: [...sampleChat().members, { who: 'codex', effort: 'high' }] });
  const dir = await putChat(c.home, chat, [say(1, { text: '<script>不执行</script>' }), say(2, { from: 'grok', kind: 'report', mentions: ['lead'] })]);
  const before = await readFile(join(dir, 'chat.json'), 'utf8'), info = await stat(join(dir, 'chat.json'));
  await putChat(c.home, sampleChat('bad')); await writeFile(join(c.home, 'chats/bad/chat.json'), '{');
  await putChat(c.home, sampleChat('wrong')); await writeFile(join(c.home, 'chats/wrong/chat.json'), JSON.stringify({ ...chat, id: 'wrong', members: [{ who: 'invalid' }] }));
  await writeFile(join(c.home, 'chats', 'broken.json'), '{}');
  const view = await buildView();
  assert.equal(view.chats.length, 1);
  assert.deepEqual(view.chats[0].members.map(m => m.state), ['working', 'queued', 'idle']);
  assert.equal(view.chats[0].members[1].readOnly, true); assert.equal(view.chats[0].members[1].job, null);
  assert.equal(view.chats[0].pendingLead, 2); assert.equal(view.chats[0].messages[0].text, '<script>不执行</script>');
  assert.equal(await readFile(join(dir, 'chat.json'), 'utf8'), before); assert.equal((await stat(join(dir, 'chat.json'))).mtimeMs, info.mtimeMs);
  for (const id of ['member-job', 'normal']) {
    await mkdir(join(c.home, 'jobs', id), { recursive: true });
    await writeFile(join(c.home, 'jobs', id, 'job.json'), JSON.stringify({ id, batch: '', project: '测试', repo: '/repo', worktree: '/repo', base: 'abc', branch: 'b', who: 'grok', model: 'test', effort: 'high', kind: '实现', title: '任务', state: 'done', created: chat.created }));
  }
  const next = await buildView();
  next.batches.push({ id: 'b', title: '批次', kind: '实现', summary: '批次', base: '', started: chat.created, jobs: ['member-job', 'normal'] });
  // 成员的活在看板数据里用群的现名（派活那一刻抄下来的“任务”不算数），不套“通常多久”；普通的活不受影响。
  const member = next.jobs.find(j => j.id === 'member-job')!, normal = next.jobs.find(j => j.id === 'normal')!;
  assert.deepEqual([member.title, member.summary, member.typical], [chat.title, `处理「${chat.title}」群里的安排`, null]);
  assert.equal(normal.title, '任务');
  // 群成员的活归到“群”这一件（点开回群里）；同一批里剩下的那件按单家活处理。
  assert.deepEqual(entries(next).map(e => [e.target.kind, e.target.id, e.kind, e.members.map(m => m.id).join()]), [['chat', 'chat-one', '群聊', 'member-job'], ['job', 'normal', '实现', 'normal']]);
});

test('选手 report @主人系统通知：目标为群，开关、去重、重启均沿用现有规则', async t => {
  const c = await chatContext(t); await putChat(c.home);
  const sent: Notice[] = [], track = await notificationTracker(join(c.home, 'notify'), n => sent.push(n));
  await track(await buildView());
  const messages = [say(1, { from: 'grok', kind: 'report', text: '@主人 请验收', mentions: ['owner'] }),
    say(2, { from: 'lead', mentions: ['owner'] }), say(3, { from: 'grok', kind: 'work', mentions: ['owner'] })];
  await putChat(c.home, sampleChat(), messages);
  const view = await buildView();
  assert.equal(notices(view).length, 1); assert.deepEqual(notices(view)[0].target, { kind: 'chat', id: 'chat-one' });
  await track(view); await track(view); assert.equal(sent.length, 1);
  view.chats[0].messages.push(say(4, { from: 'deepseek', kind: 'report', mentions: ['owner'] }));
  view.settings.notifications = false; await track(view);
  view.settings.notifications = true; await track(view); assert.equal(sent.length, 1);
  const restarted = await notificationTracker(join(c.home, 'notify'), n => sent.push(n));
  await restarted(view); await restarted(view); assert.equal(sent.length, 1);
  view.chats[0].messages.push(say(5, { from: 'grok', kind: 'report', mentions: ['owner'] }));
  await restarted(view); assert.equal(sent.length, 2);
});
