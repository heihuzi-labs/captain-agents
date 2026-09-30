import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { fixtureBridge } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); });

test('设置里通用页最上面一行是“外观”，跟随系统、浅色、深色三选一；选了立刻显示并保存，标题不是 label（点标题不会误选）', async () => {
  const setSettings = vi.fn(async (patch: object) => ({ keepAwake: true, notifications: true, openAtLogin: false, appearance: 'dark' as const, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 6, quotaStop: 80 as const }, workers: {} as never, ...patch }));
  window.xa = fixtureBridge({ setSettings: setSettings as never });
  render(<Settings close={() => {}} />);
  const group = await screen.findByRole('group', { name: '外观' });
  expect(group.closest('.setting-group')!.firstElementChild).toBe(group);
  const seg = within(group).getByRole('tablist', { name: '外观' });
  expect(within(seg).getAllByRole('tab').map(t => t.textContent)).toEqual(['跟随系统', '浅色', '深色']);
  expect(within(seg).getByRole('tab', { name: '跟随系统' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(within(group).getByText('外观')); expect(setSettings).not.toHaveBeenCalled();
  fireEvent.click(within(seg).getByRole('tab', { name: '深色' }));
  expect(within(seg).getByRole('tab', { name: '深色' }).getAttribute('aria-selected')).toBe('true');
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ appearance: 'dark' }));
  fireEvent.click(within(seg).getByRole('tab', { name: '浅色' }));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ appearance: 'light' }));
});
test('外观保存失败：退回上次保存的值并写出原因', async () => {
  window.xa = fixtureBridge({ setSettings: vi.fn(async () => { throw new Error('存不了'); }) });
  render(<Settings close={() => {}} />);
  const seg = await screen.findByRole('tablist', { name: '外观' });
  fireEvent.click(within(seg).getByRole('tab', { name: '浅色' }));
  expect((await screen.findByRole('alert')).textContent).toContain('存不了');
  expect(within(seg).getByRole('tab', { name: '跟随系统' }).getAttribute('aria-selected')).toBe('true');
});
