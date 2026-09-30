import type { View, ViewJob } from '../../../src/core/view-types.ts';
import type { Entry } from './board.ts';
import { fmtTime, STATE } from './board.ts';

// 没有项目名的老记录归到这一组。
export const NO_PROJECT = '未归类';
export const projectOf = (job: Pick<ViewJob, 'project'>) => job.project || NO_PROJECT;
export const entryProject = (e: Entry) => projectOf(e.members[0]);
// 项目的显示名：核心的项目名单里有就用它，没有（老记录）按任务里的名字。
export const projectLabel = (view: Pick<View, 'projects'>, name: string) => view.projects.find(p => p.name === name)?.label ?? name;

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
// 相差的整天数（按本地日历算，不是 24 小时的倍数）。
const daysAgo = (ms: number, now: number) => Math.round((startOfDay(now) - startOfDay(ms)) / 86400e3);
export const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const WEEK = '日一二三四五六';
// 组标题：今天 / 昨天 / 9 月 29 日（星期一）；不是今年的写上年份。
export function dayLabel(iso: string, now = Date.now()) {
  const ms = Date.parse(iso), age = daysAgo(ms, now);
  if (age === 0) return '今天';
  if (age === 1) return '昨天';
  const d = new Date(ms), year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()} 年 `;
  return `${year}${d.getMonth() + 1} 月 ${d.getDate()} 日（星期${WEEK[d.getDay()]}）`;
}
// 左栏“最近一次”：今天 14:30 / 昨天 / 09-29。
export function recentLabel(iso: string, now = Date.now()) {
  const age = daysAgo(Date.parse(iso), now);
  if (age === 0) return '今天 ' + fmtTime(iso);
  if (age === 1) return '昨天';
  return fmtTime(iso, true).slice(0, 5);
}

export type ProjectRow = { name: string; label: string; count: number; last: string | null };
// 左栏的项目：有历史的按最近一次从近到远，没有历史的（登记了但还没做完过活）排在后面。
export function projectRows(view: Pick<View, 'projects'>, history: Entry[]): ProjectRow[] {
  const rows = new Map<string, ProjectRow>(view.projects.map(p => [p.name, { name: p.name, label: p.label, count: 0, last: null }]));
  for (const e of history) {
    const name = entryProject(e), row = rows.get(name) ?? { name, label: projectLabel(view, name), count: 0, last: null };
    row.count++;
    if (!row.last || Date.parse(e.started) > Date.parse(row.last)) row.last = e.started;
    rows.set(name, row);
  }
  return [...rows.values()].sort((a, b) => (b.last ? Date.parse(b.last) : -Infinity) - (a.last ? Date.parse(a.last) : -Infinity) || a.name.localeCompare(b.name, 'zh-CN'));
}
// 按天分组，天和天之间、每天里面都从新到旧。
export function dayGroups(history: Entry[], now = Date.now()) {
  const groups: { key: string; label: string; entries: Entry[] }[] = [];
  for (const e of [...history].sort((a, b) => Date.parse(b.started) - Date.parse(a.started))) {
    const key = dayKey(e.started), last = groups.at(-1);
    if (last?.key === key) last.entries.push(e);
    else groups.push({ key, label: dayLabel(e.started, now), entries: [e] });
  }
  return groups;
}

// 已完成列按项目聚合：入参从新到旧，项目按各自最新的一件排（先出现的先排），组内保持从新到旧。
export function projectGroups(entries: Entry[]) {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) { const name = entryProject(e); groups.set(name, [...groups.get(name) ?? [], e]); }
  return [...groups].map(([name, list]) => ({ name, entries: list }));
}

// 一件活（一批算一件）的结果。正常的不写、只标例外（每行挂“用了这份”是废话）：
// 采用了返回 null（用了哪家靠图标：没采用的那家调淡）；其余：没用 / 都没用 / 出错 / 失联 / 负责人在挑 / 已停。
export type Outcome = { text: string; tone: 'ok' | 'bad' | 'neutral'; dropped?: true };
export function outcomeOf(e: Entry): Outcome | null {
  const ms = e.members, adopted = ms.filter(m => m.decision?.kind === 'adopt');
  if (adopted.length) return null;
  const problem = ms.find(m => !m.decision && (m.state === 'lost' || m.state === 'failed'));
  if (problem) return { text: STATE[problem.state], tone: problem.state === 'failed' ? 'bad' : 'neutral' };
  if (ms.some(m => !m.decision && m.state === 'done')) return { text: '负责人在挑', tone: 'neutral' };
  if (ms.every(m => m.state === 'stopped')) return { text: STATE.stopped, tone: 'neutral' };
  return { text: ms.length > 1 ? '都没用' : '没用', tone: 'neutral', dropped: true };
}
// 一批里采用了别家、这家没用上：图标调淡。
export const dimmed = (e: Entry, m: ViewJob) => e.members.some(x => x.decision?.kind === 'adopt') && m.decision?.kind !== 'adopt';

// 选中的项目记在本机；读写失败（比如浏览器禁用了存储）不影响使用。空串表示“全部”。
const PROJECT_KEY = 'xa.history-project';
export const readHistoryProject = (): string => { try { return window.localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } };
export const rememberHistoryProject = (name: string) => { try { window.localStorage.setItem(PROJECT_KEY, name); } catch { /* 记不住就算了 */ } };
// 看板已完成列里展开着的项目（默认都折起；本机记住点开了哪些；读写失败就当全都折起）。
// 以前记的是“折起来的”（xa.done-collapsed），默认改了以后那份没用了，读的时候顺手删掉。
const EXPANDED_KEY = 'xa.done-expanded';
export const readExpanded = (): Set<string> => {
  try {
    window.localStorage.removeItem('xa.done-collapsed');
    const v: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
};
export const rememberExpanded = (names: Set<string>) => { try { window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...names])); } catch { /* 记不住就算了 */ } };
