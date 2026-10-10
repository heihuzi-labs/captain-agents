import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { TopBar } from '../../app/renderer/components/TopBar.tsx';
import { Stats } from '../../app/renderer/components/Pages.tsx';
import { QuotaRing } from '../../app/renderer/ui/index.ts';
import { quotaLevel } from '../../app/renderer/lib/quota.ts';
import { INTRO_TEXT } from '../../src/core/intro.ts';
import type { SettingsPatch, Settings as Values } from '../../app/shared/ipc.ts';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup(page: string) {
  localStorage.setItem('xa.settings-page', page);
  let current: Values = { keepAwake: true, notifications: true, appearance: 'system', openAtLogin: false, storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, workers: fixtureView().settings.workers, networkAllowed: false };
  const setSettings = vi.fn(async (patch: SettingsPatch) => { current = { ...current, ...patch } as Values; return structuredClone(current); });
  const copyIntro = vi.fn(async () => {});
  window.xa = fixtureBridge({ getSettings: vi.fn(async () => structuredClone(current)), setSettings, copyIntro });
  render(<Settings close={() => {}} view={fixtureView()} />);
  return { setSettings, copyIntro };
}

test('选手与模型页最上面是“派活限制”：同时最多跑 1–12 件、额度停派线 50–90% 和不设限，点了整组两项一起存', async () => {
  const { setSettings } = setup('workers');
  const group = (await screen.findByText('派活限制')).closest('.setting-group') as HTMLElement;
  expect(document.querySelectorAll('.setting-group')[0]).toBe(group);
  const run = within(group).getByRole('combobox', { name: '同时最多跑' }) as HTMLSelectElement, stop = within(group).getByRole('combobox', { name: '额度停派线' }) as HTMLSelectElement;
  expect([...run.options].map(o => o.textContent)).toEqual(['1 件', '2 件', '3 件', '4 件', '5 件', '6 件', '7 件', '8 件', '9 件', '10 件', '11 件', '12 件']);
  expect([...stop.options].map(o => o.textContent)).toEqual(['50%', '60%', '70%', '80%', '90%', '不设限']);
  expect([run.value, stop.value]).toEqual(['12', '80']);
  expect(within(group).queryByRole('tablist')).toBeNull(); expect(group.querySelector('.setting-foot')).toBeNull();
  fireEvent.change(run, { target: { value: '3' } });
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ limits: { maxRunning: 3, quotaStop: 80 } }));
  fireEvent.change(stop, { target: { value: '60' } });
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ limits: { maxRunning: 3, quotaStop: 60 } }));
  expect(run.value).toBe('3'); expect(stop.value).toBe('60');
  expect(within(group).getByText('某家用到这里就不再派给它')).toBeTruthy();
  fireEvent.change(stop, { target: { value: 'null' } });
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ limits: { maxRunning: 3, quotaStop: null } }));
  expect(within(group).getByText('不按用量停派；额度用尽的那家仍然派不出去')).toBeTruthy();
  fireEvent.change(stop, { target: { value: '90' } });
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ limits: { maxRunning: 3, quotaStop: 90 } }));
  expect(within(group).getByText('某家用到这里就不再派给它')).toBeTruthy();
});

test('额度环和额度卡的提醒色跟着停派线：到线琥珀、95% 起红，线以下灰', () => {
  expect([quotaLevel(59, 60), quotaLevel(60, 60), quotaLevel(79), quotaLevel(80), quotaLevel(95, 60), quotaLevel(null, 60)]).toEqual(['', 'warn', '', 'warn', 'bad', '']);
  render(<QuotaRing used={65} stop={60} label="Codex" />);
  expect(document.querySelector('.ring')!.getAttribute('data-level')).toBe('warn');
});

test('接入 AI 页：显示对接提示词原文（纯文字），点“复制”走桥上的 copyIntro，提示已复制', async () => {
  const { copyIntro } = setup('intro');
  const text = await screen.findByText((_, node) => node?.tagName === 'PRE' && node.textContent === INTRO_TEXT);
  expect(text.querySelector('*')).toBeNull();
  expect(screen.getByRole('tab', { name: '接入 AI' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  await waitFor(() => expect(copyIntro).toHaveBeenCalledWith());
  expect((await screen.findByRole('status')).textContent).toBe('已复制，去贴进 AI 的对话吧');
});

test('复制失败时写原因', async () => {
  const { copyIntro } = setup('intro');
  copyIntro.mockRejectedValueOnce(new Error('剪贴板不可用。'));
  fireEvent.click(await screen.findByRole('button', { name: '复制' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('没能复制：剪贴板不可用。'));
});


test('不设限圆环 85% 无琥珀色、96% 仍红色，缺省仍为 80%', () => {
  const { rerender } = render(<QuotaRing used={85} stop={null} label="Codex" />);
  expect(document.querySelector('.ring')!.getAttribute('data-level')).toBeNull();
  expect(quotaLevel(85, null)).toBe('');
  rerender(<QuotaRing used={96} stop={null} label="Codex" />);
  expect(document.querySelector('.ring')!.getAttribute('data-level')).toBe('bad');
  expect(quotaLevel(96, null)).toBe('bad');
  rerender(<QuotaRing used={85} label="Codex" />);
  expect(document.querySelector('.ring')!.getAttribute('data-level')).toBe('warn');
});

test('顶栏数字、圆环和表现页额度卡均接收不设限，切回 90% 恢复琥珀色', () => {
  const view = fixtureView();
  view.settings.limits = { maxRunning: 12, quotaStop: null };
  view.quota = [{ name: 'Codex', icon: 'codex', plan: 'pro', at: null, bars: [{ label: '周额度', used: 85, reset: null }] }];
  window.xa = fixtureBridge();
  const page = () => <><TopBar view={view} page="stats" go={() => {}} openSettings={() => {}} /><Stats view={view} /></>;
  const { rerender } = render(page());
  const level = () => [document.querySelector('.ring')!.getAttribute('data-level'), document.querySelector('.quota-item')!.getAttribute('data-level'), document.querySelector('.qtrack i')!.className];
  expect(level()).toEqual([null, null, '']);
  view.quota[0].bars[0].used = 96;
  rerender(page());
  expect(level()).toEqual(['bad', 'bad', 'bad']);
  view.settings.limits.quotaStop = 90;
  view.quota[0].bars[0].used = 90;
  rerender(page());
  expect(level()).toEqual(['warn', 'warn', 'warn']);
});
