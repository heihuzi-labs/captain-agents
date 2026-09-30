import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { SLIM_CHOICES, megabytes, storageLine } from '../../app/renderer/lib/storage.ts';
import type { SettingsPatch, Settings as Values } from '../../app/shared/ipc.ts';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); });

const NOTE = (days: number) => `活结束 ${days} 天后，把选手的原始日志和运行文件移到废纸篓；任务记录、报告、改动和打分都留着。`;
const viewWith = (storage: { slimmedJobs: number; freedBytes: number; due: number }) => ({ ...fixtureView(), storage });
// 假的设置存取：保存后返回合并过的整份设置。
function setup(storage: Values['storage'] = { slim: true, days: 14 }, view = fixtureView()) {
  let current: Values = { keepAwake: true, notifications: true, appearance: 'system', openAtLogin: false, storage, limits: { maxRunning: 6, quotaStop: 80 }, workers: fixtureView().settings.workers };
  const setSettings = vi.fn(async (patch: SettingsPatch) => { current = { ...current, ...patch } as Values; return structuredClone(current); });
  window.xa = fixtureBridge({ getSettings: vi.fn(async () => structuredClone(current)), setSettings });
  const shown = render(<Settings close={() => {}} view={view} />);
  return { setSettings, shown };
}
const group = async () => (await screen.findByText('存储')).closest('.setting-group') as HTMLElement;

