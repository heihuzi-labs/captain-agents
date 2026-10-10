import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import type { View } from '../../src/core/view-types.ts';
import type { DashboardSlice, Range } from '../../src/core/dashboard.ts';
import { Sparkline } from '../../app/renderer/ui/index.ts';
import { fixtureView, fixtureBridge } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const tokens = (fresh: number, cached: number, out: number) => ({ fresh, cached, out });
const days = (n: number) => Array.from({ length: n }, (_, i) => ({ day: `2026-09-${String(30 - n + 1 + i).padStart(2, '0')}`, jobs: i === n - 1 ? 5 : i % 3, tokens: tokens(i * 10_000, 0, i * 1_000) }));
const slice = (range: Range, project = '', extra: Partial<DashboardSlice> = {}): DashboardSlice => ({
  range, project, from: '2026-09-24T00:00:00.000Z', to: '2026-09-30T12:00:00.000Z',
  kpi: { jobs: 12, done: 10, failed: 2, adoptRate: 0.8, avgScore: 4.25, seconds: 3 * 3600 + 120, tokens: tokens(3_120_000, 52_000_000, 450_000), withoutUsage: 3,
    pools: [{ pool: 'Codex · 周额度', points: 3.2, jobs: 6 }, { pool: 'Cursor · 其他模型池', points: null, jobs: 2 }] },
  workers: [
    { who: 'codex', jobs: 8, adoptRate: 0.875, avgScore: 4.4, reworkRate: 0.125, medianSeconds: 480, medianTokens: tokens(160_000, 1_500_000, 22_000), avgPoints: 0.4, withoutUsage: 0 },
    { who: 'grok', jobs: 2, adoptRate: null, avgScore: null, reworkRate: null, medianSeconds: null, medianTokens: null, avgPoints: null, withoutUsage: 2 },
  ],
  daily: range === 'today' ? days(1) : days(range === '7d' ? 7 : 30),
  projects: project ? [] : [{ name: '派活工作台', jobs: 9, seconds: 7200, tokens: tokens(2_000_000, 0, 300_000) }, { name: '<b>画布</b>', jobs: 3, seconds: 1800, tokens: tokens(500_000, 0, 50_000) }],
  ...extra,
});
function dashView(): View {
  const v = fixtureView();
  v.projects = [{ name: '派活工作台', label: '派活工作台', archived: false }, { name: '<b>画布</b>', label: '<b>画布</b>', archived: false }];
  v.dashboard = (['today', '7d', '30d'] as Range[]).flatMap(r => [slice(r), slice(r, '派活工作台', { kpi: { ...slice(r).kpi, jobs: 9, done: 9, failed: 0 } }), slice(r, '<b>画布</b>', { kpi: { ...slice(r).kpi, jobs: 3 } })]);
  return v;
}
async function toStats(v: View) {
  window.xa = fixtureBridge({ getView: vi.fn(async () => v) });
  render(<App />); await screen.findByRole('tablist');
  fireEvent.keyDown(document, { key: '4', metaKey: true });
  await screen.findByRole('heading', { name: '表现', level: 1 });
}

