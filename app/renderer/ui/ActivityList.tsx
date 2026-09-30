import type { Activity } from '../../../src/core/job.ts';
import { fmtTime, human } from '../lib/board.ts';

type Sleep = { from: string; to: string };
type Row = { kind: 'act'; at: number; a: Activity } | { kind: 'sleep'; at: number; s: Sleep; resumed: boolean };

// 原始动作只在详情进展使用，React 按纯文字显示。新的在上面。
// 电脑休眠放进时间线它该在的位置，做成一条分隔行，写明醒来后有没有接着干；不再单独排在列表最下面（会被误读成“停在这里了”）。
export function ActivityList({ activity, sleeps = [] }: { activity: Activity[]; sleeps?: Sleep[] }) {
  const recent = activity.slice(-12);
  const since = recent.length ? Date.parse(recent[0].at) : -Infinity;
  const rows: Row[] = [
    ...recent.map(a => ({ kind: 'act' as const, at: Date.parse(a.at), a })),
    ...sleeps.filter(s => Date.parse(s.to) >= since).map(s => ({ kind: 'sleep' as const, at: Date.parse(s.from), s, resumed: activity.some(a => Date.parse(a.at) >= Date.parse(s.to)) })),
  ].sort((x, y) => y.at - x.at || (x.kind === 'sleep' ? 1 : -1));
  return <ul className="human-activities" aria-label="最近进展">{rows.length ? rows.map((row, i) => {
    if (row.kind === 'sleep') return <li key={'s' + i} className="activity-sleep">
      <span>{fmtTime(row.s.from)}–{fmtTime(row.s.to)} 电脑休眠，选手暂停{row.resumed ? '；醒来后已接着干' : '；醒来后还没有新动作'}</span>
    </li>;
    const a = row.a, previous = rows[i - 1];
    const category = human(a);
    const repeated = previous?.kind === 'act' && previous.a.kind !== 'say' && human(previous.a) === category;
    return <li key={i}>
      <time dateTime={a.at}>{fmtTime(a.at)}</time>
      {a.kind === 'say' ? <span className="activity-say">{a.text}</span> : <>
        <span className="activity-category">{repeated ? '' : category}</span>
        <code className="activity-action">{a.text}</code>
      </>}
    </li>;
  }) : <li><span className="activity-empty">刚开始</span></li>}</ul>;
}
