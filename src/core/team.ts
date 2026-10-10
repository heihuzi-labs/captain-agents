import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, safeName } from './paths.ts';
import { readJson, writeJson, withLock, hasCode, readOptional, writeAtomic } from './fsx.ts';
import type { Usage } from './job.ts';
import { cleanComment } from './comments.ts';

// 小队（协作模式）的登记文件。设计见 docs/design-team.md；第一版只有“搭档审改”（pair）：一位写、一位审，按轮往返。
// 每一轮的报告就是给对方的信；平台在隔离外按轮转交、按轮叫醒（续接对话，见 workers.ts 的 resumeCommand）。

export type TeamMode = 'pair';
export type TeamRole = 'writer' | 'reviewer';
// running：平台在推进（有人在干活，或正要叫醒下一位）。
// lead：停下来等负责人（原因见 reason）。ended：负责人收场了（team stop），之后照常验收、采用、打分、清理。
export type TeamState = 'running' | 'lead' | 'ended';
// passed：审查说通过；disagree：轮数用完还有“必须改”没谈拢；unclear：审查报告里找不到结论；
// brake：时长到了或写手连续两轮没有新改动；blocked：叫醒前被拦下（额度、主人设置、自检、同时运行上限、登录）；
// failed：某一轮选手出错、被停或失联；lost：推进小队的后台进程不在了。
export type TeamReason = 'passed' | 'disagree' | 'unclear' | 'brake' | 'blocked' | 'failed' | 'lost';
export type TeamPhase = 'write' | 'review';
export type Team = {
  id: string; mode: TeamMode; project: string; repo: string; base: string;
  kind: string; title: string; summary: string;
  // 题目原文（不含共同规则），平台按轮拼提示词时用；派活时的快照，之后改题目文件不影响。
  task: string;
  writer: { who: string; effort: string; fast?: true; job?: string };
  reviewer: { who: string; effort: string; fast?: true; job?: string };
  // round 从 1 开始：第 n 轮 = 写手第 n 次干活 + 审查第 n 次审。phase 是这一轮现在走到哪一半。
  round: number; phase: TeamPhase; maxRounds: number; maxMinutes: number;
  state: TeamState; reason?: TeamReason; note?: string;
  created: string; ended?: string;
  // 推进小队的后台进程（隔离外）。
  pid?: number;
  // 派活时带的真实环境检查说明，转交给写手的任务（见 dispatch 的 --real）。
  real?: boolean | string;
  network?: true;
};
// 审查意见里的一条。level 来自报告里每条开头的 [必须改] [建议] [疑问]。
// reply 来自写手下一轮报告的“逐条回复”：fixed 已改、declined 不改（理由在 replyText）、null 还没回。
export type ReviewItem = { n: number; level: 'must' | 'suggest' | 'question'; text: string; reply: 'fixed' | 'declined' | null; replyText?: string };
export type Verdict = 'pass' | 'changes' | 'unclear';
// 频道里的一条。from：platform 是平台事件（第 n 轮开始、叫醒、刹车……），界面画成居中的分隔行。
// kind：report 写手的一轮报告；review 审查的一轮报告（带 verdict、items）；say 负责人或主人说的话；event 平台事件。
export type ChannelMessage = {
  id: number; at: string; round: number;
  from: TeamRole | 'lead' | 'owner' | 'platform';
  kind: 'report' | 'review' | 'say' | 'event';
  text: string;
  verdict?: Verdict; items?: ReviewItem[];
  // 主人的话：负责人看到并处理后记上时间（和任务留言一样，见 comments.ts）。
  handled?: string;
};
// 每位队员一轮的记录，叫醒下一轮前由平台从任务记录里抄下来（见 Job.rounds）。
// verify / realCheck / decision：负责人对这一轮的验收和拍板。叫醒下一轮时从任务记录挪到这里（wake.ts 的 resumeMember），
// 任务记录上只留“当前这一轮”的结果。
export type RoundRecord = { n: number; started: string; ended: string; seconds: number; exit: number | null; usage?: Usage; state: string;
  verify?: unknown; verifySkip?: import('./job.ts').Job['verifySkip']; realCheck?: import('./job.ts').Job['realCheck']; decision?: import('./job.ts').Job['decision'] };

