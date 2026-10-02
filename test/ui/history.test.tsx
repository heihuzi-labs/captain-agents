import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import { dayLabel, recentLabel, readHistoryProject, rememberHistoryProject } from '../../app/renderer/lib/history.ts';
import type { View, ViewJob } from '../../src/core/view-types.ts';
import { fixtureBridge, fixtureJob, fixtureView } from './fixtures.tsx';
// 已完成列的项目卡默认折起；这里的测试要看卡里的行，先把用到的项目都记成“已展开”（折叠本身在“项目卡默认折起”那项测试里单独测）。
const EXPAND_ALL = () => localStorage.setItem('xa.done-expanded', JSON.stringify(['派活工作台', '画布', 'P', '空项目', '默认项目', '未归类', 'xa', '<b>画布</b>']));
// 固定“现在”（本地时间 7 月 15 日 17:00，附近没有夏令时切换）：看板“已完成”只收最近 24 小时，按天分组看今天、昨天，都跟着时钟走，用真实时钟会随跑测试的时刻变结果。
// 只假装 Date，计时器照常，不影响 findBy 的等待。
const NOW = new Date(2026, 6, 15, 17, 0, 0, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); EXPAND_ALL(); });

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

// 本地某天中午往前 n 天（避开零点前后的边界）。
const at = (daysBack: number, hour = 12, minute = 0) => { const d = new Date(); d.setDate(d.getDate() - daysBack); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
const lead = { kind: 'adopt' as const, by: 'lead' as const, at: '' };
const done = (id: string, project: string, extra: Partial<ViewJob> = {}) => fixtureJob(id, { project, title: id, decision: lead, started: at(0, 9), ended: at(0, 9, 30), ...extra });
const show = (v: View) => { window.xa = fixtureBridge({ getView: vi.fn(async () => v) }); return render(<App />); };
const archive = (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: `更多操作：${label}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
};
const toHistory = async () => { await screen.findByRole('tablist', { name: '页面' }); fireEvent.keyDown(document, { key: '2', metaKey: true }); await screen.findByRole('tablist', { name: '项目' }); };
const rail = () => within(screen.getByRole('tablist', { name: '项目' })).getAllByRole('tab').map(t => [t.querySelector('.sidenav-label')!.textContent, t.querySelector('.sidenav-badge')!.textContent, t.querySelector('.sidenav-note')!.textContent]);
const rowTitles = () => [...document.querySelectorAll('.hsum .ellip')].map(e => e.textContent);
function twoProjects() {
  const v = fixtureView();
  v.projects = [{ name: '派活工作台', label: '派活工作台', archived: false }, { name: '画布', label: '画布', archived: false }, { name: '空项目', label: '空项目', archived: false }];
  v.jobs = [done('a1', '派活工作台', { started: at(0, 10), ended: at(0, 11), kind: '修复' }), done('a2', '派活工作台', { started: at(1, 15), ended: at(1, 16), kind: '实现' }),
    done('c1', '画布', { started: at(0, 8), ended: at(0, 8, 30), kind: '实现' }), done('c2', '画布', { started: at(5, 9), ended: at(5, 10), kind: '实现' }), done('c3', '画布', { started: at(5, 7), ended: at(5, 8), kind: '实现' })];
  return v;
}

test('历史页左栏：全部加每个项目，写件数和最近一次，按最近活动排；登记了但没有历史的排最后', async () => {
  show(twoProjects()); await toHistory();
  const rows = rail();
  expect(rows.map(r => r.slice(0, 2))).toEqual([['全部', '5'], ['派活工作台', '2'], ['画布', '3'], ['空项目', '0']]);
  expect(rows[1][2]).toMatch(/^今天 \d\d:\d\d$/); expect(rows[3][2]).toBe('还没有历史');
  expect(rows[2][2]).toMatch(/^今天 \d\d:\d\d$/);
  expect(screen.getByRole('tab', { name: /^全部/ }).getAttribute('aria-selected')).toBe('true');
});
test('右栏按天分组：今天、昨天、月日和星期；同一天里新的在上；行是时间、题目、小图标，采用了不挂结果标签', async () => {
  const v = twoProjects(); show(v); await toHistory();
  const titles = [...document.querySelectorAll('.day')].map(d => d.textContent);
  expect(titles).toEqual(['今天', '昨天', dayLabel(at(5), Date.now())]); expect(titles[2]).toMatch(/^\d+ 月 \d+ 日（星期[日一二三四五六]）$/);
  expect(rowTitles()).toEqual(['a1', 'c1', 'a2', 'c2', 'c3']);
  const first = document.querySelector('.hrow')!;
  expect(first.querySelector('.date')!.textContent).toMatch(/^10:00$/); expect(within(first as HTMLElement).getAllByRole('img').length).toBeGreaterThan(0);
  expect([...first.querySelectorAll('.right .chip')].map(c => c.textContent).some(t => /^用了/.test(t!))).toBe(false);
});
test('一件活的结果：正常的不写只标例外——采用了没有标签，没用淡色字，出错、失联、负责人在挑、已停照写', async () => {
  const v = fixtureView();
  v.jobs = [done('adopted', 'P'), done('dropped', 'P', { decision: { ...lead, kind: 'drop' } }), done('failed', 'P', { state: 'failed', decision: null }), done('lost', 'P', { state: 'lost', decision: null }),
    done('pending', 'P', { decision: null }), done('stopped', 'P', { state: 'stopped', decision: null })];
  show(v); await toHistory();
  const right = (t: string) => screen.getByText(t).closest('.hrow')!.querySelector('.right')!;
  const label = (t: string) => right(t).querySelector('.chip:last-child')!;
  expect([...right('adopted').querySelectorAll('.chip')].some(c => /用了/.test(c.textContent!))).toBe(false); expect(right('adopted').querySelector('.faint')).toBeNull();
  expect(right('dropped').querySelector('.faint')!.textContent).toBe('没用'); expect(label('failed').textContent).toBe('出错');
  expect(label('lost').textContent).toBe('失联'); expect(label('pending').textContent).toBe('负责人在挑'); expect(label('stopped').textContent).toBe('已停');
  expect(label('failed').className).toContain('chip-bad');
});
test('“全部”里每行带项目小标签，选了具体项目就不带；只列这个范围里出现过的类型', async () => {
  show(twoProjects()); await toHistory();
  const tag = () => [...document.querySelectorAll('.hsum > .right > .chip')].filter(c => ['派活工作台', '画布'].includes(c.textContent!)).map(c => c.textContent);
  expect(tag()).toEqual(['派活工作台', '画布', '派活工作台', '画布', '画布']);
  const kinds = () => [...document.querySelectorAll('.filters button')].map(b => b.textContent);
  expect(kinds()).toEqual(['全部', '修复', '实现']);
  fireEvent.click(screen.getByRole('tab', { name: /^画布/ }));
  expect(tag()).toEqual([]); expect(rowTitles()).toEqual(['c1', 'c2', 'c3']); expect(document.querySelector('.filters')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /^派活工作台/ }));
  expect(kinds()).toEqual(['全部', '修复', '实现']);
  fireEvent.click(screen.getByRole('button', { name: '修复' })); expect(rowTitles()).toEqual(['a1']);
  fireEvent.click(screen.getByRole('tab', { name: /^画布/ }));
  expect(rowTitles(), '这个项目里没有“修复”，按全部显示，不留空').toEqual(['c1', 'c2', 'c3']);
});
test('点一行展开：每家一行，看得到分数、优点毛病标签、评语和真实验收；没打分写“还没打分”；点一行不弹窗', async () => {
  const v = fixtureView();
  const rating = { score: 4 as const, good: '一次做对', improve: '第一版漏了触控板', at: '', tags: [{ tag: '一次做对', kind: 'good' as const }, { tag: '需要返工', kind: 'bad' as const }, { tag: '别的', kind: 'other' as const }] };
  v.jobs = [done('rated', 'P', { rating, decision: { ...lead, note: '这份能用' }, check: { ok: true, label: '通过', note: '' }, realCheck: { needed: true, steps: [], result: { ok: true, note: '', at: '', shotCount: 0 }, skipped: null } }),
    done('plain', 'P', { started: at(0, 8) }), done('external', 'P', { started: at(0, 7), rating: { external: '网络不好', at: '', tags: [] } })];
  show(v); await toHistory();
  fireEvent.click(screen.getByText('rated').closest('button')!);
  expect(screen.queryByRole('dialog')).toBeNull();
  const member = document.querySelector('.hmember') as HTMLElement;
  expect(member.querySelector('.hscore')!.textContent).toBe('4 分');
  expect([...member.querySelectorAll('.hrate .chip')].map(c => [c.textContent, c.className.replace('chip chip-', '')])).toEqual([['一次做对', 'ok'], ['需要返工', 'bad'], ['别的', 'neutral']]);
  expect(member.textContent).toContain('做得好的：一次做对'); expect(member.textContent).toContain('要改进的：第一版漏了触控板');
  expect(member.textContent).toContain('这份能用'); expect(member.textContent).toContain('真实验收：通过'); expect(member.textContent).toContain('通过');
  for (const word of ['结果', '决定', '未验收']) expect(member.textContent).not.toContain(word);
  fireEvent.click(screen.getByText('plain').closest('button')!); expect(document.body.textContent).toContain('还没打分');
  fireEvent.click(screen.getByText('external').closest('button')!); expect(document.body.textContent).toContain('外部原因：网络不好');
  // 点身份那一行才打开这家的详情。
  fireEvent.click(within(member).getByTitle('打开详情')); expect(screen.getByRole('dialog')).toBeTruthy();
});
test('一批展开后每家一行，并能打开整批；只有一家的活不出现“打开这一批”', async () => {
  const v = fixtureView();
  v.jobs = [done('x', 'P', { batch: 'b' }), done('y', 'P', { batch: 'b', who: 'grok', rating: { score: 2, at: '', tags: [] } }), done('solo', 'P', { started: at(0, 7) })];
  v.batches = [{ id: 'b', title: '同一道题', summary: '说明', kind: '实现', base: '', started: at(0, 9), jobs: ['x', 'y'] }];
  show(v); await toHistory();
  expect(rowTitles()).toEqual(['同一道题', 'solo']);
  fireEvent.click(screen.getByText('同一道题').closest('button')!);
  expect(document.querySelectorAll('.hmember')).toHaveLength(2); fireEvent.click(screen.getByText('打开这一批 →'));
  expect(screen.getByRole('dialog').textContent).toContain('说明');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByText('solo').closest('button')!); expect(screen.queryByText('打开这一批 →')).toBeTruthy(); expect(document.querySelectorAll('.hmember')).toHaveLength(3);
});
test('空状态：没有历史的项目写一句人话；全部也是', async () => {
  const v = twoProjects(); show(v); await toHistory();
  fireEvent.click(screen.getByRole('tab', { name: /^空项目/ })); expect(screen.getByText('这个项目还没有历史。')).toBeTruthy();
  cleanup(); localStorage.clear(); show(fixtureView()); await toHistory(); expect(screen.getByText('还没有历史。')).toBeTruthy();
});
test('选中的项目记在本机，下次打开还在；项目没了就回到全部；存储读写失败不影响使用', async () => {
  show(twoProjects()); await toHistory();
  fireEvent.click(screen.getByRole('tab', { name: /^画布/ })); expect(localStorage.getItem('xa.history-project')).toBe('画布');
  cleanup(); show(twoProjects()); await toHistory();
  expect(screen.getByRole('tab', { name: /^画布/ }).getAttribute('aria-selected')).toBe('true'); expect(rowTitles()).toEqual(['c1', 'c2', 'c3']);
  fireEvent.click(screen.getByRole('tab', { name: /^全部/ })); expect(localStorage.getItem('xa.history-project')).toBe('');
  rememberHistoryProject('已经不存在的项目'); cleanup(); show(twoProjects()); await toHistory();
  expect(screen.getByRole('tab', { name: /^全部/ }).getAttribute('aria-selected')).toBe('true');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('denied'); });
  expect(readHistoryProject()).toBe(''); expect(() => rememberHistoryProject('画布')).not.toThrow();
  cleanup(); show(twoProjects()); await toHistory();
  fireEvent.click(screen.getByRole('tab', { name: /^画布/ })); expect(rowTitles(), '存不下也照常切换').toEqual(['c1', 'c2', 'c3']);
});
test('日期文字：今天、昨天、月日（星期）、跨年带年份；最近一次是今天 14:30 / 昨天 / 09-29', () => {
  const now = new Date(2026, 8, 30, 15, 0).getTime();
  const day = (y: number, m: number, d: number, h = 14, mi = 30) => new Date(y, m, d, h, mi).toISOString();
  expect(dayLabel(day(2026, 8, 30), now)).toBe('今天'); expect(dayLabel(day(2026, 8, 29), now)).toBe('昨天');
  expect(dayLabel(day(2026, 8, 28), now)).toBe('9 月 28 日（星期一）'); expect(dayLabel(day(2025, 11, 31), now)).toBe('2025 年 12 月 31 日（星期三）');
  expect(recentLabel(day(2026, 8, 30), now)).toBe('今天 14:30'); expect(recentLabel(day(2026, 8, 29), now)).toBe('昨天'); expect(recentLabel(day(2026, 8, 28, 9, 5), now)).toBe('09-28');
  expect(dayLabel(day(2026, 8, 29, 23, 59), new Date(2026, 8, 30, 0, 1).getTime())).toBe('昨天');
});

// ---- 看板 ----
const many = (project: string, n: number, hoursBase = 1) => Array.from({ length: n }, (_, i) => done(`${project}-${i}`, project, { started: new Date(Date.now() - (hoursBase + i) * 3600e3 - 600e3).toISOString(), ended: new Date(Date.now() - (hoursBase + i) * 3600e3).toISOString() }));
const doneCards = () => [...document.querySelectorAll('.column.c-done section')] as HTMLElement[];
test('看板已完成列按项目聚合：一个项目一张卡，标题栏是项目名和件数，每张最多 5 行，项目按最近完成排', async () => {
  const v = fixtureView(); v.jobs = [...many('派活工作台', 5, 2), ...many('画布', 7, 1)];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  const cards = doneCards();
  expect(cards.map(c => [c.querySelector('.bhead .t')!.textContent, c.querySelector('.bhead .n')!.textContent])).toEqual([['画布', '7'], ['派活工作台', '5']]);
  expect(cards.map(c => [...c.querySelectorAll('.done-row .done-title')].map(t => t.textContent))).toEqual([['画布-0', '画布-1', '画布-2', '画布-3', '画布-4'], ['派活工作台-0', '派活工作台-1', '派活工作台-2', '派活工作台-3', '派活工作台-4']]);
  expect(cards[0].querySelector('.done-foot')!.textContent).toBe('还有 2 件这个项目的全部 →');
  expect(cards[1].querySelector('.done-foot')!.textContent).toBe('这个项目的全部 →');
  expect(document.querySelector('.column.c-done .chead .n')!.textContent).toBe('12');
  // 全部采用：一行上一个结果标签也没有。
  expect(document.querySelectorAll('.column.c-done .done-end')).toHaveLength(0);
});
test('已完成列的一行：点了打开详情；一批采用了一家时不挂标签、没采用的那家图标调淡；都没用写淡色“都没用”、整行调淡', async () => {
  const v = fixtureView(); const lead = { kind: 'adopt' as const, by: 'lead' as const, at: new Date().toISOString() };
  v.jobs = [fixtureJob('a', { project: '派活工作台', batch: 'duel', who: 'codex', decision: lead }), fixtureJob('b', { project: '派活工作台', batch: 'duel', who: 'grok', decision: { kind: 'drop', by: 'lead', at: lead.at } })];
  v.batches = [{ id: 'duel', title: '两家对比', summary: '', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['a', 'b'] }];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  const row = document.querySelector('.column.c-done .done-row') as HTMLElement;
  expect(row.querySelectorAll('.done-icons .logo')).toHaveLength(2); expect(row.querySelectorAll('.done-icons .icon-dim')).toHaveLength(1);
  expect(row.querySelector('.done-end')).toBeNull(); expect(row.classList.contains('done-dropped')).toBe(false);
  // 一批不另加批次色点：并排的几家图标已经说明是一批（粉色的点还容易和留言小圆点混淆）。历史页的行也一样。
  expect(row.querySelector('.bdot, [style*="--batch"]')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: '历史' }));
  const hrow = (await screen.findByText('两家对比')).closest('.hrow') as HTMLElement;
  expect(hrow.querySelectorAll('.logo')).toHaveLength(2); expect(hrow.querySelector('.bdot, [style*="--batch"]')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: '看板' }));
  fireEvent.click(document.querySelector('.column.c-done .done-row') as HTMLElement); await screen.findByRole('dialog');
  cleanup(); v.jobs = v.jobs.map(j => ({ ...j, decision: { kind: 'drop' as const, by: 'lead' as const, at: lead.at } }));
  show(v); await screen.findByRole('tablist', { name: '页面' });
  const both = document.querySelector('.column.c-done .done-row')!;
  expect(both.querySelector('.done-end')!.textContent).toBe('都没用'); expect(both.classList.contains('done-dropped')).toBe(true); expect(both.querySelectorAll('.icon-dim')).toHaveLength(0);
});
test('项目卡默认折起，只有项目名和件数；点标题栏展开，再点折起；点开了哪些本机记住；旧的“折起名单”被删掉', async () => {
  localStorage.clear(); localStorage.setItem('xa.done-collapsed', '["画布"]');
  const v = fixtureView(); v.jobs = [...many('派活工作台', 3, 2), ...many('画布', 2, 1)];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  expect(localStorage.getItem('xa.done-collapsed')).toBeNull();
  const card = (name: string) => screen.getByRole('region', { name });
  const head = (name: string) => card(name).querySelector('.done-head') as HTMLButtonElement;
  for (const name of ['派活工作台', '画布']) { expect(head(name).getAttribute('aria-expanded')).toBe('false'); expect(card(name).querySelectorAll('.done-row, .done-foot')).toHaveLength(0); }
  expect(card('派活工作台').textContent).toBe('派活工作台3');
  fireEvent.click(head('派活工作台'));
  expect(head('派活工作台').getAttribute('aria-expanded')).toBe('true'); expect(card('派活工作台').querySelectorAll('.done-row')).toHaveLength(3);
  expect(card('画布').querySelectorAll('.done-row')).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem('xa.done-expanded')!)).toEqual(['派活工作台']);
  cleanup(); show(v); await screen.findByRole('tablist', { name: '页面' });
  expect(head('派活工作台').getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(head('派活工作台')); expect(card('派活工作台').querySelectorAll('.done-row')).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem('xa.done-expanded')!)).toEqual([]);
});
test('看板卡底的“这个项目的全部 →”：跳到历史页并选中这个项目，回到看板再去也是；刷新后记得', async () => {
  const v = fixtureView(); v.jobs = [...many('派活工作台', 5, 2), ...many('画布', 4, 1)];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  const group = () => screen.getByRole('region', { name: '派活工作台' });
  fireEvent.click(within(group()).getByRole('button', { name: '这个项目的全部 →' }));
  await screen.findByRole('tablist', { name: '项目' });
  expect(screen.getByRole('tab', { name: /^派活工作台/ }).getAttribute('aria-selected')).toBe('true'); expect(rowTitles()).toHaveLength(5);
  expect(localStorage.getItem('xa.history-project')).toBe('派活工作台');
  fireEvent.keyDown(document, { key: '1', metaKey: true });
  fireEvent.click(within(screen.getByRole('region', { name: '画布' })).getByRole('button', { name: '这个项目的全部 →' }));
  expect(screen.getByRole('tab', { name: /^画布/ }).getAttribute('aria-selected')).toBe('true'); expect(rowTitles()).toHaveLength(4);
});
test('只有一个项目时：已完成列也是一张项目卡，行里不写项目标签', async () => {
  const v = fixtureView(); v.jobs = [...many('派活工作台', 13, 1), fixtureJob('r', { project: '派活工作台', state: 'running', seconds: null })];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  expect(doneCards()).toHaveLength(1); expect(doneCards()[0].querySelectorAll('.done-row')).toHaveLength(5);
  expect(document.querySelectorAll('.ctitle > .chip')).toHaveLength(0);
  expect(doneCards()[0].querySelector('.done-foot')!.textContent).toBe('还有 8 件这个项目的全部 →');
});
test('进行中、验收中的卡片：同时有不止一个项目才在题目旁带项目标签；一批的大卡也带；已完成的行不带', async () => {
  const v = fixtureView();
  v.jobs = [fixtureJob('r1', { project: '派活工作台', state: 'running', seconds: null }), fixtureJob('q1', { project: '画布', state: 'queued', seconds: null }),
    fixtureJob('g1', { project: '画布', state: 'running', seconds: null, batch: 'b' }), fixtureJob('g2', { project: '画布', state: 'running', seconds: null, batch: 'b', who: 'grok' }),
    fixtureJob('d1', { project: '派活工作台', decision: null }), fixtureJob('ok', { project: '画布', decision: lead })];
  v.batches = [{ id: 'b', title: '一批', summary: '', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['g1', 'g2'] }];
  show(v); await screen.findAllByText('负责人在挑');
  const tags = (sel: string) => [...document.querySelectorAll(sel)].map(c => c.textContent);
  expect(tags('.column.c-running .ctitle > .chip')).toEqual(['画布', '派活工作台']); expect(tags('.column.c-running .bhead > .chip')).toEqual(['画布']);
  expect(tags('.column.c-attention .ctitle > .chip')).toEqual(['派活工作台']); expect(document.querySelectorAll('.column.c-done .done-row')).toHaveLength(1);
  // 只剩一个项目：一个标签也没有。
  cleanup(); const one = fixtureView(); one.jobs = v.jobs.map(j => ({ ...j, project: '派活工作台' })); one.batches = v.batches;
  show(one); await screen.findAllByText('负责人在挑');
  expect(document.querySelectorAll('.ctitle > .chip, .bhead > .chip')).toHaveLength(0);
});
test('看板上的项目数按“所有列一起”算：进行中只有画布、已完成只有派活工作台，也算两个项目，进行中带标签', async () => {
  const v = fixtureView(); v.jobs = [fixtureJob('r', { project: '画布', state: 'running', seconds: null }), ...many('派活工作台', 2)];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  expect(document.querySelector('.column.c-running .ctitle > .chip')!.textContent).toBe('画布');
  expect(doneCards().map(c => c.getAttribute('aria-label'))).toEqual(['派活工作台']);
});
test('项目名单里的显示名用于标签和左栏；老记录没有项目名归到“未归类”', async () => {
  const v = fixtureView(); v.projects = [{ name: 'xa', label: '派活工作台', archived: false }];
  v.jobs = [done('a', 'xa'), done('b', '', { started: at(1, 18), ended: at(1, 19) }), fixtureJob('r', { project: 'xa', state: 'running', seconds: null })];
  show(v); await toHistory();
  expect(rail().map(r => r.slice(0, 2))).toEqual([['全部', '2'], ['派活工作台', '1'], ['未归类', '1']]);
  fireEvent.keyDown(document, { key: '1', metaKey: true });
  expect(document.querySelector('.column.c-running .ctitle > .chip')!.textContent).toBe('派活工作台');
});

test('已归档项目的卡不在已完成列，列头件数不含它们；进行中、验收中照常带项目标签', async () => {
  const v = fixtureView();
  v.projects = [{ name: '派活工作台', label: '派活工作台', archived: false }, { name: '画布', label: '画布', archived: true }];
  v.jobs = [fixtureJob('run', { project: '画布', title: '还在画', state: 'running', seconds: null }), fixtureJob('attn', { project: '画布', title: '等验收', decision: null }),
    ...many('画布', 3, 1), ...many('派活工作台', 2, 2)];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  expect(doneCards().map(c => c.getAttribute('aria-label'))).toEqual(['派活工作台']);
  expect(screen.getByTestId('done').textContent).toBe('2');
  expect(screen.queryByRole('region', { name: '画布' })).toBeNull();
  expect(screen.getByText('还在画')).toBeTruthy();
  expect(document.querySelector('.column.c-running .ctitle > .chip')!.textContent).toBe('画布');
  expect(screen.getByText('等验收')).toBeTruthy();
  expect(document.querySelector('.column.c-attention .ctitle > .chip')!.textContent).toBe('画布');
});
test('两步归档发出整份名单；菜单入口不折叠，折起后仍有入口', async () => {
  const v = fixtureView();
  v.projects = [{ name: '派活工作台', label: '派活工作台', archived: true }, { name: '空项目', label: '空项目', archived: true }, { name: '画布', label: '画布', archived: false }];
  v.jobs = [...many('画布', 1, 1), fixtureJob('run', { project: '派活工作台', title: '还在派', state: 'running', seconds: null })];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  expect(doneCards().map(c => c.getAttribute('aria-label'))).toEqual(['画布']);
  expect(screen.getByText('还在派')).toBeTruthy();
  const card = screen.getByRole('region', { name: '画布' });
  fireEvent.click(within(card).getByRole('button', { name: '更多操作：画布' }));
  expect(window.xa.setSettings).not.toHaveBeenCalled();
  expect(card.querySelector('.done-head')!.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  expect(window.xa.setSettings).toHaveBeenCalledTimes(1);
  expect(window.xa.setSettings).toHaveBeenCalledWith({ archivedProjects: ['派活工作台', '空项目', '画布'] });
  expect(screen.getByRole('region', { name: '画布' })).toBeTruthy();
  expect(card.querySelector('.done-head')!.getAttribute('aria-expanded')).toBe('true'); // 点“归档”不会顺带折叠或展开
  // “…”在标题栏右边，卡折起来也看得到；卡底只剩“这个项目的全部 →”。
  expect(card.querySelector('.done-bar > .more-btn svg circle')).toBeTruthy(); expect(card.querySelector('.done-bar > .more-btn')!.getAttribute('aria-label')).toMatch(/^更多操作：/); expect(card.querySelector('.done-foot')!.textContent).toBe('这个项目的全部 →');
  fireEvent.click(card.querySelector('.done-head')!);
  expect(within(card).getByRole('button', { name: '更多操作：画布' })).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: '更多操作：画布' }));
  expect(card.querySelector('.done-head')!.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('menu')).toBeTruthy();
  await screen.findByText('已归档 画布，可在历史页“已归档”里找回');
});
test('归档还没存完时再点一次不再发；存完后按当时看板上的名单再发', async () => {
  const v = fixtureView();
  v.projects = [{ name: '画布', label: '画布', archived: false }, { name: '派活工作台', label: '派活工作台', archived: false }];
  v.jobs = [...many('画布', 1, 1), ...many('派活工作台', 1, 2)];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  let resolve: (value: unknown) => void = () => {};
  const gate = new Promise(r => { resolve = r; });
  window.xa.setSettings = vi.fn(() => gate) as typeof window.xa.setSettings;
  archive('画布');
  archive('派活工作台');
  expect(window.xa.setSettings).toHaveBeenCalledTimes(1);
  expect(window.xa.setSettings).toHaveBeenCalledWith({ archivedProjects: ['画布'] });
  await act(async () => { resolve({}); await gate; });
  archive('派活工作台');
  expect(window.xa.setSettings).toHaveBeenCalledTimes(2);
  expect(window.xa.setSettings).toHaveBeenLastCalledWith({ archivedProjects: ['派活工作台'] });
  await screen.findByText('已归档 派活工作台，可在历史页“已归档”里找回');
  expect(document.querySelectorAll('.toast')).toHaveLength(1);
});
test('归档保存失败：卡还在，提示条写保存失败和原因', async () => {
  const v = fixtureView(); v.jobs = many('画布', 1);
  show(v); await screen.findByRole('tablist', { name: '页面' });
  window.xa.setSettings = vi.fn(async () => { throw new Error("Error invoking remote method 'xa:settings-set': Error: 磁盘满了。"); });
  archive('画布');
  expect((await screen.findByRole('alert')).textContent).toBe('保存失败：磁盘满了。');
  expect(screen.getByRole('region', { name: '画布' })).toBeTruthy();
  expect(screen.getByTestId('done').textContent).toBe('1');
});
test('未归类没有归档按钮，有名字的项目有', async () => {
  const v = fixtureView(); v.projects = [{ name: 'xa', label: '派活工作台', archived: false }];
  v.jobs = [done('a', 'xa'), done('b', '')];
  show(v); await screen.findByRole('tablist', { name: '页面' });
  const unnamed = screen.getByRole('region', { name: '未归类' });
  expect(within(unnamed).queryByRole('button', { name: /更多操作/ })).toBeNull();
  expect(fireEvent.contextMenu(unnamed.querySelector('.done-bar')!)).toBe(false);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(within(unnamed).getByRole('button', { name: '这个项目的全部 →' })).toBeTruthy();
  expect(unnamed.querySelector('.done-foot')!.textContent).toBe('这个项目的全部 →');
  expect(within(screen.getByRole('region', { name: '派活工作台' })).getByRole('button', { name: '更多操作：派活工作台' })).toBeTruthy();
});
test('没有归档项目时，历史页没有“已归档”一节', async () => {
  show(twoProjects()); await toHistory();
  expect(screen.queryByRole('button', { name: /已归档/ })).toBeNull();
});
test('历史页“全部”不含已归档；“已归档”默认折起，展开后能看历史，取消归档发出剩下的名单', async () => {
  const v = twoProjects();
  v.projects = v.projects.map(p => ({ ...p, archived: p.name !== '派活工作台' }));
  show(v); await toHistory();
  expect(rail().map(r => r.slice(0, 2))).toEqual([['全部', '2'], ['派活工作台', '2']]);
  expect(rail()[0][2]).toBe('今天 10:00');
  expect(rowTitles()).toEqual(['a1', 'a2']);
  const fold = screen.getByRole('button', { name: '已归档 2 个项目' });
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('tablist', { name: '项目' }).contains(fold)).toBe(false);
  expect(screen.queryByRole('button', { name: '取消归档' })).toBeNull();
  expect(document.querySelector('.sidenav-archived-list')).toBeNull();
  fireEvent.click(fold);
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  const arch = (name: string) => [...document.querySelectorAll('.sidenav-archived-list > .sidenav-tab')].find(row => row.querySelector('.sidenav-label')!.textContent === name) as HTMLElement;
  expect([...document.querySelectorAll('.sidenav-archived-list .sidenav-label')].map(n => n.textContent)).toEqual(['画布', '空项目']);
  // 行里不放“取消归档”：和普通项目行长得一样，名字不被挤。
  expect(screen.queryByRole('button', { name: '取消归档' })).toBeNull();
  expect(arch('画布').querySelector('.sidenav-badge')!.textContent).toBe('3');
  expect(arch('空项目').querySelector('.sidenav-note')!.textContent).toBe('还没有历史');
  expect(within(screen.getByRole('tablist', { name: '项目' })).queryByRole('tab', { name: /^画布/ })).toBeNull();
  fireEvent.click(arch('画布'));
  expect(arch('画布').getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('tab', { name: /^全部/ }).getAttribute('aria-selected')).toBe('false');
  expect(rowTitles()).toEqual(['c1', 'c2', 'c3']);
  // 选中已归档项目后，右栏顶上一行说明和“取消归档”。
  expect(document.querySelector('.arch-note')!.textContent).toMatch(/^这个项目已归档/);
  fireEvent.click(screen.getByRole('button', { name: '取消归档' }));
  expect(window.xa.setSettings).toHaveBeenCalledWith({ archivedProjects: ['空项目'] });
});
test('打开历史页时，记着的就是已归档项目，这一节先展开', async () => {
  const v = twoProjects();
  v.projects = v.projects.map(p => ({ ...p, archived: p.name === '画布' }));
  rememberHistoryProject('画布');
  show(v); await toHistory();
  expect(screen.getByRole('button', { name: '已归档 1 个项目' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: '取消归档' })).toBeTruthy();
  expect(rowTitles()).toEqual(['c1', 'c2', 'c3']);
});
test('取消归档保存失败：这一节还在，提示条写原因', async () => {
  const v = twoProjects();
  v.projects = v.projects.map(p => ({ ...p, archived: p.name === '画布' }));
  show(v); await toHistory();
  window.xa.setSettings = vi.fn(async () => { throw new Error('磁盘满了。'); });
  fireEvent.click(screen.getByRole('button', { name: '已归档 1 个项目' }));
  fireEvent.click(document.querySelector('.sidenav-archived-list > .sidenav-tab')!);
  fireEvent.click(screen.getByRole('button', { name: '取消归档' }));
  expect((await screen.findByRole('alert')).textContent).toBe('保存失败：磁盘满了。');
  expect(screen.getByRole('button', { name: '已归档 1 个项目' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: /^画布/ })).toBeNull();
});


test('标题栏各处右键复用同一菜单，不折叠、不直接归档', async () => {
  const v = fixtureView(); v.jobs = many('画布', 1);
  show(v); await screen.findByRole('tablist', { name: '页面' });
  const card = screen.getByRole('region', { name: '画布' });
  for (const selector of ['.done-bar', '.done-head', '.done-head .t', '.done-head .n', '.more-btn']) {
    expect(fireEvent.contextMenu(card.querySelector(selector)!, { clientX: 40, clientY: 60 })).toBe(false);
    const menu = screen.getByRole('menu', { name: '更多操作：画布' });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(menu.style.left).toBe('40px'); expect(menu.style.top).toBe('60px');
    expect(card.querySelector('.done-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(window.xa.setSettings).not.toHaveBeenCalled();
  }
  fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  await screen.findByText('已归档 画布，可在历史页“已归档”里找回');
});

test('归档成功才提示，回推后卡消失；撤销使用最新名单、保留其他归档，成功关提示并恢复卡', async () => {
  const v = fixtureView();
  v.projects = [{ name: 'canvas', label: '画布', archived: false }, { name: '旧项目', label: '旧项目', archived: true }];
  v.jobs = many('canvas', 1);
  let push: (view: View) => void = () => {};
  let finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const normalSave = fixtureBridge().setSettings;
  window.xa = fixtureBridge({ getView: vi.fn(async () => v), onView: callback => { push = callback; return () => {}; },
    setSettings: vi.fn(async patch => { await gate; return normalSave(patch); }) });
  render(<App />); await screen.findByRole('tablist', { name: '页面' });
  archive('画布');
  expect(window.xa.setSettings).toHaveBeenLastCalledWith({ archivedProjects: ['旧项目', 'canvas'] });
  expect(screen.queryByText('撤销')).toBeNull();
  await act(async () => { finish(); await gate; });
  expect(screen.getByText('已归档 画布，可在历史页“已归档”里找回')).toBeTruthy();
  act(() => push({ ...v, projects: [...v.projects.map(p => ({ ...p, archived: true })), { name: '新归档', label: '新归档', archived: true }] }));
  expect(screen.queryByRole('region', { name: '画布' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(window.xa.setSettings).toHaveBeenLastCalledWith({ archivedProjects: ['旧项目', '新归档'] });
  await act(async () => {});
  expect(document.querySelector('.toast')).toBeNull();
  act(() => push(v));
  expect(screen.getByRole('region', { name: '画布' })).toBeTruthy();
});

test('撤销保存失败保留提示和动作，可重试；连续点击只存一次', async () => {
  const v = fixtureView(); v.projects = [{ name: '画布', label: '画布', archived: false }]; v.jobs = many('画布', 1);
  show(v); await screen.findByRole('tablist', { name: '页面' });
  archive('画布'); await screen.findByText('已归档 画布，可在历史页“已归档”里找回');
  window.xa.setSettings = vi.fn(async () => { throw new Error('磁盘满了。'); });
  const undo = screen.getByRole('button', { name: '撤销' });
  fireEvent.click(undo); fireEvent.click(undo);
  expect(window.xa.setSettings).toHaveBeenCalledTimes(1);
  expect((await screen.findByRole('alert')).textContent).toBe('保存失败：磁盘满了。');
  expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();
  window.xa.setSettings = fixtureBridge().setSettings;
  fireEvent.click(undo); await act(async () => {});
  expect(window.xa.setSettings).toHaveBeenCalledWith({ archivedProjects: [] });
  expect(document.querySelector('.toast')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
});
