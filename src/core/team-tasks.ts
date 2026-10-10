import type { ChannelMessage, Team } from './team.ts';
import { parseReplies } from './team.ts';
import type { TeamTask } from './view-types.ts';

// 小队自己的任务看板：从小队记录和频道算出每张卡在哪一列（规则见 docs/design-team.md 第 15 节）。纯函数，不读写文件。
// 由“任务看板规则”那件活实现，签名就是约定。
const TEXT_KEEP = 120;
const REASON_KEEP = 40;
type OpinionKind = 'must' | 'suggest' | 'question';
type Spot = { column: TeamTask['column']; holder: TeamTask['holder']; note: string };

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}
// 交付卡片的文字就是小队题目。
function titleOf(team: Pick<Team, 'title'>): string {
  return typeof team.title === 'string' ? team.title : '';
}
function isOpinion(level: unknown): level is OpinionKind {
  return level === 'must' || level === 'suggest' || level === 'question';
}
function opinions(message: ChannelMessage): { n: number; kind: OpinionKind; text: string }[] {
  if (!Array.isArray(message.items)) return [];
  const out: { n: number; kind: OpinionKind; text: string }[] = [];
  for (const item of message.items) {
    if (!item || typeof item.n !== 'number' || !Number.isInteger(item.n) || item.n < 1) continue;
    if (!isOpinion(item.level)) continue;
    out.push({ n: item.n, kind: item.level, text: typeof item.text === 'string' ? item.text : '' });
  }
  return out;
}
function reviewsOf(channel: ChannelMessage[]): ChannelMessage[] {
  return channel.filter(message => message.kind === 'review');
}
function lastReview(channel: ChannelMessage[]): ChannelMessage | undefined {
  for (let i = channel.length - 1; i >= 0; i--) if (channel[i].kind === 'review') return channel[i];
  return undefined;
}
function finding(message: ChannelMessage, n: number): { kind: OpinionKind; text: string } | undefined {
  let found: { kind: OpinionKind; text: string } | undefined;
  for (const item of opinions(message)) if (item.n === n) found = item;
  return found;
}
function firstBody(text: string): string | null {
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\u3000/g, ' ');
    if (!line.trim() || /^\s{0,3}#{1,6}\s/.test(line)) continue;
    return line.trim();
  }
  return null;
}
function byRound<T extends { round: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.round - b.round);
}
function deliveryHistory(channel: ChannelMessage[]): TeamTask['history'] {
  const history: TeamTask['history'] = [];
  for (const message of channel) {
    if (message.kind !== 'report' || message.from !== 'writer' || typeof message.text !== 'string') continue;
    const text = firstBody(message.text);
    if (text === null) continue;
    history.push({ round: message.round, from: 'writer', text });
  }
  return byRound(history);
}
function replyHistory(channel: ChannelMessage[], n: number): TeamTask['history'] {
  const history: TeamTask['history'] = [];
  for (const message of channel) {
    if (message.kind === 'review') {
      const item = finding(message, n);
      if (item) history.push({ round: message.round, from: 'reviewer', text: item.text });
      continue;
    }
    if (message.kind !== 'report' || message.from !== 'writer' || typeof message.text !== 'string') continue;
    const row = parseReplies(message.text).find(reply => reply.n === n);
    if (!row) continue;
    history.push({ round: message.round, from: 'writer', text: row.reply === 'fixed' ? `已改：${row.text}` : `不改：${row.text}` });
  }
  return byRound(history);
}
function repliesAfter(channel: ChannelMessage[], review: ChannelMessage): Map<number, { reply: 'fixed' | 'declined'; text: string }> {
  const at = channel.lastIndexOf(review);
  const map = new Map<number, { reply: 'fixed' | 'declined'; text: string }>();
  for (let i = at + 1; i < channel.length; i++) {
    const message = channel[i];
    if (message.kind !== 'report' || message.from !== 'writer' || typeof message.text !== 'string') continue;
    for (const row of parseReplies(message.text)) map.set(row.n, { reply: row.reply, text: row.text });
  }
  return map;
}
// 写手这一轮开工：推进进程在叫醒成功后写“第 N 轮开始”。这一轮的写手报告也算已经开工。审查的“叫醒复核”不算。
function writerBegan(team: Pick<Team, 'state' | 'round' | 'phase'>, channel: ChannelMessage[], review: ChannelMessage): boolean {
  if (team.state !== 'running' || team.phase !== 'write') return false;
  const at = channel.lastIndexOf(review);
  const prefix = `第 ${team.round} 轮开始`;
  for (let i = at + 1; i < channel.length; i++) {
    const message = channel[i];
    if (message.round !== team.round) continue;
    if (message.kind === 'report' && message.from === 'writer') return true;
    if (message.kind === 'event' && message.from === 'platform' && typeof message.text === 'string' && message.text.startsWith(prefix)) return true;
  }
  return false;
}
function stopNote(reason: Team['reason']): string {
  if (reason === 'disagree') return '轮数用完还没谈拢';
  if (reason === 'unclear') return '审查没写结论';
  return '停下了';
}
function deliverySpot(team: Pick<Team, 'state' | 'reason' | 'round' | 'phase'>, channel: ChannelMessage[]): Spot {
  if (team.state === 'running' && team.phase === 'write') {
    return { column: 'doing', holder: 'writer', note: team.round <= 1 ? '在写' : '在改' };
  }
  if (team.state === 'running' && team.phase === 'review') return { column: 'review', holder: 'reviewer', note: '在审' };
  const review = lastReview(channel);
  if (review?.verdict === 'pass') return { column: 'done', holder: null, note: `第 ${review.round} 轮通过` };
  return { column: 'review', holder: null, note: stopNote(team.reason) };
}
function opinionSpot(
  team: Pick<Team, 'state' | 'reason' | 'round' | 'phase'>, channel: ChannelMessage[], n: number, kind: OpinionKind, raised: number,
): Spot {
  const review = lastReview(channel);
  if (review?.verdict === 'pass') return { column: 'done', holder: null, note: kind === 'must' ? '复核通过' : '没要求改' };
  if (!review || !finding(review, n)) return { column: 'done', holder: null, note: '复核通过' };
  const reply = repliesAfter(channel, review).get(n);
  if (reply?.reply === 'fixed') return { column: 'review', holder: 'reviewer', note: '已改，等复核' };
  if (reply?.reply === 'declined') return { column: 'review', holder: 'reviewer', note: `不改：${clip(reply.text, REASON_KEEP)}` };
  if (writerBegan(team, channel, review)) return { column: 'doing', holder: 'writer', note: '在改' };
  return { column: 'todo', holder: team.state === 'running' ? 'writer' : null, note: `第 ${raised} 轮提出` };
}
function updatedOf(history: TeamTask['history'], fallback: number): number {
  return history.length ? history[history.length - 1].round : fallback;
}

