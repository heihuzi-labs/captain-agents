import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import type { View } from '../../src/core/view-types.ts';
import type { Stat } from '../../src/core/stats.ts';
import type { Profile } from '../../src/core/profiles.ts';
import { fixtureView as view, fixtureBridge } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const stat = (extra: Partial<Stat> = {}): Stat => ({ who: 'codex', fast: false, kind: '实现', count: 8, small: false, doneRate: 1, verified: 4, passed: 3, verifyRate: .75, adopted: 2, adoptRate: .25,
  secondsSamples: 8, averageSeconds: 300, quotaSamples: 0, averageQuotaDelta: null, ...extra });
// 按核心档案的形状造档案。
const profile = (extra: Partial<Profile> = {}): Profile => ({ who: 'codex', fast: false, kind: '实现', count: 8, rated: 6, avgScore: 4.33, reworkRate: 1 / 3, avgSeconds: 300, avgToolSeconds: null, avgSteps: null,
  good: [{ tag: '一次做对', n: 4 }, { tag: '报告老实', n: 2 }], bad: [{ tag: '需要返工', n: 2 }], recent: [], small: false, ...extra });
const AT = new Date(2026, 8, 29, 14, 44).toISOString(), EARLIER = new Date(2026, 8, 28, 9, 5).toISOString();
async function show(v: View) {
  window.xa = fixtureBridge({ getView: vi.fn(async () => v) });
  render(<App />);
  await screen.findByRole('tablist', { name: '页面' }); fireEvent.keyDown(document, { key: '3', metaKey: true });
  await screen.findByRole('heading', { name: '表现', level: 1 });
}
// 第 row 位选手（按选手名单顺序、只算表格里出现的）在某一类活下的那一格。
const cell = (row: number, kind: string) => {
  const column = [...document.querySelectorAll('thead th')].findIndex(th => th.textContent === kind);
  return document.querySelectorAll('tbody > tr:not(.reviews-row)')[row].children[column] as HTMLElement;
};
const parts = (td: HTMLElement) => [...td.querySelectorAll('.pcell')] as HTMLElement[];

test('每格在原有内容上加平均分、返工比例、优点和毛病标签（两种颜色的统一标签）', async () => {
  const v = view();
  v.stats = [stat()]; v.profiles = [profile()];
  await show(v);
  const td = cell(0, '实现');
  expect(td.textContent).toContain('3/4 合格'); expect(td.textContent).toContain('平均 5 分钟'); expect(td.textContent).toContain('被采用 2 次');
  expect(td.textContent).toContain('4.3 分'); expect(td.textContent).toContain('返工 33%');
  expect(within(td).getByText('4.3 分').getAttribute('title')).toBe('6 件打了分的平均分');
  expect(within(td).getByText('一次做对').className).toBe('chip chip-ok');
  expect(within(td).getByText('报告老实').className).toBe('chip chip-ok');
  expect(within(td).getByText('需要返工').className).toBe('chip chip-bad');
  expect(within(td).getByText('一次做对').getAttribute('title')).toBe('出现 4 次');
  expect([...td.querySelectorAll('.chip')].map(c => c.textContent)).toEqual(['一次做对', '报告老实', '需要返工']);
  expect(td.textContent).not.toContain('还没有打分');
  expect(parts(td)[0].className).not.toContain('thin');
});

test('样本少的淡显：做过的不到 3 件、或打了分的不到 3 件；做得多但还没打分的不淡显，写“还没有打分”', async () => {
  const v = view();
  v.stats = [stat({ kind: '实现' }), stat({ kind: '修复', count: 2, small: true }), stat({ kind: '调研' })];
  v.profiles = [profile({ kind: '实现', rated: 2, small: true, avgScore: 5, reworkRate: 0, bad: [] }), profile({ kind: '修复', count: 2, rated: 2, small: true, avgScore: 3 }),
    profile({ kind: '调研', rated: 0, small: true, avgScore: null, reworkRate: null, good: [], bad: [] })];
  await show(v);
  expect(parts(cell(0, '实现'))[0].className).toContain('thin'); expect(cell(0, '实现').textContent).toContain('5.0 分'); expect(cell(0, '实现').textContent).toContain('返工 0%');
  expect(parts(cell(0, '修复'))[0].className).toContain('thin');
  const survey = cell(0, '调研');
  expect(parts(survey)[0].className).not.toContain('thin');
  expect(survey.textContent).toContain('还没有打分'); expect(survey.textContent).toContain('3/4 合格'); expect(survey.textContent).not.toContain('返工');
  expect(survey.querySelector('.chip')).toBeNull();
});

test('没有打分时（没有档案）格子照旧显示原有内容，加一句“还没有打分”；没有评语的块不是按钮', async () => {
  const v = view();
  v.stats = [stat({ verified: 0, passed: 0, verifyRate: null, adopted: 0, averageSeconds: null })];
  await show(v);
  const td = cell(0, '实现');
  expect(td.textContent).toContain('验收 —'); expect(td.textContent).toContain('平均 —'); expect(td.textContent).toContain('还没有打分');
  expect(td.querySelector('[title="还没有验收记录"]')).toBeTruthy();
  expect(td.querySelector('button')).toBeNull();
  cleanup();
  const rated = view();
  rated.stats = [stat()]; rated.profiles = [profile({ recent: [] })];
  await show(rated);
  expect(cell(0, '实现').querySelector('button')).toBeNull();
});

test('点一格展开这一组最近的评语：题目、分数、做得好的、要改进的、时间，新的在上；纯文字；再点收起，点别的格子换过去', async () => {
  const v = view();
  v.stats = [stat({ kind: '实现' }), stat({ kind: '修复' }), stat({ who: 'grok', kind: '实现' })];
  v.profiles = [
    profile({ kind: '实现', recent: [
      { id: 'j1', title: '早一点的活', at: EARLIER, score: 3, improve: '测试没打到真实环境' },
      { id: 'j2', title: '<b>加粗</b> 的题目', at: AT, score: 5, good: '一次做对，\n还指出了说明里的错', improve: '报告可以短一点' },
    ] }),
    profile({ kind: '修复', recent: [{ id: 'j3', title: '修一个错', at: AT, good: '找到了真正的原因' }] }),
    profile({ who: 'grok', kind: '实现', recent: [{ id: 'j4', title: 'Grok 的活', at: AT, score: 2 }] }),
  ];
  await show(v);
  const button = within(cell(0, '实现')).getByRole('button');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('region', { name: '最近的评语' })).toBeNull();
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true'); expect(button.className).toContain('on');
  const region = screen.getByRole('region', { name: '最近的评语' });
  expect(button.getAttribute('aria-controls')).toBe(region.id);
  // 展开的是紧跟在这位选手下面的一整行。
  const row = region.closest('tr')!;
  expect(row.previousElementSibling).toBe(cell(0, '实现').parentElement);
  expect(row.querySelector('td')!.colSpan).toBe(3);
  expect(within(region).getByText('实现').className).toBe('chip chip-neutral');
  expect(within(region).queryByText('快速版')).toBeNull();
  const items = within(region).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText('<b>加粗</b> 的题目')).toBeTruthy();
  expect(region.querySelector('b b')).toBeNull();
  expect(within(items[0]).getByText('5 分').className).toBe('chip chip-neutral');
  expect(within(items[0]).getByText('09-29 14:44')).toBeTruthy();
  expect(items[0].textContent).toContain('做得好：一次做对，\n还指出了说明里的错'); expect(items[0].textContent).toContain('要改进：报告可以短一点');
  expect(items[1].textContent).toContain('早一点的活'); expect(items[1].textContent).toContain('3 分'); expect(items[1].textContent).toContain('09-28 09:05');
  expect(items[1].textContent).toContain('要改进：测试没打到真实环境'); expect(items[1].textContent).not.toContain('做得好');
  // 点另一格：换过去，同一时间只展开一块。
  fireEvent.click(within(cell(0, '修复')).getByRole('button'));
  expect(button.getAttribute('aria-expanded')).toBe('false');
  const other = screen.getAllByRole('region', { name: '最近的评语' });
  expect(other).toHaveLength(1);
  const only = within(other[0]).getByRole('listitem');
  expect(only.textContent).toContain('修一个错'); expect(only.textContent).toContain('做得好：找到了真正的原因'); expect(only.querySelector('.chip')).toBeNull();
  // 换到下一位选手：展开行跟着到那一行下面。
  fireEvent.click(within(cell(1, '实现')).getByRole('button'));
  const grok = screen.getByRole('region', { name: '最近的评语' });
  expect(grok.closest('tr')!.previousElementSibling).toBe(cell(1, '实现').parentElement);
  expect(grok.textContent).toContain('Grok 的活');
  fireEvent.click(within(cell(1, '实现')).getByRole('button'));
  expect(screen.queryByRole('region', { name: '最近的评语' })).toBeNull();
});

