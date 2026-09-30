import type { View } from '../../../src/core/view-types.ts';
import type { DashboardSlice, Range } from '../../../src/core/dashboard.ts';
import { compactCount } from '../../../src/core/text.ts';

// 时间范围三选一。和核心 dashboard.ts 的 ranges、rangeLabel 是同一组（核心那份以后会连带读额度的模块，窗口里不直接引；test/desktop.test.ts 对过）。
export const RANGE_CHOICES: readonly { id: Range; label: string }[] = [
  { id: 'today', label: '今天' }, { id: '7d', label: '近 7 天' }, { id: '30d', label: '近 30 天' },
];
const RANGE_KEY = 'xa.dash-range', PROJECT_KEY = 'xa.dash-project';
export const readRange = (): Range => {
  try { const v = window.localStorage.getItem(RANGE_KEY); return RANGE_CHOICES.some(r => r.id === v) ? v as Range : '7d'; } catch { return '7d'; }
};
export const rememberRange = (r: Range) => { try { window.localStorage.setItem(RANGE_KEY, r); } catch { /* 记不住就算了 */ } };
export const readDashProject = () => { try { return window.localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } };
export const rememberDashProject = (p: string) => { try { window.localStorage.setItem(PROJECT_KEY, p); } catch { /* 记不住就算了 */ } };

// 按“范围 + 项目”取核心算好的那一份；找不到（比如记着的项目已经没有了）就退回全部项目。
export function pickSlice(view: View, range: Range, project: string): DashboardSlice | undefined {
  const all = view.dashboard ?? [];
  return all.find(s => s.range === range && s.project === project) ?? all.find(s => s.range === range && s.project === '');
}
// 项目筛选里列哪些：这个范围里有活的项目（按件数从多到少）；记着的项目这段时间没活也照样列出来，免得选中的那个突然消失。
export function projectChoices(view: View, range: Range, current: string): string[] {
  const names = (view.dashboard ?? []).filter(s => s.range === range && s.project && s.kpi.jobs > 0)
    .sort((a, b) => b.kpi.jobs - a.kpi.jobs || a.project.localeCompare(b.project, 'zh-CN')).map(s => s.project);
  return current && !names.includes(current) ? [...names, current] : names;
}

export const pct = (r: number | null) => r === null ? '—' : Math.round(r * 100) + '%';
export const score = (s: number | null) => s === null ? '—' : s.toFixed(1);
// 百分点：不到 1 点的写两位小数（一件小活常常只有零点零几），1 点起一位小数。
export const points = (p: number | null) => p === null ? '—' : `${p > 0 && p < 0.005 ? '<0.01' : p < 1 ? p.toFixed(2) : p.toFixed(1)} 点`;
export const tokenText = (n: number) => compactCount(n);
// 日期标签：本地日期 YYYY-MM-DD 写成“9/30”。
export const dayLabel = (day: string) => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };
