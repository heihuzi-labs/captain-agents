import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { megabytes, pillText, resetUpdateForTest } from '../../app/renderer/lib/update.ts';
import type { AppInfo, UpdateState, XaBridge } from '../../app/shared/ipc.ts';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); resetUpdateForTest(); vi.restoreAllMocks(); });
const info = (update: UpdateState, extra: Partial<AppInfo> = {}): AppInfo => ({ version: '0.2.0', update, autoCheck: true, ...extra });
const available: UpdateState = { phase: 'available', version: '0.3.0', notes: '群聊的活也上看板。\n<b>不是</b>网页代码。', size: 40 * 1048576 };
// 假后台：记下窗口订阅的回调，测试里用 push 模拟后台推来的新状态。
function bridge(first: AppInfo, extra: Partial<XaBridge> = {}) {
  let push: (state: UpdateState) => void = () => {};
  window.xa = fixtureBridge({ appInfo: vi.fn(async () => first), onUpdate: callback => { push = callback; return () => {}; }, ...extra });
  return { push: (state: UpdateState) => act(() => push(state)) };
}

test('小工具：大小写成人话；顶栏只在有新版本、下载中、已就绪时有字', () => {
  expect([megabytes(40 * 1048576), megabytes(1500), megabytes(10)]).toEqual(['40 MB', '1 KB', '1 KB']);
  expect([pillText(undefined), pillText({ phase: 'off', reason: '' }), pillText({ phase: 'idle', checked: null }), pillText({ phase: 'checking' }), pillText({ phase: 'error', message: '连不上' })]).toEqual([null, null, null, null, null]);
  expect([pillText(available), pillText({ phase: 'downloading', version: '0.3.0', received: 10, size: 40 }), pillText({ phase: 'ready', version: '0.3.0' })]).toEqual(['新版本 0.3.0', '下载中 25%', '重启以更新']);
});

test('顶栏提示和更新弹窗：有新版本才出现；下载、重启都要人点；更新说明当纯文字', async () => {
  const b = bridge(info(available));
  localStorage.setItem('xa.position', JSON.stringify({ page: 'board', filter: '全部' }));
  window.xa.getView = vi.fn(async () => fixtureView());
  render(<App />);
  const pill = await screen.findByRole('button', { name: '新版本 0.3.0' });
  expect(screen.queryByRole('dialog', { name: '更新' })).toBeNull();
  fireEvent.click(pill);
  const dialog = await screen.findByRole('dialog', { name: '更新' });
  expect(within(dialog).getByText('派活工作台 0.3.0')).toBeTruthy();
  expect(within(dialog).getByText('现在是 0.2.0 · 40 MB')).toBeTruthy();
  const notes = within(dialog).getByRole('group', { name: '更新说明' });
  expect(notes.textContent).toBe('群聊的活也上看板。\n<b>不是</b>网页代码。'); expect(notes.querySelector('b')).toBeNull();
  expect(window.xa.updateDownload).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '下载并安装' })); });
  expect(window.xa.updateDownload).toHaveBeenCalledTimes(1);
  // 后台推来下载进度。
  await b.push({ phase: 'downloading', version: '0.3.0', received: 10 * 1048576, size: 40 * 1048576 });
  expect(screen.getByRole('button', { name: '下载中 25%' })).toBeTruthy();
  expect(within(dialog).getByRole('progressbar', { name: '下载进度' }).getAttribute('aria-valuenow')).toBe('25');
  expect(within(dialog).getByText('已下载 10 MB / 40 MB')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: '下载并安装' })).toBeNull();
  // 下好并核对无误：等人点重启。
  await b.push({ phase: 'ready', version: '0.3.0' });
  expect(screen.getByRole('button', { name: '重启以更新' })).toBeTruthy();
  expect(within(dialog).getByText(/在跑的活和群聊不受影响/)).toBeTruthy();
  expect(window.xa.updateRestart).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '重启以完成更新' })); });
  expect(window.xa.updateRestart).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: '以后再说' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '更新' })).toBeNull());
});

test('弹窗里出错写原因、可以重新检查；动作本身失败也写原因', async () => {
  const b = bridge(info(available), { updateDownload: vi.fn(async () => { throw new Error('更新包所在的磁盘满了'); }), updateCheck: vi.fn(async () => ({ phase: 'idle' as const, checked: '2026-10-10T06:00:00.000Z' })) });
  window.xa.getView = vi.fn(async () => fixtureView());
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '新版本 0.3.0' }));
  const dialog = await screen.findByRole('dialog', { name: '更新' });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '下载并安装' })); });
  expect(within(dialog).getByRole('alert').textContent).toBe('没能开始下载：更新包所在的磁盘满了');
  await b.push({ phase: 'error', message: '更新包没通过核对，没有安装' });
  expect(within(dialog).getAllByRole('alert').map(a => a.textContent)).toContain('更新包没通过核对，没有安装');
  // 出错不在顶栏挂着。
  expect(screen.queryByRole('button', { name: /新版本|下载中|重启以更新/ })).toBeNull();
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '重新检查' })); });
  expect(window.xa.updateCheck).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByText('已是最新版本（0.2.0）。')).toBeTruthy();
});

