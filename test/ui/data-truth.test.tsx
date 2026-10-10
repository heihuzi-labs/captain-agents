import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import type { View } from '../../src/core/view-types.ts';
import type { Stat } from '../../src/core/stats.ts';
import { fixtureJob as job, fixtureView as view, fixtureBridge } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const OLD = new Date(2020, 0, 2, 3, 4), fresh = () => new Date(Date.now() - 60_000);
const bar = (label: string, used: number | null) => ({ label, used, reset: null });
const stat = (extra: Partial<Stat> = {}): Stat => ({ who: 'codex', fast: false, kind: '实现', count: 8, small: false, doneRate: 1, verified: 0, passed: 0, verifyRate: null, adopted: 0, adoptRate: 0,
  secondsSamples: 0, averageSeconds: null, quotaSamples: 0, averageQuotaDelta: null, ...extra });
function show(v: View, bridge = {}) {
  window.xa = fixtureBridge({ getView: vi.fn(async () => v), ...bridge });
  return render(<App />);
}
const toStats = async () => { await screen.findByRole('tablist', { name: '页面' }); fireEvent.keyDown(document, { key: '4', metaKey: true }); await screen.findByRole('heading', { name: '表现', level: 1 }); };
const quotaView = (quotaAt: Date | null = OLD) => {
  const v = view();
  v.quotaAt = quotaAt?.toISOString() ?? null;
  v.quota = [
    { name: 'Codex', icon: 'codex', plan: 'pro', at: OLD.toISOString(), bars: [bar('周额度', 63)] },
    { name: 'Cursor', icon: 'cursor', plan: 'Ultra', at: fresh().toISOString(), bars: [bar('总额度', 10), bar('自家模型池', 12), bar('其他模型池', 23)] },
    { name: 'Grok', icon: 'grok', plan: null, at: OLD.toISOString(), failed: true, bars: [bar('本期额度', 5)] },
  ];
  return v;
};

