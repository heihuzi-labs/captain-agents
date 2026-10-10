import { setTimeout as sleep } from 'node:timers/promises';
import { createChat, listChats, readChat, readMessages, sayInChat, pendingForLead, HANDLES } from '../core/chat.ts';
import type { CreateChatOptions, ChatMessage } from '../core/chat.ts';
import { stopChat, closeChat, cleanChat, reconcileChat } from '../core/chat-engine.ts';
import { listJobs } from '../core/job.ts';
import { listTeams } from '../core/team.ts';
import { allOwnerActions } from '../core/wait.ts';
import { localTime, table } from './format.ts';

// 终端同样只展示文字，不执行报告中的控制序列。
export const chatPlain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
const author = (m: ChatMessage) => m.from === 'owner' ? '主人' : m.from === 'lead' ? '负责人' : m.from === 'platform' ? '平台' : HANDLES[m.from];
export async function chatNew(options: CreateChatOptions) {
  const chat = await createChat(options);
  console.log(`群号：${chat.id}\n群名：${chat.title}\n副本：${chat.worktree}`);
}
export async function chatList() {
  const chats = await listChats();
  console.log(chats.length ? table(['群号', '项目', '群名', '状态', '成员'], chats.map(c => [c.id, c.project, chatPlain(c.title), c.state === 'open' ? '开着' : '已收起', c.members.map(m => `${HANDLES[m.who]}${m.readOnly ? '（只读）' : ''}`).join('、')])) : '没有群聊。');
}
export async function chatLog(id: string, all = false) {
  const messages = await readMessages(id), shown = all ? messages : messages.slice(-20);
  console.log(shown.length ? shown.map(m => `#${m.id} ${author(m)} ${localTime(m.at)}\n${chatPlain(m.text)}`).join('\n\n') : '群里还没有消息。');
}
export async function chatSay(id: string, text: string) {
  const m = await sayInChat(id, text, 'lead');
  console.log(`已发到群聊 ${id}：${m.text}`);
}
export async function chatControl(action: 'stop' | 'close' | 'clean', id: string) {
  const chat = await ({ stop: stopChat, close: closeChat, clean: cleanChat }[action])(id);
  console.log(`群聊 ${chat.id} ${action === 'stop' ? '已停下' : action === 'close' ? '已收起' : '已清理'}。`);
}
const actions = async () => allOwnerActions(await listJobs(), await listTeams(), await listChats());
export async function chatWait(id: string): Promise<number> {
  await readChat(id);
  const known = new Set((await actions()).map(a => a.key));
  while (true) {
    const chat = await reconcileChat(await readChat(id));
    const pending = pendingForLead(await readMessages(id));
    if (pending.length) {
      console.log(pending.map(m => `${author(m)}：${chatPlain(m.text)}`).join('\n')); return 4;
    }
    const fresh = (await actions()).filter(a => !known.has(a.key));
    if (!chat.busy && !chat.queue.length) { console.log(`群聊 ${id} 已空闲。`); return 0; }
    if (fresh.length) { console.log('主人有新动作，请运行 xagents inbox 查看。'); return 3; }
    await sleep(2000);
  }
}
