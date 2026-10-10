import { mkdir, readdir, rm } from 'node:fs/promises';
import { readJson, writeJson, readOptional, writeAtomic, withLock, hasCode } from './fsx.ts';
import { isWho, vendorOf, whos, spec } from './roster.ts';
import { selection } from './workers.ts';
import { checkChoice } from './policy.ts';
import { readSettings } from './settings.ts';
import { loadProject, worktreePath } from './project.ts';
import { git, addWorktree, removeWorktree, setup } from './worktree.ts';
import { stamp } from './ids.ts';
import { join } from 'node:path';
import { paths, safeName } from './paths.ts';
import type { Effort, Who } from './roster.ts';

// 项目群聊（docs/design-team.md 第 16 节）。一个群属于一个项目，群里有主人、负责人（群主）和 1–6 位选手。
// 一个群共用一份工作副本（分支 xa/chat-<群号>），同一时间只让一位选手动手，其余排队；想并行就多开几个群。
// 选手在群里的每一轮都是它在这个群里那件活（Job，带 chat）的一轮，靠续接对话接着干（同 team-engine 的叫醒）。

// 只读成员：派活时就是只读隔离（Job.mode = read-only），在隔离层面改不了文件。
export type ChatMember = { who: Who; effort: Effort; fast?: true; readOnly?: true; job?: string };
export type Chat = {
  id: string; project: string; repo: string; title: string;
  base: string;                       // 开群时的起点提交
  branch: string; worktree: string;   // 群共用的分支和副本（平台建、平台删，选手的活不拥有它）
  members: ChatMember[];
  hopLimit: number;                   // 选手之间连续交接最多几次（中间没有主人或负责人说话），到了就停下等负责人；缺省 4
  state: 'open' | 'closed';
  created: string; closed?: string;
  pid?: number;                       // 推进这个群的后台进程（隔离外），没活干就退出
  busy?: { who: Who; job: string; message: number; since: string };  // 现在谁在动手、因为哪条消息
  queue: { who: Who; message: number; hop: number }[];                // 排队等动手的
  behind?: string;                    // 群副本落后主线、平台又不能自动同步时，已经在群里说过的那个主线提交（同一个提交只说一次）
  network?: true;
};
// 谁说的：主人、负责人、平台，或某位选手（Who）。
export type ChatAuthor = 'owner' | 'lead' | 'platform' | Who;
// @ 的对象：负责人、主人、所有选手，或某位选手。
export type Mention = 'lead' | 'owner' | 'all' | Who;
// kind：say 说话；work 选手开始干一轮（界面画成工作卡，进度从 job 读）；report 选手这一轮的汇报；event 平台事件（居中分隔行）。
export type ChatMessage = {
  id: number; at: string; from: ChatAuthor; kind: 'say' | 'work' | 'report' | 'event';
  text: string; mentions: Mention[];
  job?: string; turn?: number;        // work、report：哪件活的第几轮
  hop?: number;                       // 选手交接链上的第几跳（主人、负责人说话时归零）
  handled?: string;                   // 给负责人的话，负责人处理后记上时间
};

export const CHAT_TEXT_MAX = 2000;    // 主人、负责人一句话最多 2000 字
export const REPORT_MAX = 12_000;     // 选手一轮汇报进群最多这么多字，多的截掉并注明
export const HOP_LIMIT = 4;
export const MEMBERS_MAX = 6;

// @ 的写法在 chat-handles.ts（从选手名单表派生，不引 node 模块，界面也用）。
import { ALL_HANDLE, HANDLES, LEAD_HANDLE, OWNER_HANDLE } from './chat-handles.ts';
export { ALL_HANDLE, HANDLES, LEAD_HANDLE, OWNER_HANDLE };

export const chatsDir = () => join(paths().home, 'chats');
export const chatDir = (id: string) => join(chatsDir(), safeName(id));

const chatFile = (id: string) => join(chatDir(id), 'chat.json');
const messagesFile = (id: string) => join(chatDir(id), 'messages.jsonl');