test('顶栏额度：整块悬停按家写各池百分比和数据时间（本地 MM-DD HH:mm），Cursor 环取用得最多的池；顶栏只写百分比、不写池名', async () => {
  show(quotaView());
  await screen.findByRole('tablist', { name: '页面' });
  const status = screen.getByRole('button', { name: /各家额度/ }), tip = status.title.split('\n\n');
  expect(tip[0]).toBe('Codex（pro）\n周额度：63%\n数据时间 01-02 03:04');
  expect(tip[1].split('\n').slice(0, 4)).toEqual(['Cursor（Ultra）', '总额度：10%', '自家模型池：12%', '其他模型池：23%']);
  expect(tip[1]).toMatch(/\n数据时间 \d\d-\d\d \d\d:\d\d$/);
  expect(tip[2]).toBe('Grok\n本期额度：5%\n这次没查到，上面是上一次的数据\n数据时间 01-02 03:04');
  expect(tip[3]).toBe('隔离正常\n自检通过');
  const ring = (name: string) => within(status).getByRole('img', { name: new RegExp('^' + name) });
  expect(ring('Codex').getAttribute('data-used')).toBe('63');
  expect(ring('Cursor').getAttribute('data-used')).toBe('23');
  expect(ring('Cursor').getAttribute('aria-label')).toBe('Cursor：其他模型池 23%');
  expect(status.textContent).toBe('63%23%5%'); // 环旁只写百分比，不写池名（要求加百分比）
});
test('各家表现的额度卡：写数据时间；超过 30 分钟用提醒色；这次没查到写明', async () => {
  show(quotaView()); await toStats();
  const cards = [...document.querySelectorAll('.qcard')] as HTMLElement[], card = (name: string) => cards.find(c => c.textContent!.includes(name))!;
  const codex = card('Codex').querySelector('.chip-warn');
  expect(codex?.textContent).toBe('数据时间 01-02 03:04');
  expect(card('Cursor').querySelector('.chip-warn')).toBeNull();
  expect(card('Cursor').textContent).toMatch(/数据时间 \d\d-\d\d \d\d:\d\d/);
  expect(within(card('Grok')).getByText('这次没查到')).toBeTruthy();
  expect(card('Grok').textContent).toContain('5%'); // 保留上一次的数据，没有清空
});
test('刷新：点一下调用一次；进行中不可再点；完成后“刚刷新过”且不可点', async () => {
  let done: (() => void) | undefined;
  const refreshQuota = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
  show(quotaView(OLD), { refreshQuota }); await toStats();
  const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); expect(screen.queryByText('刚刷新过')).toBeNull();
  // 按钮始终在标题行右边那一组里，刷新前后不挪位置。
  expect(button.parentElement!.className).toBe('sec-tools');
  fireEvent.click(button); fireEvent.click(button);
  expect(refreshQuota).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: '正在刷新…' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { done!(); });
  expect(screen.getByText('刚刷新过')).toBeTruthy(); expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('刚刷新过').parentElement).toBe(screen.getByRole('button', { name: '刷新' }).parentElement);
  fireEvent.click(screen.getByRole('button', { name: '刷新' })); expect(refreshQuota).toHaveBeenCalledTimes(1);
});
test('刷新：数据刚查过（一分钟内）按钮不可点并写“刚刷新过”；出错只显示原因', async () => {
  show(quotaView(new Date(Date.now() - 10_000))); await toStats();
  expect(screen.getByText('刚刷新过')).toBeTruthy(); expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  const refreshQuota = vi.fn(async () => { throw new Error("Error invoking remote method 'xa:quota-refresh': Error: 正在刷新额度，请稍等。"); });
  show(quotaView(OLD), { refreshQuota }); await toStats();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect((await screen.findByRole('alert')).textContent).toBe('没能刷新：正在刷新额度，请稍等。');
  expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false);
});
test('表格只显示核心算好的统计：没有验收记录写“—”，有记录的分母只算有记录的；快速版分开；不再自己从任务列表里算', async () => {
  const v = view();
  // 任务列表里有 8 件做完的、都没有验收——旧算法会写“0/8 合格”；现在只信 view.stats。
  v.jobs = Array.from({ length: 8 }, (_, i) => job('j' + i, { decision: null }));
  v.stats = [stat({ kind: '实现' }), stat({ kind: '修复', count: 3, verified: 3, passed: 2, verifyRate: 2 / 3, adopted: 1, averageSeconds: 125, secondsSamples: 2 }),
    stat({ kind: '修复', fast: true, count: 2, small: true, verified: 1, passed: 1, verifyRate: 1, averageSeconds: 30 })];
  show(v); await toStats();
  const cell = (kind: string) => { const index = [...document.querySelectorAll('thead th')].findIndex(th => th.textContent === kind); return document.querySelector(`tbody tr td:nth-of-type(${index})`) as HTMLElement; };
  const plain = cell('实现');
  expect(plain.textContent).toContain('验收 —'); expect(plain.textContent).not.toContain('合格'); expect(plain.textContent).not.toContain('0/8'); expect(plain.textContent).toContain('平均 —');
  expect(plain.querySelector('[title="还没有验收记录"]')).toBeTruthy(); expect(plain.querySelector('.pcell')!.className).not.toContain('thin');
  const fix = cell('修复');
  expect(fix.textContent).toContain('2/3 合格'); expect(fix.textContent).toContain('平均 2 分钟'); expect(fix.textContent).toContain('被采用 1 次');
  expect(fix.textContent).toContain('普通版'); expect(fix.textContent).toContain('快速版'); expect(fix.textContent).toContain('1/1 合格'); expect(fix.textContent).toContain('平均 30 秒');
});
test('历史里一批的“合格 x/y”：分母只算有验收记录的', async () => {
  const v = view();
  v.jobs = [job('a', { batch: 'b', check: { ok: true, label: '通过', note: '' } }), job('b', { batch: 'b', who: 'grok' }), job('c', { batch: 'b', who: 'cursor-grok' })];
  v.batches = [{ id: 'b', title: '一批', summary: '', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['a', 'b', 'c'] }];
  show(v); await screen.findByRole('tablist', { name: '页面' }); fireEvent.keyDown(document, { key: '3', metaKey: true });
  expect((await screen.findByText(/^合格 \d/)).textContent).toBe('合格 1/1');
});
test('在跑的卡片：样本不够（核心没给通常用时）只显示已用时；给了才显示“通常 X”；用时不含休眠', async () => {
  const v = view(), start = Date.now() - 30 * 60_000;
  const from = new Date(start + 60_000).toISOString(), to = new Date(start + 21 * 60_000).toISOString();
  v.jobs = [job('quiet', { state: 'running', seconds: null, started: new Date(start).toISOString(), sleeps: [{ from, to }], typical: null }),
    job('known', { state: 'running', seconds: null, started: new Date(start).toISOString(), typical: 300 })];
  show(v); await screen.findByText('quiet');
  const card = (id: string) => document.querySelector(`[data-job="${id}"]`) as HTMLElement;
  expect(card('quiet').textContent).not.toContain('通常'); expect(card('quiet').querySelector('.prog')).toBeNull();
  expect(card('quiet').querySelector('.elapsed')!.textContent).toMatch(/^10 分 0\d 秒$|^9 分 5\d 秒$/); // 30 分钟里睡了 20 分钟
  expect(card('known').textContent).toContain('通常 5 分钟'); expect(card('known').querySelector('.elapsed')!.textContent).toMatch(/^30 分/);
});