export const TEXT_MAX = 12_000; // 转交给对方的一份报告最多这么多字，多的截掉并注明。
export const SAY_MAX = 500;     // 负责人、主人说一句最多 500 字（和留言一样）。

export const teamsDir = () => join(paths().home, 'teams');
export const teamDir = (id: string) => join(teamsDir(), safeName(id));
const teamFile = (id: string) => join(teamDir(id), 'team.json');
const channelFile = (id: string) => join(teamDir(id), 'channel.jsonl');

export const readTeam = (id: string): Promise<Team> => readJson(teamFile(id));
export async function createTeam(team: Team) {
  await withLock(teamDir(team.id), async () => {
    try { await readTeam(team.id); throw new Error(`小队 ${team.id} 已存在，请重新开队。`); }
    catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
    await writeJson(teamFile(team.id), team);
  });
}
// 改小队记录一律在锁里“读 → 改 → 写”。找不到时给中文错误。
export async function updateTeam(id: string, fn: (team: Team) => void | Promise<void>): Promise<Team> {
  try {
    return await withLock(teamDir(id), async () => {
      const team = await readTeam(id);
      await fn(team);
      await writeJson(teamFile(id), team);
      return team;
    });
  } catch (e) {
    if (hasCode(e, 'ENOENT')) throw new Error(`找不到小队 ${id}。请先运行 xagents team status。`);
    throw e;
  }
}
export async function listTeams(): Promise<Team[]> {
  const names = await readdir(teamsDir()).catch(e => { if (hasCode(e, 'ENOENT')) return [] as string[]; throw e; });
  const teams: Team[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const t = await readTeam(name);
      if (t && t.id === name && t.mode === 'pair' && typeof t.created === 'string') teams.push(t);
    } catch (e) { if (!hasCode(e, 'ENOENT') && !(e instanceof SyntaxError) && !hasCode(e, 'ENOTDIR')) throw e; }
  }
  return teams.sort((a, b) => b.created.localeCompare(a.created));
}

// 频道只追加，在小队的锁里写（整份重写成新文件再改名，坏行跳过）。
export async function readChannel(id: string): Promise<ChannelMessage[]> {
  const out: ChannelMessage[] = [];
  for (const line of (await readOptional(channelFile(id))).split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m && typeof m.id === 'number' && typeof m.text === 'string') out.push(m); }
    catch { /* 坏行跳过 */ }
  }
  return out;
}
export async function appendMessage(id: string, message: Omit<ChannelMessage, 'id' | 'at'> & { at?: string }): Promise<ChannelMessage> {
  return withLock(teamDir(id), async () => {
    const list = await readChannel(id);
    const m: ChannelMessage = { ...message, id: (list.at(-1)?.id ?? 0) + 1, at: message.at ?? new Date().toISOString() };
    await writeAtomic(channelFile(id), [...list, m].map(x => JSON.stringify(x)).join('\n') + '\n');
    return m;
  });
}
// 改已有的消息（比如给主人的话记上已处理），同样在锁里整份重写。
export async function editChannel(id: string, fn: (list: ChannelMessage[]) => void) {
  return withLock(teamDir(id), async () => {
    const list = await readChannel(id);
    fn(list);
    await writeAtomic(channelFile(id), list.length ? list.map(x => JSON.stringify(x)).join('\n') + '\n' : '');
    return list;
  });
}

