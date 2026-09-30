// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type { XaBridge } from '../../app/shared/ipc.ts';
import { channels } from '../../app/shared/ipc.ts';
const mock = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async () => {}), on: vi.fn(), remove: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mock.expose }, ipcRenderer: { invoke: mock.invoke, on: mock.on, removeListener: mock.remove } }));
test('桥只开放白名单，不泄露 IPC 事件；取消订阅移除原监听', async () => {
  await import('../../app/preload/index.ts');
  expect(mock.expose.mock.calls[0][0]).toBe('xa');
  const bridge = mock.expose.mock.calls[0][1] as XaBridge;
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.keys(bridge).sort()).toEqual(['comment', 'connect', 'connectStatus', 'copyIntro', 'decide', 'disconnect', 'getSettings', 'getView', 'onOpen', 'onView', 'redo', 'refreshQuota', 'setSettings', 'stop']);
  await bridge.decide('x', 'drop'); expect(mock.invoke).toHaveBeenLastCalledWith(channels.decide, 'x', 'drop');
  await bridge.redo('x'); expect(mock.invoke).toHaveBeenLastCalledWith(channels.redo, 'x');
  await bridge.stop('x'); expect(mock.invoke).toHaveBeenLastCalledWith(channels.stop, 'x');
  await bridge.comment('x', '你好'); expect(mock.invoke).toHaveBeenLastCalledWith(channels.comment, 'x', '你好');
  await bridge.refreshQuota(); expect(mock.invoke).toHaveBeenLastCalledWith(channels.quotaRefresh);
  await bridge.setSettings({ notifications: false }); expect(mock.invoke).toHaveBeenLastCalledWith(channels.settingsSet, { notifications: false });
  const callback = vi.fn(), off = bridge.onOpen(callback), listener = mock.on.mock.calls.at(-1)![1] as (event: unknown, value: unknown) => void;
  listener({ sender: '不得泄露' }, { kind: 'settings' });
  expect(callback).toHaveBeenCalledWith({ kind: 'settings' }); expect(callback.mock.calls[0]).toHaveLength(1);
  off(); expect(mock.remove).toHaveBeenCalledWith(channels.open, listener);
});
