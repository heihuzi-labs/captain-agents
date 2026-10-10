import type { View, ViewChat } from '../../../src/core/view-types.ts';
import type { ChatMessage } from '../../../src/core/chat.ts';
import { ALL_HANDLE, HANDLES, LEAD_HANDLE, OWNER_HANDLE } from '../../../src/core/chat-handles.ts';
import type { Who } from '../../../src/core/roster.ts';

// 协作页（项目群聊）的小工具，规则见 docs/ui-spec.md 第 17 节。

// 群里每个人的叫法：选手用 @ 的短名字（和平台认 @ 的是同一份 HANDLES），负责人、你（主人）、平台。
export const handleOf = (who: Who) => HANDLES[who];
export function authorName(from: ChatMessage['from']): string {
  if (from === 'owner') return '你';
  if (from === 'lead') return '负责人';
  if (from === 'platform') return '';
  return HANDLES[from] ?? from;
}
// @ 候选：群成员、负责人、所有人（不能 @ 自己，主人自己发消息时不列“主人”）。
export type MentionOption = { handle: string; label: string; who?: Who };
export function mentionOptions(chat: Pick<ViewChat, 'members'>, workers: View['workers']): MentionOption[] {
  return [
    ...chat.members.map(m => ({ handle: HANDLES[m.who], label: `${workers[m.who].model}${m.readOnly ? ' · 只读' : ''}`, who: m.who })),
    { handle: LEAD_HANDLE, label: '负责人（群主）' },
    { handle: ALL_HANDLE, label: '群里每一位选手' },
  ];
}
// 把正文切成“普通文字 / @ 某人”几段，界面只给认得出的 @ 上色；仍是纯文字，不当网页代码。
export function splitMentions(text: string, members: Who[]): { text: string; at?: true }[] {
  const names = [...members.map(w => HANDLES[w]), LEAD_HANDLE, OWNER_HANDLE, ALL_HANDLE].sort((a, b) => b.length - a.length);
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`[@＠](${escaped.join('|')})`, 'giu');
  const out: { text: string; at?: true }[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], at: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
// 光标前正在打的 @：返回起点和已经打的字；不在打 @ 就是 null。
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret), m = /[@＠]([^\s@＠]{0,20})$/u.exec(before);
  return m ? { start: caret - m[0].length, query: m[1] } : null;
}
// 群列表里那一行的预览：最后一条有人说的话（平台事件、工作卡不算），“名字：第一行”。
export function preview(chat: Pick<ViewChat, 'messages'>): { text: string; at: string } | null {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.kind === 'event' || m.kind === 'work') continue;
    const line = m.text.split('\n').filter(l => !/^\s{0,3}#{1,6}\s/.test(l)).map(l => l.trim()).find(Boolean) ?? '';
    return { text: `${authorName(m.from)}：${line}`, at: m.at };
  }
  return null;
}
// 读到哪一条记在本机（每个群一条），读写失败不影响使用。
const READ_KEY = 'xa.chat-read';
export function readMarks(): Record<string, number> {
  try { const v: unknown = JSON.parse(localStorage.getItem(READ_KEY) || '{}'); return v && typeof v === 'object' ? v as Record<string, number> : {}; }
  catch { return {}; }
}
export function markRead(id: string, message: number) {
  try { const marks = readMarks(); if ((marks[id] ?? 0) >= message) return; marks[id] = message; localStorage.setItem(READ_KEY, JSON.stringify(marks)); }
  catch { /* 记不住就算了 */ }
}
// 有没有你还没看过的、别人说的话。
export const unread = (chat: Pick<ViewChat, 'id' | 'messages'>, marks = readMarks()) =>
  chat.messages.some(m => m.id > (marks[chat.id] ?? 0) && m.from !== 'owner' && m.kind !== 'event');
// 群的状态一句话：谁在动手、几位在排队。
export function chatStatus(chat: Pick<ViewChat, 'members' | 'state'>, workers: View['workers']): string {
  if (chat.state === 'closed') return '已结束';
  const working = chat.members.find(m => m.state === 'working'), queued = chat.members.filter(m => m.state === 'queued').length;
  if (!working) return queued ? `${queued} 位在排队` : '都空闲';
  return `${workers[working.who].model} 在动手${queued ? ` · ${queued} 位在排队` : ''}`;
}
// 归档是你自己的整理：归档的群收进左栏最下面“已归档”，随时可以取消。记在本机，读写失败不影响使用。
const ARCHIVE_KEY = 'xa.chat-archived';
export function readArchived(): Set<string> {
  try { const v: unknown = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]'); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []); }
  catch { return new Set(); }
}
export function rememberArchived(ids: Set<string>) { try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...ids])); } catch { /* 记不住就算了 */ } }
// 置顶也是你自己的整理：置顶的群排在列表最前面。记在本机。
const PIN_KEY = 'xa.chat-pinned';
export function readPinned(): Set<string> {
  try { const v: unknown = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []); }
  catch { return new Set(); }
}
export function rememberPinned(ids: Set<string>) { try { localStorage.setItem(PIN_KEY, JSON.stringify([...ids])); } catch { /* 记不住就算了 */ } }