// 负责人或主人在频道里说一句（1–500 字，规则同留言）；下一次叫醒时带给双方。负责人说话时，把主人此前的话记为已处理。
export async function sayInTeam(id: string, text: string, by: 'lead' | 'owner'): Promise<ChannelMessage> {
  if (by !== 'lead' && by !== 'owner') throw new Error('说话的人只能是主人或负责人。');
  const clean = cleanComment(text);
  const team = await readTeam(id).catch(e => { if (hasCode(e, 'ENOENT')) throw new Error(`找不到小队 ${id}。请先运行 xagents team status。`); throw e; });
  if (team.state === 'ended') throw new Error('这支小队已经收场了，说的话不会再转给队员。');
  return withLock(teamDir(id), async () => {
    const list = await readChannel(id), at = new Date().toISOString();
    if (by === 'lead') for (const m of list) if (m.from === 'owner') m.handled ??= at;
    const m: ChannelMessage = { id: (list.at(-1)?.id ?? 0) + 1, at, round: team.round, from: by, kind: 'say', text: clean };
    await writeAtomic(channelFile(id), [...list, m].map(x => JSON.stringify(x)).join('\n') + '\n');
    return m;
  });
}
// 主人在频道里说的、负责人还没处理的话。
export const pendingOwnerSays = (list: ChannelMessage[]) => list.filter(m => m.from === 'owner' && m.kind === 'say' && !m.handled);

// 小队 running 时，对它的队员 adopt、drop、verify、clean 一律拦下：先等小队停下或收场。
// job.team 由派活时带上（见 dispatch.ts 的 RunOptions.team）。
export async function guardTeamJob(job: { team?: { id: string; role: 'writer' | 'reviewer' } }) {
  if (!job.team) return;
  const team = await readTeam(job.team.id).catch(e => { if (hasCode(e, 'ENOENT')) return undefined; throw e; });
  if (team && team.state === 'running') {
    throw new Error(`这件活所在的小队还在进行，先 xagents wait ${team.id} 或 xagents team stop ${team.id}。`);
  }
}
// 小队里两件活的任务号（写手、审查）。还没派的那一件可能没有，过滤掉。
export const teamJobIds = (team: Team) => [team.writer.job, team.reviewer.job].filter((id): id is string => typeof id === 'string' && id.length > 0);

