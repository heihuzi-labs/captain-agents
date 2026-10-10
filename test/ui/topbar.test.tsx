import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { App } from '../../app/renderer/App.tsx';
import { QuotaRing, Segmented, StatusCluster } from '../../app/renderer/ui/index.ts';
import type { View } from '../../src/core/view-types.ts';
import { fixtureBridge, fixtureJob, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function Pages() {
  const [id, setId] = useState('board');
  return <Segmented label="页面" value={id} onChange={setId} items={[{ id: 'board', label: '看板' }, { id: 'history', label: '历史' }, { id: 'stats', label: '表现' }]} />;
}
test('Segmented：tablist 和 tab、当前项 aria-selected；点击切换；只有当前项在 Tab 序列里', () => {
  render(<Pages />);
  const tab = (name: string) => screen.getByRole('tab', { name });
  expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('页面');
  expect(tab('看板').getAttribute('aria-selected')).toBe('true'); expect(tab('看板').tabIndex).toBe(0); expect(tab('历史').tabIndex).toBe(-1);
  fireEvent.click(tab('表现'));
  expect(tab('表现').getAttribute('aria-selected')).toBe('true'); expect(tab('看板').getAttribute('aria-selected')).toBe('false'); expect(tab('表现').tabIndex).toBe(0);
});
test('Segmented：左右键切换并把焦点跟过去（首尾循环），Home、End 跳头尾', () => {
  render(<Pages />);
  const tab = (name: string) => screen.getByRole('tab', { name });
  tab('看板').focus();
  fireEvent.keyDown(tab('看板'), { key: 'ArrowRight' });
  expect(tab('历史').getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tab('历史'));
  fireEvent.keyDown(tab('历史'), { key: 'ArrowLeft' }); expect(document.activeElement).toBe(tab('看板'));
  fireEvent.keyDown(tab('看板'), { key: 'ArrowLeft' }); expect(document.activeElement).toBe(tab('表现')); // 循环
  fireEvent.keyDown(tab('表现'), { key: 'ArrowRight' }); expect(document.activeElement).toBe(tab('看板'));
  fireEvent.keyDown(tab('看板'), { key: 'End' }); expect(tab('表现').getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(tab('表现'), { key: 'Home' }); expect(tab('看板').getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(tab('看板'), { key: 'ArrowDown' }); expect(tab('看板').getAttribute('aria-selected')).toBe('true'); // 其他键不动
});

test('QuotaRing：小于 80% 强调色、80% 起琥珀、95% 起红；填多少看 data-used 和弧长', () => {
  const ring = (used: number | null) => {
    const { container } = render(<QuotaRing used={used} label={`环 ${used}`}><i>图</i></QuotaRing>);
    return container.querySelector('.ring') as HTMLElement;
  };
  for (const [used, level] of [[0, undefined], [79, undefined], [80, 'warn'], [94, 'warn'], [95, 'bad'], [100, 'bad']] as const) {
    const r = ring(used);
    expect(r.dataset.level, String(used)).toBe(level); expect(r.dataset.used).toBe(String(used)); expect(r.hasAttribute('data-empty')).toBe(false);
    cleanup();
  }
  const r = ring(63);
  expect(r.querySelector('.ring-arc')?.getAttribute('stroke-dasharray')).toBe('63 100');
  expect(r.querySelector('.ring-track')?.getAttribute('stroke-dasharray')).toBeNull();
  expect(within(r).getByText('图')).toBeTruthy();
  expect(r.getAttribute('role')).toBe('img'); expect(r.getAttribute('aria-label')).toBe('环 63');
  cleanup();
  const zero = ring(0); expect(zero.querySelector('.ring-arc')).toBeNull(); // 用了 0% 只有底环
  cleanup();
  const over = ring(140); expect(over.querySelector('.ring-arc')?.getAttribute('stroke-dasharray')).toBe('100 100');
});
test('QuotaRing：查不到时是虚线空环，没有等级和弧', () => {
  const { container } = render(<QuotaRing used={null} label="查不到" />);
  const r = container.querySelector('.ring') as HTMLElement;
  expect(r.hasAttribute('data-empty')).toBe(true); expect(r.dataset.level).toBeUndefined(); expect(r.dataset.used).toBeUndefined();
  expect(r.querySelector('.ring-arc')).toBeNull();
  expect(r.querySelector('.ring-track')?.getAttribute('stroke-dasharray')).toBe('4 4');
});

const bar = (label: string, used: number | null) => ({ label, used, reset: null });
const quota: View['quota'] = [
  { name: 'Codex', icon: 'codex', plan: 'pro', at: '2020-01-02T03:04:00', bars: [bar('周额度', 31)] },
  { name: 'Grok', icon: 'grok', plan: null, at: null, bars: [] },
  { name: 'Cursor', icon: 'cursor', plan: 'Ultra', at: '2020-01-02T03:04:00', bars: [bar('总额度', 10), bar('其他模型池', 96)] },
];
test('StatusCluster：三家一个环加一个自检圆点，整块是按钮，点一下调用 onOpen', () => {
  const open = vi.fn();
  render(<StatusCluster quota={quota} selfcheck={{ ok: true, at: null, note: '目录外写都被挡住' }} onOpen={open} />);
  const button = screen.getByRole('button', { name: /各家额度/ });
  expect(within(button).getAllByRole('img').map(x => x.getAttribute('aria-label'))).toEqual(['Codex：周额度 31%', 'Grok：查不到额度', 'Cursor：其他模型池 96%', '隔离正常']);
  expect(within(button).getByRole('img', { name: 'Grok：查不到额度' }).hasAttribute('data-empty')).toBe(true);
  expect(within(button).getByRole('img', { name: /^Cursor/ }).getAttribute('data-level')).toBe('bad');
  fireEvent.click(button); expect(open).toHaveBeenCalledTimes(1);
});
test('StatusCluster：整块悬停写各家详情和自检原文；圆点悬停只写自检原文；圆点颜色跟自检结果', () => {
  const { container, rerender } = render(<StatusCluster quota={quota} selfcheck={{ ok: true, at: null, note: '目录外写都被挡住' }} onOpen={() => {}} />);
  const button = screen.getByRole('button', { name: /各家额度/ });
  expect(button.title).toBe(['Codex（pro）\n周额度：31%\n数据时间 01-02 03:04', 'Grok\n还没有查到过', 'Cursor（Ultra）\n总额度：10%\n其他模型池：96%\n数据时间 01-02 03:04', '隔离正常\n目录外写都被挡住'].join('\n\n'));
  const dot = () => container.querySelector('.status .dot') as HTMLElement;
  expect(dot().title).toBe('目录外写都被挡住'); expect(dot().className).toContain('dot-done');
  rerender(<StatusCluster quota={quota} selfcheck={{ ok: false, at: null, note: '外网没挡住' }} onOpen={() => {}} />);
  expect(dot().className).toContain('dot-failed'); expect(dot().getAttribute('aria-label')).toBe('隔离自检没过'); expect(dot().title).toBe('外网没挡住');
  rerender(<StatusCluster quota={quota} selfcheck={{ ok: null, at: null, note: '还没做过自检' }} onOpen={() => {}} />);
  expect(dot().className).toContain('dot-queued'); expect(dot().getAttribute('aria-label')).toBe('还没自检');
});

const app = (jobs: ReturnType<typeof fixtureJob>[], extra: Partial<View> = {}) => {
  const v = fixtureView(); v.jobs = jobs; Object.assign(v, extra);
  window.xa = fixtureBridge({ getView: vi.fn(async () => v) });
  return render(<App />);
};
test('顶栏：分段“看板 协作 历史 表现”，没有品牌字，没有“在跑”和“件等你”；看板不带件数角标', async () => {
  const { container } = app([fixtureJob('run', { state: 'running', seconds: null }), fixtureJob('wait', { state: 'done' }), fixtureJob('used', { state: 'done', decision: { kind: 'adopt', by: 'lead', at: '' } })]);
  await screen.findByRole('tablist');
  const top = container.querySelector('header.top') as HTMLElement;
  expect([...top.querySelectorAll('[role=tab]')].map(t => t.textContent)).toEqual(['看板', '协作', '历史', '表现']);
  expect(top.textContent).not.toContain('派活工作台'); expect(top.textContent).not.toContain('在跑'); expect(top.textContent).not.toContain('件等你'); expect(top.textContent).not.toContain('等你处理'); expect(top.textContent).not.toContain('隔离');
  expect(screen.getByRole('tab', { name: '看板' }).title).toBe('看板（⌘1）');
  expect(screen.getByTestId('attention').textContent).toBe('1');
  expect(screen.getByRole('heading', { name: '验收中' })).toBeTruthy();
  expect(top.querySelector('.brand')).toBeNull();
  expect(screen.getByRole('button', { name: '设置' }).title).toBe('设置（⌘,）');
});
test('顶栏：看板始终没有角标；读取中的顶栏也没有品牌字', async () => {
  const { container } = app([fixtureJob('run', { state: 'running', seconds: null })]);
  expect(container.querySelector('header.top')?.textContent).toBe('');
  await screen.findByRole('tablist');
  expect(screen.getByRole('tab', { name: '看板' }).textContent).toBe('看板');
});
test('顶栏：点分段切页（各家表现的页面标题不变），点状态块跳到“各家表现”，⌘1 回看板', async () => {
  app([]);
  fireEvent.click(await screen.findByRole('tab', { name: '历史' }));
  await screen.findByRole('heading', { name: '历史' }); expect(screen.getByRole('tab', { name: '历史' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /各家额度/ }));
  await screen.findByRole('heading', { name: '表现', level: 1 }); expect(screen.getByRole('tab', { name: '表现' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: '表现' }).title).toBe('各家表现（⌘4）');
  fireEvent.keyDown(document, { key: '1', metaKey: true });
  expect(screen.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true');
});
test('顶栏：设置按钮打开设置', async () => {
  app([]);
  fireEvent.click(await screen.findByRole('button', { name: '设置' }));
  expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy();
});
test('StatusCluster：环旁写百分比，查不到写“—”；平时不标等级，快用完时数字跟环一起变色', () => {
  const { container } = render(<StatusCluster quota={quota} selfcheck={{ ok: true, at: null, note: '' }} onOpen={() => {}} />);
  const items = [...container.querySelectorAll('.quota-item')] as HTMLElement[];
  expect(items.map(i => i.querySelector('.quota-pct')?.textContent)).toEqual(['31%', '—', '96%']);
  expect(items.map(i => i.dataset.level ?? '')).toEqual(['', '', 'bad']);
});