async function openGeneral() {
  render(<Settings close={() => {}} view={fixtureView()} />);
  return await screen.findByRole('region', { name: '更新' });
}
test('设置里的“更新”：版本和状态、检查更新、有新版本后变“查看”、自动检查的开关', async () => {
  bridge(info({ phase: 'idle', checked: null }), { updateCheck: vi.fn(async () => available), setAutoUpdateCheck: vi.fn(async on => info(available, { autoCheck: on })) });
  const group = await openGeneral();
  expect(within(group).getByText('0.2.0')).toBeTruthy(); expect(within(group).getByText('还没检查过')).toBeTruthy();
  await act(async () => { fireEvent.click(within(group).getByRole('button', { name: '检查更新' })); });
  expect(window.xa.updateCheck).toHaveBeenCalledTimes(1);
  expect(within(group).getByText('有新版本 0.3.0')).toBeTruthy();
  expect(within(group).queryByRole('button', { name: '检查更新' })).toBeNull();
  expect(within(group).getByRole('button', { name: '查看' })).toBeTruthy();
  const auto = within(group).getByRole('switch', { name: '自动检查更新' });
  expect(auto.getAttribute('aria-checked')).toBe('true');
  await act(async () => { fireEvent.click(auto); });
  expect(window.xa.setAutoUpdateCheck).toHaveBeenCalledWith(false);
  expect(within(group).getByRole('switch', { name: '自动检查更新' }).getAttribute('aria-checked')).toBe('false');
});

test('设置里的“更新”：检查失败写原因；上次检查过写时间；不带在线更新的版本没有按钮和开关', async () => {
  bridge(info({ phase: 'idle', checked: '2026-10-10T06:02:00.000Z' }), { updateCheck: vi.fn(async () => { throw new Error('连不上更新地址'); }) });
  let group = await openGeneral();
  expect(within(group).getByText(/^已是最新版本 · .+ 检查过$/)).toBeTruthy();
  await act(async () => { fireEvent.click(within(group).getByRole('button', { name: '检查更新' })); });
  expect(within(group).getByText('没能检查：连不上更新地址')).toBeTruthy();
  cleanup(); resetUpdateForTest();
  bridge(info({ phase: 'off', reason: '这个版本不带在线更新' }));
  group = await openGeneral();
  expect(within(group).getByText('这个版本不带在线更新')).toBeTruthy();
  expect(within(group).queryByRole('button')).toBeNull(); expect(within(group).queryByRole('switch')).toBeNull();
});

test('设置里的“命令行”：没装给“安装”；已有别的要先确认才替换；已安装没有按钮；开发版整组不出现', async () => {
  bridge(info({ phase: 'off', reason: '这个版本不带在线更新' }), { cliStatus: vi.fn(async () => 'missing' as const), cliInstall: vi.fn(async () => 'installed' as const) });
  render(<Settings close={() => {}} view={fixtureView()} />);
  let group = await screen.findByRole('region', { name: '命令行' });
  expect(within(group).getByText(/还没安装/)).toBeTruthy();
  await act(async () => { fireEvent.click(within(group).getByRole('button', { name: '安装' })); });
  expect(window.xa.cliInstall).toHaveBeenCalledWith(false);
  expect(within(group).getByText(/已安装。终端里的 xagents 用的就是这个应用里的平台/)).toBeTruthy();
  expect(within(group).queryByRole('button')).toBeNull();
  cleanup(); resetUpdateForTest();
  bridge(info({ phase: 'off', reason: '' }), { cliStatus: vi.fn(async () => 'other' as const), cliInstall: vi.fn(async () => { throw new Error('目录写不进去'); }) });
  render(<Settings close={() => {}} view={fixtureView()} />);
  group = await screen.findByRole('region', { name: '命令行' });
  fireEvent.click(within(group).getByRole('button', { name: '替换…' }));
  expect(window.xa.cliInstall).not.toHaveBeenCalled();
  const ask = await screen.findByRole('alertdialog');
  expect(within(ask).getByText(/原来那个文件会被覆盖/)).toBeTruthy();
  await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: '替换' })); });
  expect(window.xa.cliInstall).toHaveBeenCalledWith(true);
  expect(within(screen.getByRole('region', { name: '命令行' })).getByText('没能安装：目录写不进去')).toBeTruthy();
  cleanup(); resetUpdateForTest();
  bridge(info({ phase: 'off', reason: '' }));   // 假桥缺省是开发版：unavailable
  render(<Settings close={() => {}} view={fixtureView()} />);
  await screen.findByRole('region', { name: '更新' });
  expect(screen.queryByRole('region', { name: '命令行' })).toBeNull();
});