test('快速版和普通版分开：同一格两块，各有自己的分数、标签、淡显和评语', async () => {
  const v = view();
  v.stats = [stat({ who: 'cursor-grok', kind: '修复' }), stat({ who: 'cursor-grok', kind: '修复', fast: true, count: 2, small: true })];
  v.profiles = [profile({ who: 'cursor-grok', kind: '修复', avgScore: 4, recent: [{ id: 'n', title: '普通版的活', at: AT, score: 4 }] }),
    profile({ who: 'cursor-grok', kind: '修复', fast: true, count: 2, rated: 2, small: true, avgScore: 2.5, reworkRate: .5, good: [{ tag: '速度快', n: 2 }], bad: [{ tag: '夸大结论', n: 1 }],
      recent: [{ id: 'f', title: '快速版的活', at: AT, score: 2, improve: '结论说过头了' }] })];
  await show(v);
  const [plain, fast] = parts(cell(0, '修复'));
  expect(plain.textContent).toMatch(/^普通版/); expect(fast.textContent).toMatch(/^快速版/);
  expect(plain.textContent).toContain('4.0 分'); expect(plain.textContent).toContain('返工 33%'); expect(plain.className).not.toContain('thin');
  expect(fast.textContent).toContain('2.5 分'); expect(fast.textContent).toContain('返工 50%'); expect(fast.className).toContain('thin');
  expect(within(fast).getByText('速度快').className).toBe('chip chip-ok'); expect(within(fast).getByText('夸大结论').className).toBe('chip chip-bad');
  expect(within(plain).queryByText('速度快')).toBeNull();
  fireEvent.click(fast);
  const region = screen.getByRole('region', { name: '最近的评语' });
  expect(within(region).getByText('快速版').className).toBe('chip chip-neutral');
  expect(region.textContent).toContain('快速版的活'); expect(region.textContent).toContain('要改进：结论说过头了'); expect(region.textContent).not.toContain('普通版的活');
  expect(plain.getAttribute('aria-expanded')).toBe('false');
});

test('行和列来自统计和档案两份数据：只在档案里出现的组合也画出来', async () => {
  const v = view();
  v.stats = [stat()]; v.profiles = [profile(), profile({ who: 'cursor-opus', kind: '调研', count: 1, rated: 1, small: true, avgScore: 5, reworkRate: 0, bad: [] })];
  await show(v);
  expect([...document.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['选手', '调研', '实现']); // 类型按拼音排，和原来一样
  expect(document.querySelectorAll('tbody > tr')).toHaveLength(2);
  expect(cell(1, '调研').textContent).toContain('5.0 分'); expect(parts(cell(1, '调研'))[0].className).toContain('thin');
  expect(cell(1, '实现').textContent).toBe('—');
});
