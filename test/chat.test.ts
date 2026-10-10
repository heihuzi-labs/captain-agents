import './fixtures/chat-engine-hook.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMentions, readChat, updateChat, listChats, readMessages, appendChatMessage, createChat, sayInChat, pendingForLead, CHAT_TEXT_MAX, HANDLES } from '../src/core/chat.ts';
import { whos } from '../src/core/roster.ts';
import { chatContext, putChat, sampleChat, say } from './chat-helpers.ts';
import { effectiveWorkers } from '../src/core/policy.ts';

const mock = globalThis as typeof globalThis & { __chatWakes?: string[]; __chatWakeError?: string };
test('@认人：短名、大小写、全角、中文紧邻、未知名字、邮件地址和去重', () => {
  assert.deepEqual(parseMentions(whos.map(w => `@${HANDLES[w]}`).join(' '), whos), whos);
  assert.deepEqual(parseMentions('请＠Ｇｒｏｋ改一下，@DEEPSEEK 审；@grok @负责人 @主人 @所有人 @负责人', ['grok', 'deepseek']), ['grok', 'deepseek', 'lead', 'owner', 'all']);
  assert.deepEqual(parseMentions('@GrokExtra @grok-fast x@grok @Codex @路人 @codex-luna', ['grok']), []);
  assert.deepEqual(parseMentions('@Luna @Flash', ['codex-luna', 'deepseek-flash']), ['codex-luna', 'deepseek-flash']);
});