// 一份报告放进频道或提示词前先按字数封顶（按码点，不是按字节）。
export function clipText(text: string, max = TEXT_MAX): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}\n\n（原文超过 ${max} 字，这里截断了。）`;
}

const ITEM_LEVEL = { '必须改': 'must', '建议': 'suggest', '疑问': 'question' } as const;
const ITEM_RE = /^(\d+)\s*[.、，,]\s*\[(必须改|建议|疑问)\]\s*(.*)$/;
const REPLY_RE = /^(\d+)\s*[.、，,]\s*(已改|不改)\s*[:：]?\s*(.*)$/;

function normLine(line: string): string {
  return line.replace(/\u3000/g, ' ').replace(/[．。]/g, '.').replace(/［/g, '[').replace(/］/g, ']').replace(/【/g, '[').replace(/】/g, ']');
}
function headingOf(line: string): string | null {
  const match = /^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/.exec(line.replace(/\u3000/g, ' '));
  if (!match) return null;
  return match[1].replace(/[:：]\s*$/u, '').trim();
}
function clipItem(text: string): string {
  const chars = [...text.trim()];
  return chars.length > 2000 ? chars.slice(0, 2000).join('') : chars.join('');
}
function verdictOf(line: string): Verdict {
  // “不通过”里含“通过”，要先认否定；“要改”同样优先于“通过”。
  if (line.includes('要改') || line.includes('不通过')) return 'changes';
  if (line.includes('通过')) return 'pass';
  return 'unclear';
}

// ===== 以下由引擎那件活实现（docs/design-team.md 第 14 节“分工”）。签名就是约定，不改签名；要改先回报负责人。 =====

export type TeamStartOptions = {
  writer: string; reviewer: string;            // 选手:强度[:fast]，写法同 --who
  summary: string; project?: string; base?: string; kind?: string; title?: string;
  rounds?: number; minutes?: number;           // 缺省 3 轮、60 分钟；范围 1–5 轮、10–240 分钟
  force?: boolean; dirtyOk?: boolean; real?: boolean | string;
};
// 开队：检查（不同模型、都支持续接、主人设置、额度……）→ 登记小队 → 派写手第 1 轮 → 启动推进小队的后台进程。返回登记好的小队。
export async function startTeam(file: string, options: TeamStartOptions): Promise<Team> {
  return (await import('./team-engine.ts')).startTeam(file, options);
}
// 负责人让停下的小队再走一轮（写手接着改），note 是负责人给双方的话（可选）。只能用在 state 为 lead 的小队上。
export async function continueTeam(id: string, note?: string): Promise<Team> {
  return (await import('./team-engine.ts')).continueTeam(id, note);
}
// 收场：停下在跑的那一位和后台进程，小队记为 ended。
export async function stopTeam(id: string): Promise<Team> {
  return (await import('./team-engine.ts')).stopTeam(id);
}
// 状态修正：小队 running 但后台进程不在了 → lead / lost。和 job.ts 的 reconcile 一样只在需要时写。
export async function reconcileTeam(team: Team): Promise<Team> {
  return (await import('./team-engine.ts')).reconcileTeam(team);
}
// 从报告里读审查结论和意见。纯函数，不读写文件。
export function parseReview(report: string): { verdict: Verdict; items: ReviewItem[] } {
  const lines = report.replace(/\r\n?/g, '\n').split('\n');
  let verdict: Verdict = 'unclear', section: 'none' | 'verdict' | 'items' = 'none', sawVerdict = false;
  const items: ReviewItem[] = [];
  let current: ReviewItem | null = null;
  const push = () => { if (current) items.push(current); current = null; };
  for (const raw of lines) {
    const heading = headingOf(raw);
    if (heading !== null) {
      push();
      section = heading === '结论' ? 'verdict' : heading === '意见' ? 'items' : 'none';
      continue;
    }
    const line = normLine(raw);
    if (section === 'verdict' && !sawVerdict && line.trim()) {
      sawVerdict = true;
      verdict = verdictOf(line.trim());
      continue;
    }
    if (section !== 'items') continue;
    const matched = ITEM_RE.exec(line.trim());
    if (matched) {
      push();
      current = { n: Number(matched[1]), level: ITEM_LEVEL[matched[2] as keyof typeof ITEM_LEVEL], text: clipItem(matched[3]), reply: null };
      continue;
    }
    if (current && line.trim()) current.text = clipItem(`${current.text}\n${line.trim()}`);
  }
  push();
  const seen = new Set<number>();
  return { verdict, items: items.filter(item => seen.has(item.n) ? false : (seen.add(item.n), true)) };
}
// 从写手报告的“逐条回复”里读每条是已改还是不改。纯函数，不读写文件。
export function parseReplies(report: string): { n: number; reply: 'fixed' | 'declined'; text: string }[] {
  const lines = report.replace(/\r\n?/g, '\n').split('\n');
  let inSection = false, seen = false;
  const out: { n: number; reply: 'fixed' | 'declined'; text: string }[] = [];
  const index = new Map<number, number>();
  for (const raw of lines) {
    const heading = headingOf(raw);
    if (heading !== null) { inSection = heading === '逐条回复'; if (inSection) seen = true; continue; }
    if (!inSection) continue;
    const matched = REPLY_RE.exec(normLine(raw).trim());
    if (!matched) continue;
    const row = { n: Number(matched[1]), reply: (matched[2] === '已改' ? 'fixed' : 'declined') as 'fixed' | 'declined', text: clipItem(matched[3]) };
    const at = index.get(row.n);
    if (at === undefined) { index.set(row.n, out.length); out.push(row); }
    else out[at] = row;
  }
  return seen ? out : [];
}
