import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { defaultColumns } from '../../app/shared/ipc.ts';
import type { View, ViewJob } from '../../src/core/view-types.ts';
import { fixtureBridge, fixtureJob, fixtureView } from './fixtures.tsx';
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
function app(extra: Partial<View> = {}, jobs: ViewJob[] = []) {
  const view = fixtureView(); view.jobs = jobs; Object.assign(view, extra);
  let push: ((view: View) => void) | undefined;
  window.xa = fixtureBridge({ getView: vi.fn(async () => view), onView: callback => { push = callback; return () => {}; } });
  return { ...render(<App />), push: (next: View) => act(() => push?.(next)), view };
}
test.each([[], [fixtureJob('q', { state: 'queued', seconds: null })], [fixtureJob('r', { state: 'running', seconds: null }), fixtureJob('q', { state: 'queued', seconds: null })]])('看板始终三列，排队不另起一列：%j', async (...jobs) => {
  const { container } = app({}, jobs);
  await screen.findByRole('tablist');
  expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['进行中', '验收中', '已完成']);
  expect(container.querySelectorAll('#v-board > .column')).toHaveLength(3);
  expect(container.querySelector('.c-queued')).toBeNull();
});
test('看板：排队的活放在“进行中”列最上面，卡上带灰色“排队”标签；列头写“在跑几件 · N 排队”，没有排队就只有一个数字', async () => {
  const { container, push, view } = app({}, [fixtureJob('r1', { state: 'running', seconds: null, title: '在跑的甲' }), fixtureJob('q1', { state: 'queued', seconds: null, title: '排队的乙' }), fixtureJob('q2', { state: 'queued', seconds: null, title: '排队的丙' })]);
  await screen.findByText('在跑的甲');
  const cards = [...container.querySelectorAll('.c-running .cbody > .card')];
  expect(cards).toHaveLength(3);
  expect(cards.map(c => c.getAttribute('data-job'))).toEqual(['q1', 'q2', 'r1']); // 排队的在前，在跑的在后
  for (const c of cards.slice(0, 2)) { const chip = within(c as HTMLElement).getByText('排队'); expect(chip.className).toBe('chip chip-neutral'); expect(c.className).toContain('card-compact'); }
  expect(within(cards[2] as HTMLElement).queryByText('排队')).toBeNull();
  expect(screen.getByTestId('running').textContent).toBe('1'); expect(screen.getByTestId('queued').textContent).toBe('· 2 排队');
  expect(container.querySelector('.c-running .chead')!.textContent).toBe('进行中1· 2 排队');
  push({ ...view, jobs: view.jobs.filter(j => j.state === 'running') });
  await waitFor(() => expect(screen.queryByTestId('queued')).toBeNull());
  expect(container.querySelector('.c-running .chead')!.textContent).toBe('进行中1');
});
test('看板：只有排队、没有在跑时，进行中列里就是排队的卡，不写“现在没有在跑的活”；都没有才写', async () => {
  const { container, push, view } = app({}, [fixtureJob('q1', { state: 'queued', seconds: null })]);
  await waitFor(() => expect(container.querySelector('.c-running [data-job="q1"]')).toBeTruthy());
  expect(screen.queryByText('现在没有在跑的活')).toBeNull(); expect(screen.getByTestId('running').textContent).toBe('0');
  push({ ...view, jobs: [] });
  await screen.findByText('现在没有在跑的活');
});
test('列头：任何宽度都不折行，窄了先收“· 近 24 小时”、再把“全部历史 →”收成“历史 →”（样式规则和文字结构）', async () => {
  const { container } = app({}, [fixtureJob('d', { state: 'done' })]);
  await screen.findByRole('tablist');
  const head = container.querySelector('.c-done .chead')!;
  expect(head.querySelector('.range')!.textContent).toBe('· 近 24 小时');
  const aside = head.querySelector('.aside')!; expect(aside.textContent).toBe('全部历史 →'); expect(aside.querySelector('.long')!.textContent).toBe('全部');
  const css = readFileSync('app/renderer/styles/layout.css', 'utf8');
  expect(css).toMatch(/\.chead > \* \{[^}]*white-space: nowrap/);
  expect(css).toMatch(/\.column \{[^}]*container: col \/ inline-size/);
  expect(css).toMatch(/@container col \(max-width: 299px\) \{ \.chead \.range \{ display: none; \} \}/);
  expect(css).toMatch(/@container col \(max-width: 239px\) \{ \.chead \.long \{ display: none; \} \}/);
});
test('设置的“看板颜色”：三行（进行中、验收中、已完成），没有“排队”；改了只存这一项', async () => {
  window.xa = fixtureBridge();
  render(<Settings close={() => {}} />);
  fireEvent.click(await screen.findByRole('tab', { name: '看板颜色' }));
  await screen.findByLabelText('进行中');
  expect([...document.querySelectorAll('.setting-title')].map(t => t.textContent)).toEqual(['进行中', '验收中', '已完成']);
  expect(Object.keys(defaultColumns)).toEqual(['running', 'attention', 'done']);
  const color = screen.getByLabelText('验收中') as HTMLInputElement;
  expect(color.value).toBe(defaultColumns.attention);
  fireEvent.change(color, { target: { value: '#123456' } });
  await waitFor(() => expect(window.xa.setSettings).toHaveBeenCalledWith({ columns: { attention: '#123456' } }));
});
test('设置的“看板颜色”：旧设置里留着的 queued 键被忽略，不显示、不报错，存别的列时也不再带上它', async () => {
  window.xa = fixtureBridge({ getSettings: vi.fn(async () => ({ keepAwake: true, notifications: true, appearance: 'system' as const, openAtLogin: false, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 12, quotaStop: 80 as const }, columns: { queued: '#a0a097', running: '#111111' }, workers: {} as never })) });
  render(<Settings close={() => {}} />);
  fireEvent.click(await screen.findByRole('tab', { name: '看板颜色' }));
  await screen.findByLabelText('进行中');
  expect(screen.queryByLabelText('排队')).toBeNull(); expect((screen.getByLabelText('进行中') as HTMLInputElement).value).toBe('#111111');
  fireEvent.change(screen.getByLabelText('已完成'), { target: { value: '#123456' } });
  await waitFor(() => expect(window.xa.setSettings).toHaveBeenCalledWith({ columns: { running: '#111111', done: '#123456' } }));
});
test('列颜色：旧数据里留着 queued 也不影响看板；进行中的列色还是设置里配的那个', async () => {
  const { container } = app({ theme: { columns: { queued: '#a0a097', running: '#123456' } as never } }, [fixtureJob('q', { state: 'queued', seconds: null })]);
  await screen.findByRole('heading', { name: '进行中' });
  expect(container.querySelector<HTMLElement>('.c-running')!.style.getPropertyValue('--hue')).toBe('#123456');
  expect(container.querySelector('.c-queued')).toBeNull();
});