test('通用页的“存储”一组在外观和三个开关之后，三行都在：开关加说明、天数三选一、账目小字', async () => {
  setup({ slim: true, days: 14 }, viewWith({ slimmedJobs: 3, freedBytes: 119e6, due: 2 }));
  const storage = await group();
  const groups = [...document.querySelectorAll<HTMLElement>('.setting-group')];
  expect(groups.indexOf(storage)).toBe(1);
  expect(groups[0].querySelectorAll('[role="switch"]').length).toBe(3);
  expect(within(groups[0]).getByRole('group', { name: '外观' })).toBeTruthy();
  const rows = [...storage.querySelectorAll<HTMLElement>('.setting-row')];
  expect(rows.length).toBe(3);
  // 第一行：开关 + 说明
  expect(within(rows[0]).getByText('自动清理旧日志')).toBeTruthy();
  expect(within(rows[0]).getByText(NOTE(14))).toBeTruthy();
  expect(within(rows[0]).getByRole('switch', { name: '自动清理旧日志' }).getAttribute('aria-checked')).toBe('true');
  // 第二行：7 / 14 / 30 天三选一，当前是 14 天
  const tabs = within(rows[1]).getAllByRole('tab');
  expect(tabs.map(t => t.textContent)).toEqual(['7 天', '14 天', '30 天']);
  expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  expect(within(rows[1]).getByText('多少天后清理')).toBeTruthy();
  // 第三行：账目
  expect(rows[2].textContent).toBe('已清理 3 件，腾出 119 MB；现在有 2 件到期。');
});
test('天数选项就是 7、14、30；说明里的天数跟着当前选择变', async () => {
  setup({ slim: true, days: 30 });
  expect((await screen.findAllByRole('tab', { name: /天$/ })).map(t => t.textContent)).toEqual(SLIM_CHOICES.map(d => d + ' 天'));
  expect(SLIM_CHOICES).toEqual([7, 14, 30]);
  expect(screen.getByText(NOTE(30))).toBeTruthy();
});
test('关掉开关：立刻保存完整的 storage；天数一行变灰点不动，选中的天数保留', async () => {
  const { setSettings } = setup({ slim: true, days: 7 });
  const sw = await screen.findByRole('switch', { name: '自动清理旧日志' });
  const tabs = () => screen.getAllByRole('tab', { name: /天$/ }) as HTMLButtonElement[];
  expect(tabs().every(t => !t.disabled)).toBe(true);
  fireEvent.click(sw);
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ storage: { slim: false, days: 7 } }));
  expect(sw.getAttribute('aria-checked')).toBe('false');
  expect(tabs().every(t => t.disabled)).toBe(true);
  expect(document.querySelector('.seg[aria-disabled="true"]')).toBeTruthy();
  expect(tabs().find(t => t.getAttribute('aria-selected') === 'true')!.textContent).toBe('7 天');
  setSettings.mockClear();
  fireEvent.click(tabs()[2]);
  expect(setSettings).not.toHaveBeenCalled();
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  // 再打开，天数又能点了
  fireEvent.click(sw);
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ storage: { slim: true, days: 7 } }));
  expect(tabs().every(t => !t.disabled)).toBe(true);
});
test('开关关着进来：天数一行直接是灰的；账目照常显示', async () => {
  setup({ slim: false, days: 14 }, viewWith({ slimmedJobs: 1, freedBytes: 5e6, due: 0 }));
  const storage = await group();
  expect((within(storage).getAllByRole('tab') as HTMLButtonElement[]).every(t => t.disabled)).toBe(true);
  expect(within(storage).getByRole('switch', { name: '自动清理旧日志' }).getAttribute('aria-checked')).toBe('false');
  expect(within(storage).getByText('已清理 1 件，腾出 5 MB；现在没有到期的。')).toBeTruthy();
});
test('点天数：调用 setSettings({ storage: { slim, days } })，总是两项都带', async () => {
  const { setSettings } = setup({ slim: true, days: 14 });
  const storage = await group();
  fireEvent.click(within(storage).getByRole('tab', { name: '30 天' }));
  expect(within(storage).getByRole('tab', { name: '30 天' }).getAttribute('aria-selected')).toBe('true');
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ storage: { slim: true, days: 30 } }));
  fireEvent.click(within(storage).getByRole('tab', { name: '7 天' }));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ storage: { slim: true, days: 7 } }));
  expect(screen.getByText(NOTE(7))).toBeTruthy();
});
test('保存失败：开关和天数退回上次的值，原因写在内容区最上面', async () => {
  window.xa = fixtureBridge({ setSettings: vi.fn(async () => { throw new Error('存不了'); }) });
  render(<Settings close={() => {}} view={fixtureView()} />);
  const sw = await screen.findByRole('switch', { name: '自动清理旧日志' });
  fireEvent.click(sw);
  expect((await screen.findByRole('alert')).textContent).toContain('存不了');
  expect(sw.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: '30 天' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '14 天' }).getAttribute('aria-selected')).toBe('true'));
});
test('账目小字随 View.storage 变化；一件都没清、没有到期时也有确定的写法', async () => {
  const { shown } = setup({ slim: true, days: 14 }, viewWith({ slimmedJobs: 0, freedBytes: 0, due: 0 }));
  await group();
  const line = () => document.querySelector('.setting-foot')!.textContent;
  expect(line()).toBe('还没清理过；现在没有到期的。');
  shown.rerender(<Settings close={() => {}} view={viewWith({ slimmedJobs: 0, freedBytes: 0, due: 4 })} />);
  expect(line()).toBe('还没清理过；现在有 4 件到期。');
  shown.rerender(<Settings close={() => {}} view={viewWith({ slimmedJobs: 76, freedBytes: 87_400_000, due: 0 })} />);
  expect(line()).toBe('已清理 76 件，腾出 87 MB；现在没有到期的。');
  shown.rerender(<Settings close={() => {}} view={viewWith({ slimmedJobs: 2, freedBytes: 2_340_000, due: 1 })} />);
  expect(line()).toBe('已清理 2 件，腾出 2.3 MB；现在有 1 件到期。');
});
test('没有看板数据时（只有设置）不画账目，其余两行照常', async () => {
  window.xa = fixtureBridge();
  render(<Settings close={() => {}} />);
  const storage = await group();
  expect(storage.querySelectorAll('.setting-row').length).toBe(2);
  expect(document.querySelector('.setting-foot')).toBeNull();
});
test('字节换成 MB 的写法：0、不足 0.1、一位小数、整数、10 以上取整', () => {
  expect(megabytes(0)).toBe('0 MB');
  expect(megabytes(99_999)).toBe('不到 0.1 MB');
  expect(megabytes(100_000)).toBe('0.1 MB');
  expect(megabytes(5_000_000)).toBe('5 MB');
  expect(megabytes(2_340_000)).toBe('2.3 MB');
  expect(megabytes(12_600_000)).toBe('13 MB');
  expect(megabytes(119_000_000)).toBe('119 MB');
  expect(storageLine({ slimmedJobs: 1, freedBytes: 50_000, due: 0 })).toBe('已清理 1 件，腾出 不到 0.1 MB；现在没有到期的。');
});