test('筛选一行：默认近 7 天、全部项目；大数一排写件数、采用率、平均分、总用时、token、各池额度（算不出写“—”）', async () => {
  await toStats(dashView());
  expect(screen.getByRole('tab', { name: '近 7 天' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: '全部项目' }).getAttribute('aria-pressed')).toBe('true');
  const tiles = [...document.querySelectorAll('.stat-tile')].map(t => [t.querySelector('.stat-label')!.textContent, t.querySelector('.stat-value')!.textContent]);
  expect(tiles).toEqual([['做完', '10 件'], ['采用率', '80%'], ['平均分', '4.3'], ['总用时', '3 小时 2 分'], ['新读入 token', '312 万']]);
  expect(document.querySelectorAll('.stat-tile')[0].querySelector('.stat-sub')!.textContent).toBe('另有 2 件出错或中断');
  expect(document.querySelectorAll('.stat-tile')[4].querySelector('.stat-sub')!.textContent).toBe('写出 45 万 · 缓存命中 5200 万 · 3 件没有记录');
  expect([...document.querySelectorAll('.pool-item')].map(l => l.textContent)).toEqual(['Codex · 周额度3.2 点', 'Cursor · 其他模型池—']);
  expect(document.querySelectorAll('.stat-tile')).toHaveLength(5);
});
test('各家对比：数字右对齐；没有的写“—”；不到 3 件的行淡显并说明', async () => {
  await toStats(dashView());
  const rows = [...document.querySelector('.dash-table')!.querySelectorAll('tbody tr')];
  expect(rows.map(r => [...r.querySelectorAll('td')].map(c => c.textContent))).toEqual([
    ['8', '88%', '4.4', '13%', '8 分钟', '16 万', '2.2 万', '0.40 点'],
    ['2', '—', '—', '—', '—', '—', '—', '—'],
  ]);
  expect(rows[1].classList.contains('thin')).toBe(true); expect(rows[1].getAttribute('title')).toBe('不到 3 件，还不能下结论');
});
test('每天的走势在“做完”和“新读入 token”两块卡片底部的小趋势线里；选“今天”只有一个点，不画；选择记在本机', async () => {
  await toStats(dashView());
  expect(document.querySelector('.colchart')).toBeNull();
  const sparks = [...document.querySelectorAll('.stat-tile .spark')];
  expect(sparks.map(s => s.getAttribute('aria-label'))).toEqual(['近 7 天每天结束的件数', '近 7 天每天的新读入 token']);
  expect(sparks[0].querySelectorAll('.spark-hit')).toHaveLength(7);
  fireEvent.click(screen.getByRole('tab', { name: '今天' }));
  expect(document.querySelector('.spark')).toBeNull();
  expect(localStorage.getItem('xa.dash-range')).toBe('today');
  fireEvent.click(screen.getByRole('tab', { name: '近 30 天' }));
  expect(document.querySelector('.spark')!.querySelectorAll('.spark-hit')).toHaveLength(30);
});
test('项目筛选：切到一个项目只看它，没有“按项目”；名字当纯文字；记在本机', async () => {
  await toStats(dashView());
  const projectTable = () => [...document.querySelectorAll('.dash-table')].find(t => t.querySelector('thead th')!.textContent === '项目');
  expect([...projectTable()!.querySelectorAll('tbody tr')].map(r => [...r.children].map(c => c.textContent))).toEqual([['派活工作台', '9', '2 小时 0 分', '200 万', '30 万'], ['<b>画布</b>', '3', '30 分钟', '50 万', '5 万']]);
  expect(projectTable()!.querySelector('tbody b')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '派活工作台' }));
  expect(screen.getByRole('button', { name: '派活工作台' }).getAttribute('aria-pressed')).toBe('true');
  expect(projectTable()).toBeUndefined();
  expect(document.querySelectorAll('.stat-tile')[0].querySelector('.stat-value')!.textContent).toBe('9 件');
  expect(localStorage.getItem('xa.dash-project')).toBe('派活工作台');
});
test('这段时间一件都没有：只剩筛选和一句话', async () => {
  const v = dashView(); v.dashboard = v.dashboard.map(s => ({ ...s, kpi: { ...s.kpi, jobs: 0 } }));
  await toStats(v);
  expect(screen.getByText('这段时间没有结束的活。')).toBeTruthy();
  expect(document.querySelector('.stat-row')).toBeNull();
});
test('小趋势线：平时圆点在最新一天；悬停或聚焦某一天出提示（数在前、日期在后），圆点跟过去', () => {
  render(<Sparkline label="件数" unit=" 件" format={String} values={[3, 0, 4]} labels={['9/28', '9/29', '9/30']} />);
  const dot = document.querySelector('.spark-dot') as HTMLElement;
  expect(dot.style.left).toBe('100%');
  const [first] = screen.getAllByRole('button');
  expect(first.getAttribute('aria-label')).toBe('9/28：3 件');
  fireEvent.focus(first);
  expect(screen.getByRole('tooltip').textContent).toBe('3 件9/28');
  expect(dot.style.left).toBe('0%');
});
