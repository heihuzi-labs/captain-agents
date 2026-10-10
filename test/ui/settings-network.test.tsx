import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { NETWORK_NOTE } from '../../app/renderer/components/NetworkSettings.tsx';
import type { Settings as Values } from '../../app/shared/ipc.ts';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup() {
  localStorage.setItem('xa.settings-page', 'network');
  let current: Values = { keepAwake: true, notifications: true, appearance: 'system', openAtLogin: false, storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, workers: fixtureView().settings.workers, networkAllowed: false };
  const setNetworkAllowed = vi.fn(async (on: boolean) => { current = { ...current, networkAllowed: on }; return structuredClone(current); });
  const setSettings = vi.fn();
  window.xa = fixtureBridge({ getSettings: vi.fn(async () => structuredClone(current)), setSettings, setNetworkAllowed });
  const result = render(<Settings close={() => {}} view={fixtureView()} />);
  return { ...result, setNetworkAllowed, setSettings };
}

test('联网页只有一个面板、一行、一个缺省关闭的开关；专用入口保存开和关', async () => {
  const { baseElement: container, setNetworkAllowed, setSettings } = setup();
  const control = await screen.findByRole('switch', { name: '允许选手联网' });
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText(NETWORK_NOTE)).toBeTruthy();
  expect(container.querySelectorAll('.setting-group')).toHaveLength(1);
  expect(container.querySelectorAll('.setting-row')).toHaveLength(1);
  expect(container.querySelector('.settings')?.children).toHaveLength(1);
  expect(screen.getAllByRole('switch')).toHaveLength(1);
  fireEvent.click(control);
  await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
  await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  expect(setNetworkAllowed).toHaveBeenLastCalledWith(true);
  fireEvent.click(control);
  await waitFor(() => expect(setNetworkAllowed).toHaveBeenLastCalledWith(false));
  await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('false'));
  expect(setSettings).not.toHaveBeenCalled();
});

test('保存失败退回关闭，说明原因；保存中不重复发请求', async () => {
  const { setNetworkAllowed } = setup();
  const control = await screen.findByRole('switch', { name: '允许选手联网' });
  let reject!: (reason: Error) => void;
  setNetworkAllowed.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.click(control); fireEvent.click(control);
  expect(setNetworkAllowed).toHaveBeenCalledTimes(1);
  expect((control as HTMLButtonElement).disabled).toBe(true);
  reject(new Error('设置正在保存，请稍等。'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '没能保存：设置正在保存，请稍等。');
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect((control as HTMLButtonElement).disabled).toBe(false);
});