test('锁内并发更新、追加递增编号；坏行跳过；找不到给中文错误', async t => {
  const c = await chatContext(t); const dir = await putChat(c.home);
  await Promise.all(Array.from({ length: 12 }, () => updateChat('chat-one', chat => { chat.hopLimit++; })));
  assert.equal((await readChat('chat-one')).hopLimit, 16);
  await Promise.all(Array.from({ length: 12 }, (_, n) => appendChatMessage('chat-one', { from: 'lead', kind: 'say', text: `@Grok ${n}` })));
  const list = await readMessages('chat-one');
  assert.deepEqual(list.map(m => m.id), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(list[0].mentions, ['grok']);
  await appendFile(join(dir, 'messages.jsonl'), '{\nnull\n{}\n' + JSON.stringify(say(30)) + '\n');
  assert.equal((await readMessages('chat-one')).length, 13);
  assert.equal((await appendChatMessage('chat-one', { from: 'platform', kind: 'event', text: '测试', mentions: ['lead'] })).id, 31);
  for (const read of [readChat, readMessages]) await assert.rejects(read('missing'), /找不到群聊/);
  await assert.rejects(updateChat('missing', () => {}), /找不到群聊/);
  await mkdir(join(c.home, 'chats', 'broken')); await writeFile(join(c.home, 'chats', 'broken', 'chat.json'), '{');
  await putChat(c.home, sampleChat('null')); await writeFile(join(c.home, 'chats', 'null', 'chat.json'), 'null');
  assert.deepEqual((await listChats()).map(c => c.id), ['chat-one']);
});

test('负责人待处理规则覆盖主人、选手、平台事件、所有人及已处理消息', () => {
  const messages = [say(1), say(2, { mentions: ['grok'] }), say(3, { mentions: ['all'] }), say(4, { mentions: ['owner'] }),
    say(5, { from: 'grok', kind: 'report', mentions: ['lead'] }), say(6, { from: 'grok', kind: 'report', mentions: ['owner'] }),
    say(7, { from: 'platform', kind: 'event', mentions: ['lead'] }), say(8, { handled: 'done' }), say(9, { mentions: ['grok', 'lead'] })];
  assert.deepEqual(pendingForLead(messages).map(m => m.id), [1, 4, 5, 7, 9]);
  assert.deepEqual(pendingForLead([...messages, say(10, { from: 'lead' }), say(11)]).map(m => m.id), [11]);
});

test('说话长度按码点、控制字符、收起拒绝、处理记号和叫醒替身', async t => {
  const c = await chatContext(t); await putChat(c.home, sampleChat(), [say(1), say(2, { from: 'grok', kind: 'report', mentions: ['lead'] })]);
  mock.__chatWakes = [];
  const m = await sayInChat('chat-one', '  回答\r\n@Grok 开始  ', 'lead');
  assert.equal(m.text, '回答\n@Grok 开始'); assert.equal(m.hop, 0);
  assert.deepEqual(mock.__chatWakes, ['chat-one']);
  assert.ok((await readMessages('chat-one')).slice(0, 2).every(m => m.handled));
  await sayInChat('chat-one', '🙂'.repeat(CHAT_TEXT_MAX), 'owner');
  for (const text of ['', ' ', '字'.repeat(CHAT_TEXT_MAX + 1), 'a\tb', 'a\u001bb', 'a\u2028b']) await assert.rejects(sayInChat('chat-one', text, 'owner'));
  mock.__chatWakeError = '还没实现：wakeChat';
  await sayInChat('chat-one', '尚未实现也能落盘', 'owner');
  mock.__chatWakeError = '真实故障';
  await assert.rejects(sayInChat('chat-one', '真实故障会报出', 'owner'), /真实故障/);
  delete mock.__chatWakeError;
  await updateChat('chat-one', chat => { chat.state = 'closed'; });
  await assert.rejects(sayInChat('chat-one', '关闭后', 'owner'), /已经收起/);
});

test('建群：main 起点、正确副本路径、setup、只读/快速、重复群号', async t => {
  const c = await chatContext(t, true);
  assert.equal((await c.add(['--setup', 'echo ready > setup-result.txt'])).code, 0);
  const chat = await createChat({ project: '测试', members: ['grok:high:fast:ro', 'deepseek:high'], title: ' 群名 ' });
  assert.equal(chat.title, '群名'); assert.equal(chat.base, c.base); assert.equal(chat.hopLimit, 4);
  assert.equal(chat.worktree, join(c.repo, '.worktrees', `xa-chat-${chat.id}`));
  assert.equal(chat.branch, `xa/chat-${chat.id}`);
  assert.deepEqual(chat.members[0], { who: 'grok', effort: 'high', fast: true, readOnly: true });
  assert.equal((await readFile(join(chat.worktree, 'setup-result.txt'), 'utf8')).trim(), 'ready');
  assert.equal((await readMessages(chat.id))[0].kind, 'event');
  const next = await createChat({ project: '测试', members: ['codex:high'] });
  assert.notEqual(next.id, chat.id); assert.match(next.id, /-2$/);
  assert.equal((await listChats()).length, 2);
  assert.deepEqual(await readdir(join(c.home, 'jobs')), [], '开群不创建伪成员任务');
});

test('建群拒绝：未登记、归档、成员数量/重复/语法/续接/强度/主人设置；setup失败回收', async t => {
  const c = await chatContext(t, true);
  await assert.rejects(createChat({ project: 'missing', members: ['grok:high'] }), /没有登记/);
  await c.add();
  const newChat = (members: string[]) => createChat({ project: '测试', members });
  for (const members of [[], Array(7).fill('grok:high'), ['grok:high', 'grok:medium'], ['cursor-grok:high'], ['codex:max'], ['grok:high:ro:fast'], ['deepseek:high:fast'], ['unknown:high']]) await assert.rejects(newChat(members));
  await assert.rejects(createChat({ project: '测试', members: ['grok:high'], hopLimit: 0 }), /正整数/);
  await assert.rejects(createChat({ project: '测试', members: ['grok:high'], title: 'x'.repeat(101) }), /群名/);
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ archivedProjects: ['测试'] }));
  await assert.rejects(newChat(['grok:high']), /归档/);
  const policy = effectiveWorkers({}); policy.grok.enabled = false;
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ workers: policy }));
  await assert.rejects(newChat(['grok:high']), /主人/);
  policy.grok.enabled = true; policy.grok.efforts = ['medium'];
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ workers: policy }));
  await assert.rejects(newChat(['grok:high']), /主人/);
  policy.grok.efforts = ['high']; policy.grok.fast = false;
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ workers: policy }));
  await assert.rejects(newChat(['grok:high:fast']), /主人/);
  await writeFile(join(c.home, 'config.json'), '{}');
  await c.add(['--setup', 'exit 7']);
  await assert.rejects(newChat(['grok:high']), /准备副本失败/);
  assert.deepEqual(await listChats(), []);
  assert.equal(await c.git(['branch', '--list', 'xa/chat-*']), '');
});

test('改群名：去掉首尾空白，只改名字；空的、太长、带控制字符的拒绝；找不到给中文错误', async t => {
  const { renameChat, readChat, readMessages } = await import('../src/core/chat.ts');
  const c = await chatContext(t); await putChat(c.home, sampleChat(), [say(1)]);
  const before = await readChat('chat-one');
  assert.equal((await renameChat('chat-one', '  评分历史  ')).title, '评分历史');
  assert.deepEqual({ ...await readChat('chat-one'), title: before.title }, before);
  assert.equal((await readMessages('chat-one')).length, 1);
  for (const bad of ['', '   ', 'x'.repeat(101), 'a\nb', 5 as unknown as string]) await assert.rejects(renameChat('chat-one', bad), /群名请写/);
  await assert.rejects(renameChat('nope', '名字'), /找不到/);
});
