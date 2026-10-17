import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fixtureBridge } from './fixtures.tsx';

// “位置”一组只在 Windows 上出现：这里把页面当成 Windows。
vi.mock('../../app/renderer/ui/platform.ts', async original => ({ ...await original<typeof import('../../app/renderer/ui/platform.ts')>(), isWindows: true }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('设置里的“位置”：写出程序和数据各在哪，按钮只把名字交给后台', async () => {
  const { PlaceSettings } = await import('../../app/renderer/components/Update.tsx');
  window.xa = fixtureBridge();
  render(<PlaceSettings />);
  const group = await screen.findByRole('region', { name: '位置' });
  expect(within(group).getByText('C:\\Apps\\captain-agents')).toBeTruthy();
  expect(within(group).getByText('C:\\Users\\me\\.xagents')).toBeTruthy();
  fireEvent.click(within(within(group).getByRole('group', { name: '数据' })).getByRole('button', { name: '打开文件夹' }));
  expect(window.xa.openPlace).toHaveBeenCalledWith('data');
});

test('设置里的“位置”：打不开时写出原因', async () => {
  const { PlaceSettings } = await import('../../app/renderer/components/Update.tsx');
  window.xa = fixtureBridge({ openPlace: vi.fn(async () => { throw new Error('文件夹不在了'); }) });
  render(<PlaceSettings />);
  const group = await screen.findByRole('region', { name: '位置' });
  fireEvent.click(within(within(group).getByRole('group', { name: '程序' })).getByRole('button', { name: '打开文件夹' }));
  await waitFor(() => expect(within(group).getByRole('alert').textContent).toContain('没能打开：文件夹不在了'));
});

test('Windows 上没有加固（docs/design-windows.md 第 14 节）：设置 → 通用里没有“加固”一组；顶栏不画自检圆点，提示里也不写自检', async () => {
  const { Settings } = await import('../../app/renderer/components/Settings.tsx');
  const { StatusCluster } = await import('../../app/renderer/ui/index.ts');
  const { fixtureView } = await import('./fixtures.tsx');
  localStorage.setItem('xa.settings-page', 'general');
  window.xa = fixtureBridge();
  try {
    render(<Settings close={() => {}} view={fixtureView()} />);
    await screen.findByRole('region', { name: '位置' });
    expect(screen.queryByRole('region', { name: '加固' })).toBeNull();
    expect(document.body.textContent).not.toContain('加固');
  } finally { localStorage.clear(); }
  cleanup();
  const { container } = render(<StatusCluster quota={fixtureView().quota} selfcheck={{ ok: null, at: null, note: '还没做过自检' }} onOpen={() => {}} />);
  const status = screen.getByRole('button');
  expect(container.querySelector('.status .dot')).toBeNull();
  expect(status.getAttribute('aria-label')).toBe('各家额度，点开看各家表现');
  expect(status.title).not.toContain('自检');
});
