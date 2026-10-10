import type { TestContext } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, root } from './helpers.ts';
import type { Chat, ChatMessage } from '../src/core/chat.ts';
export async function chatContext(t: TestContext, repo = false) {
  const c = await context(t, repo);
  const previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  const cli = (args: string[]) => c.cli(args, { NODE_OPTIONS: `--import ${join(root, 'test/fixtures/chat-engine-hook.mjs')}` });
  return { ...c, cli };
}
export const sampleChat = (id = 'chat-one', extra: Partial<Chat> = {}): Chat => ({
  id, project: '测试', repo: '/repo', title: '测试群', base: 'abc', branch: `xa/chat-${id}`, worktree: `/repo/xa-chat-${id}`,
  members: [{ who: 'grok', effort: 'high', job: 'member-job' }, { who: 'deepseek', effort: 'high', readOnly: true }],
  hopLimit: 4, state: 'open', created: '2026-10-10T01:00:00.000Z', queue: [], ...extra,
});
export const say = (id: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, from: 'owner', kind: 'say', at: '2026-10-10T02:00:00.000Z', text: `消息${id}`, mentions: [], ...extra });
export async function putChat(home: string, chat = sampleChat(), messages: ChatMessage[] = []) {
  const dir = join(home, 'chats', chat.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'chat.json'), JSON.stringify(chat));
  await writeFile(join(dir, 'messages.jsonl'), messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  return dir;
}
