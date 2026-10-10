import './fixtures/chat-engine-hook.mjs';
import { spawn } from 'node:child_process';
import { root, until } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chatContext, putChat, sampleChat, say } from './chat-helpers.ts';
import { readMessages, appendChatMessage } from '../src/core/chat.ts';
import { waitForJobs, chatOwnerActions } from '../src/core/wait.ts';
import type { Job } from '../src/core/job.ts';

test('chat 命令：帮助、参数拒绝、建群和成员写法', async t => {
  const c = await chatContext(t, true); await c.add();
  assert.match((await c.cli(['chat', '--help'])).stdout, /chat new/);
  const bad = [[], ['new'], ['new', '测试'], ['new', '测试', '--member'], ['new', '测试', '--member', 'grok:high', '--hops', '1.5'],
    ['new', '测试', '--member', 'grok:high', '--hops', '0'], ['new', '测试', '--member', 'grok:high', '--title', 'a', '--title', 'b'],
    ['list', 'extra'], ['log'], ['log', 'chat-one', '--bad'], ['say', 'id'], ['stop'], ['close', 'id', 'extra'], ['clean'], ['wait'], ['unknown']];
  for (const args of bad) { const r = await c.cli(['chat', ...args]); assert.equal(r.code, 1, JSON.stringify(args)); assert.ok(r.stderr); }
  const r = await c.cli(['chat', 'new', '测试', '--member', 'grok:high:fast', '--member', 'deepseek:high:ro', '--title', '命令行群', '--hops', '3']);
  assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /群号：/); assert.match(r.stdout, /群名：命令行群/);
  const id = /群号：([^\n]+)/.exec(r.stdout)![1];
  const chat = JSON.parse(await readFile(join(c.home, 'chats', id, 'chat.json'), 'utf8'));
  assert.equal(chat.hopLimit, 3); assert.equal(chat.members[1].readOnly, true);
});

test('chat list/log/say/inbox/wait：纯文字、最近20条、处理负责人收件、退出码', async t => {
  const c = await chatContext(t);
  assert.match((await c.cli(['chat', 'list'])).stdout, /没有群聊/);
  await putChat(c.home, sampleChat(), Array.from({ length: 25 }, (_, i) => say(i + 1, { from: 'platform', kind: 'event', text: `第${i + 1}条\u0007` })));
  assert.match((await c.cli(['chat', 'list'])).stdout, /测试群.*开着/s);
  const log = await c.cli(['chat', 'log', 'chat-one']);
  assert.equal(log.code, 0, log.stderr); assert.match(log.stdout, /第6条/); assert.doesNotMatch(log.stdout, /第5条|\u0007/);
  assert.match((await c.cli(['chat', 'log', 'chat-one', '--all'])).stdout, /第1条/);
  assert.equal((await c.cli(['chat', 'wait', 'chat-one'])).code, 0);
  await appendChatMessage('chat-one', { from: 'owner', kind: 'say', text: '主人需要回复' });
  await appendChatMessage('chat-one', { from: 'grok', kind: 'report', text: '@负责人 选手需要处理' });
  const inbox = await c.cli(['inbox']);
  assert.match(inbox.stdout, /主人需要回复/); assert.match(inbox.stdout, /选手需要处理/);
  assert.equal((await c.cli(['chat', 'wait', 'chat-one'])).code, 4);
  const said = await c.cli(['chat', 'say', 'chat-one', '@Grok 继续']);
  assert.equal(said.code, 0, said.stderr);
  const messages = await readMessages('chat-one');
  assert.equal(messages.at(-1)?.from, 'lead'); assert.ok(messages.at(-2)?.handled);
  assert.match((await c.cli(['inbox'])).stdout, /没有等你照办的事/);
  assert.equal((await c.cli(['chat', 'wait', 'chat-one'])).code, 0);
  for (const command of ['stop', 'close', 'clean']) assert.equal((await c.cli(['chat', command, 'chat-one'])).code, 0);
  assert.match((await c.cli(['chat', 'log', 'missing'])).stderr, /找不到群聊/);
});

test('wait 的主人新动作：只收主人给负责人的消息，选手汇报只进 inbox', async t => {
  const c = await chatContext(t); await putChat(c.home);
  const chat = sampleChat();
  const job = { id: 'j', state: 'running' } as Job;
  let poll = 0;
  const result = await waitForJobs('j', {
    list: async () => [], select: async () => [job], chats: async () => [chat],
    refresh: async () => {
      poll++;
      if (poll === 1) await appendChatMessage(chat.id, { from: 'grok', kind: 'report', text: '@负责人 选手汇报' });
      if (poll === 2) await appendChatMessage(chat.id, { from: 'owner', kind: 'say', text: '@Grok 主人直接派活' });
      if (poll === 3) await appendChatMessage(chat.id, { from: 'owner', kind: 'say', text: '请负责人处理' });
    }, sleep: async () => {},
  });
  assert.equal(poll, 3); assert.equal(result.reason, 'owner'); assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].text, '请负责人处理');
  assert.equal((await chatOwnerActions([chat])).length, 1);
});


test('chat wait 正在等群时，别群的主人新动作退出码 3', async t => {
  const c = await chatContext(t);
  await putChat(c.home, sampleChat('busy-chat', { busy: { who: 'grok', job: 'member-job', message: 1, since: 'now' } }));
  await putChat(c.home, sampleChat('other-chat'));
  const child = spawn(process.execPath, ['--import', join(root, 'test/fixtures/chat-engine-hook.mjs'), join(root, 'src/cli/cli.ts'), 'chat', 'wait', 'busy-chat'], {
    cwd: root, env: { ...c.env, XAGENTS_CHAT_TEST_READY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; });
  await until(async () => output.includes('等待就绪'));
  await appendChatMessage('other-chat', { from: 'owner', kind: 'say', text: '新安排' });
  assert.equal(await done, 3, error); assert.match(output, /主人有新动作/);
});