export function teamTasks(team: Pick<Team, 'state' | 'reason' | 'round' | 'phase' | 'title'>, channel: ChannelMessage[]): TeamTask[] {
  const history = deliveryHistory(channel);
  const delivery = deliverySpot(team, channel);
  const tasks: TeamTask[] = [{
    n: 0, kind: 'deliver', text: titleOf(team), column: delivery.column, holder: delivery.holder, note: delivery.note,
    round: 1, updated: updatedOf(history, 1), history,
  }];
  const numbers = new Set<number>();
  for (const review of reviewsOf(channel)) for (const item of opinions(review)) numbers.add(item.n);
  for (const n of [...numbers].sort((a, b) => a - b)) {
    let first = 0;
    let latest: { kind: OpinionKind; text: string; round: number } | undefined;
    for (const review of reviewsOf(channel)) {
      const item = finding(review, n);
      if (!item) continue;
      if (!first) first = review.round;
      latest = { ...item, round: review.round };
    }
    if (!latest) continue;
    const rows = replyHistory(channel, n);
    const spot = opinionSpot(team, channel, n, latest.kind, latest.round);
    tasks.push({
      n, kind: latest.kind, text: clip(latest.text, TEXT_KEEP), column: spot.column, holder: spot.holder, note: spot.note,
      round: first, updated: updatedOf(rows, first), history: rows,
    });
  }
  return tasks;
}