// 全角 @ 和英文字母同样识别；英文短名字必须完整，邮件地址和更长的名字不算。
export function parseMentions(text: string, members: Who[]): Mention[] {
  const handles = new Map<string, Mention>([
    [LEAD_HANDLE, 'lead'], [OWNER_HANDLE, 'owner'], [ALL_HANDLE, 'all'],
    ...members.map(who => [HANDLES[who].toLowerCase(), who] as [string, Mention]),
  ]);
  const out: Mention[] = [];
  const names = [...handles.keys()].sort((a, b) => b.length - a.length).join('|');
  const pattern = new RegExp(`(?<![a-z0-9_])@(${names})(?![a-z0-9_-])`, 'giu');
  for (const match of text.normalize('NFKC').matchAll(pattern)) {
    const who = handles.get(match[1].toLowerCase());
    if (who && !out.includes(who)) out.push(who);
  }
  return out;
}
export async function readChat(id: string): Promise<Chat> {
  try { return await readJson<Chat>(chatFile(id)); }
  catch (e) {
    if (hasCode(e, 'ENOENT')) throw Object.assign(new Error(`找不到群聊 ${id}。请先运行 xagents chat list。`), { code: 'ENOENT' });
    throw e;
  }
}
export async function updateChat(id: string, fn: (chat: Chat) => void | Promise<void>): Promise<Chat> {
  return withLock(chatDir(id), async () => {
    const chat = await readChat(id);
    await fn(chat);
    await writeJson(chatFile(id), chat);
    return chat;
  });
}
function validChat(chat: Chat, id: string): boolean {
  return !!chat && chat.id === id && ['open', 'closed'].includes(chat.state)
    && ['project', 'repo', 'title', 'base', 'branch', 'worktree', 'created'].every(k => typeof chat[k as keyof Chat] === 'string')
    && Number.isInteger(chat.hopLimit) && chat.hopLimit > 0
    && Array.isArray(chat.members) && chat.members.length > 0 && chat.members.length <= MEMBERS_MAX
    && chat.members.every(m => m && isWho(m.who) && ['medium', 'high', 'xhigh'].includes(m.effort) && (m.job === undefined || typeof m.job === 'string'))
    && Array.isArray(chat.queue) && chat.queue.every(q => q && isWho(q.who) && Number.isInteger(q.message) && Number.isInteger(q.hop))
    && (!chat.busy || isWho(chat.busy.who));
}
export async function listChats(): Promise<Chat[]> {
  const names = await readdir(chatsDir()).catch(e => { if (hasCode(e, 'ENOENT') || hasCode(e, 'ENOTDIR')) return []; throw e; });
  const out: Chat[] = [];
  for (const name of names) {
    try { safeName(name); } catch { continue; }
    try {
      const chat = await readChat(name);
      if (validChat(chat, name)) out.push(chat);
    } catch (e) {
      if (!hasCode(e, 'ENOENT') && !hasCode(e, 'ENOTDIR') && !hasCode(e, 'EISDIR') && !(e instanceof SyntaxError)) throw e;
    }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}
export async function readMessages(id: string): Promise<ChatMessage[]> {
  await readChat(id);
  const out: ChatMessage[] = [];
  for (const line of (await readOptional(messagesFile(id))).split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as ChatMessage;
      if (m && Number.isSafeInteger(m.id) && m.id > 0 && typeof m.at === 'string' && typeof m.text === 'string'
        && (['owner', 'lead', 'platform'].includes(m.from) || isWho(m.from))
        && ['say', 'work', 'report', 'event'].includes(m.kind) && Array.isArray(m.mentions)
        && m.mentions.every(who => ['owner', 'lead', 'all'].includes(who) || isWho(who))) out.push(m);
    } catch { /* 半行或坏行跳过，其余消息照常读。 */ }
  }
  return out;
}
const saveMessages = (id: string, list: ChatMessage[]) => writeAtomic(messagesFile(id), list.map(m => JSON.stringify(m)).join('\n') + '\n');
function message(chat: Chat, list: ChatMessage[], input: Omit<ChatMessage, 'id' | 'at' | 'mentions'> & { mentions?: Mention[]; at?: string }): ChatMessage {
  return { ...input, id: list.reduce((max, m) => Math.max(max, m.id), 0) + 1,
    at: input.at ?? new Date().toISOString(), mentions: input.mentions ?? parseMentions(input.text, chat.members.map(m => m.who)) };
}
export async function appendChatMessage(id: string, input: Omit<ChatMessage, 'id' | 'at' | 'mentions'> & { mentions?: Mention[]; at?: string }): Promise<ChatMessage> {
  return withLock(chatDir(id), async () => {
    const chat = await readChat(id), list = await readMessages(id), m = message(chat, list, input);
    await saveMessages(id, [...list, m]);
    return m;
  });
}
export type CreateChatOptions = { project: string; title?: string; members: string[]; hopLimit?: number };
// 共用的入口校验：CLI、桥和核心都按同一份成员语法判断。
export function chatMember(value: unknown): ChatMember {
  if (typeof value !== 'string' || value.length > 100) throw new Error('成员写法是 选手:强度[:fast][:ro]。');
  const readOnly = value.endsWith(':ro');
  const { who, effort, fast } = selection(readOnly ? value.slice(0, -3) : value);
  if (vendorOf(who) === 'cursor') throw new Error('Cursor 还没有实测续接，暂时不能加入群聊。');
  return { who, effort, ...(fast ? { fast } : {}), ...(readOnly ? { readOnly: true } : {}) };
}
export function cleanChatText(text: unknown): string {
  if (typeof text !== 'string') throw new Error('群消息要写成文字。');
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) throw new Error('群消息不能是空的。');
  if ([...clean].length > CHAT_TEXT_MAX) throw new Error(`群消息最多 ${CHAT_TEXT_MAX} 字。`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(clean)) throw new Error('群消息里不能有控制字符（换行可以）。');
  return clean;
}
export function checkChatOptions(options: CreateChatOptions): ChatMember[] {
  if (!options || typeof options !== 'object' || typeof options.project !== 'string' || options.project.length > 64) throw new Error('项目名无效。');
  safeName(options.project);
  if (options.title !== undefined && (typeof options.title !== 'string' || !options.title.trim() || [...options.title].length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(options.title))) throw new Error('群名请写 1–100 字，不能含控制字符。');
  if (!Array.isArray(options.members) || !options.members.length || options.members.length > MEMBERS_MAX) throw new Error(`群成员要有 1–${MEMBERS_MAX} 位。`);
  const members = options.members.map(chatMember);
  if (new Set(members.map(m => m.who)).size !== members.length) throw new Error('群成员不能重复。');
  if (options.hopLimit !== undefined && (!Number.isSafeInteger(options.hopLimit) || options.hopLimit < 1)) throw new Error('连续交接次数必须是正整数。');
  return members;
}
export async function createChat(options: CreateChatOptions): Promise<Chat> {
  const settings = await readSettings();
  const members = checkChatOptions(options);
  const project = await loadProject(options.project).catch(e => {
    if (hasCode(e, 'ENOENT')) throw new Error(`没有登记叫 ${options.project} 的项目，请先运行 xagents project add。`);
    throw e;
  });
  if (settings.archivedProjects.includes(project.name)) throw new Error('这个项目已归档，请先取消归档再开群。');
  for (const member of members) checkChoice(settings.workers, member);
  const base = (await git(project.repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])).trim();
  const suffix = project.name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const prefix = `${stamp()}-${suffix}`;
  await mkdir(chatsDir(), { recursive: true });
  let id: string;
  for (let n = 1; ; n++) {
    id = prefix + (n === 1 ? '' : `-${n}`);
    try { await mkdir(chatDir(id)); break; } catch (e) { if (!hasCode(e, 'EEXIST')) throw e; }
  }
  let chat: Chat | undefined, added = false;
  try {
    chat = { id, project: project.name, repo: project.repo, title: options.title?.trim() ?? project.label ?? project.name,
      base, branch: `xa/chat-${id}`, worktree: await worktreePath(project, `chat-${id}`), members,
      hopLimit: options.hopLimit ?? HOP_LIMIT, state: 'open', created: new Date().toISOString(), queue: [],
      ...(settings.networkAllowed ? { network: true } : {}) };
    await addWorktree(chat); added = true;
    await setup({ worktree: chat.worktree }, project.setup, join(chatDir(id), 'setup.log'));
    await withLock(chatDir(id), () => writeJson(chatFile(id), chat));
    await appendChatMessage(id, { from: 'platform', kind: 'event', text: '开群了。' });
    return chat;
  } catch (error) {
    if (added && chat) {
      try { await removeWorktree(chat); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `开群失败，副本清理也失败，请检查 ${chat.worktree}。`); }
    }
    await rm(chatDir(id), { recursive: true, force: true });
    throw error;
  }
}
// 群名：去掉首尾空白后 1–100 字，不能含控制字符（和开群时同一条规矩）。
export function cleanChatTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(title)) throw new Error('群名请写 1–100 字，不能含控制字符。');
  return title.trim();
}
// 改群名（主人在协作页的会话菜单里改，负责人也可以用命令改）。只改名字，不动成员、副本和消息。
export async function renameChat(id: string, title: string): Promise<Chat> {
  const clean = cleanChatTitle(title);
  return updateChat(id, chat => { chat.title = clean; });
}
export async function sayInChat(id: string, text: string, by: 'owner' | 'lead'): Promise<ChatMessage> {
  if (by !== 'owner' && by !== 'lead') throw new Error('说话的人只能是主人或负责人。');
  const clean = cleanChatText(text);
  const result = await withLock(chatDir(id), async () => {
    const chat = await readChat(id);
    if (chat.state !== 'open') throw new Error('这个群已经收起，不能再说话。');
    const list = await readMessages(id), m = message(chat, list, { from: by, kind: 'say', text: clean, hop: 0 });
    if (by === 'lead') for (const pending of pendingForLead(list)) pending.handled = m.at;
    await saveMessages(id, [...list, m]);
    return m;
  });
  // 消息已落盘；骨架阶段未实现叫醒不能影响说话。其他运行错误照常报出，便于处理。
  try { await (await import('./chat-engine.ts')).wakeChat(id); }
  catch (e) { if (!(e instanceof Error) || !e.message.startsWith('还没实现')) throw e; }
  return result;
}
export function pendingForLead(messages: ChatMessage[]): ChatMessage[] {
  const lastLead = messages.findLastIndex(m => m.from === 'lead' && m.kind === 'say');
  return messages.filter((m, i) => i > lastLead && !m.handled && m.from !== 'lead' && (
    m.mentions.includes('lead') || m.from === 'owner' && m.kind === 'say' && !m.mentions.some(who => who === 'all' || isWho(who))
  ));
}
