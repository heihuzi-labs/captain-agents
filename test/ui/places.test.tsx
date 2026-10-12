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

test('设置里的“隔离”：没装好给“安装并检查”，正常时给“重新检查”，都只调一个不带参数的函数；失败写出原因', async () => {
  const { IsolationSettings } = await import('../../app/renderer/components/Update.tsx');
  window.xa = fixtureBridge();
  const { rerender } = render(<IsolationSettings selfcheck={{ ok: false, note: 'codex 未能自检：还没装好 Windows 上的隔离' }} />);
  let group = await screen.findByRole('region', { name: '隔离' });
  expect(within(group).getByText(/还没装好 Windows 上的隔离/)).toBeTruthy();
  fireEvent.click(within(group).getByRole('button', { name: '安装并检查' }));
  expect(window.xa.isolationFix).toHaveBeenCalledWith();
  expect(within(group).getByText(/系统弹出确认框时请点“是”/)).toBeTruthy();
  rerender(<IsolationSettings selfcheck={{ ok: true, note: '都被挡住，副本内可写' }} />);
  group = await screen.findByRole('region', { name: '隔离' });
  await waitFor(() => expect(within(group).getByRole('button', { name: '重新检查' })).toBeTruthy());
  expect(within(group).getByText('都被挡住，副本内可写')).toBeTruthy();
  cleanup();
  window.xa = fixtureBridge({ isolationFix: vi.fn(async () => { throw new Error('管理员确认被取消了'); }) });
  render(<IsolationSettings selfcheck={{ ok: null, note: '' }} />);
  group = await screen.findByRole('region', { name: '隔离' });
  expect(within(group).getByText('还没检查过')).toBeTruthy();
  fireEvent.click(within(group).getByRole('button', { name: '安装并检查' }));
  await waitFor(() => expect(within(group).getByText('没能装好：管理员确认被取消了')).toBeTruthy());
});
