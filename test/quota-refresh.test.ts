import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { QUOTA_GAP_MS, quotaRefreshHandler, quotaRefresher } from '../app/main/actions.ts';
import { trustedSender } from '../app/main/security.ts';
import { channels } from '../app/shared/ipc.ts';
import { root } from './helpers.ts';

// 手动走表的时钟和可挂起的“查询”，不真的等，也不启动任何选手命令行。
function rig(gap?: number) {
  let time = 1_000_000, calls = 0, updates = 0, release: (() => void) | undefined, fail: Error | undefined;
  const refresher = quotaRefresher({
    now: () => time,
    query: () => { calls++; return new Promise<void>((resolve, reject) => { release = () => (fail ? reject(fail) : resolve()); }); },
  }, async () => { updates++; }, gap);
  return { refresher, calls: () => calls, updates: () => updates, tick: (ms: number) => { time += ms; }, finish: () => release!(), failWith: (e: Error) => { fail = e; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('刷新额度：同一时间只跑一次，第二个请求直接被拒，不多启动一次查询', async () => {
  const r = rig(), first = r.refresher.refresh([]);
  await assert.rejects(r.refresher.refresh([]), /正在刷新/);
  assert.equal(r.calls(), 1); r.finish(); await first;
  assert.equal(r.updates(), 1);
});
test('刷新额度：两次之间至少隔 60 秒（从上一次结束算），冷却里被拒，过了可再刷', async () => {
  const r = rig(); assert.equal(QUOTA_GAP_MS, 60_000);
  const first = r.refresher.refresh([]); r.finish(); await first;
  r.tick(59_999); await assert.rejects(r.refresher.refresh([]), /刚刷新过/); assert.equal(r.calls(), 1);
  r.tick(1); const second = r.refresher.refresh([]); await settle(); assert.equal(r.calls(), 2); r.finish(); await second;
  assert.equal(r.updates(), 2);
});
test('刷新额度：查询本身出错也算一次，冷却照算，错误原样交给界面；结束后不再占着“正在刷新”', async () => {
  const r = rig(); r.failWith(new Error('磁盘满了'));
  const first = r.refresher.refresh([]); const caught = assert.rejects(first, /磁盘满了/); r.finish(); await caught;
  assert.equal(r.updates(), 0); await assert.rejects(r.refresher.refresh([]), /刚刷新过/);
});
test('定时刷新：正在刷新或刚刷新过就悄悄跳过，不报错；到点才真刷', async () => {
  const r = rig(), errors: unknown[] = [];
  const first = r.refresher.auto(e => errors.push(e)); await settle(); assert.equal(r.calls(), 1);
  await r.refresher.auto(e => errors.push(e)); assert.equal(r.calls(), 1); // 正在刷新
  r.finish(); await first;
  await r.refresher.auto(e => errors.push(e)); assert.equal(r.calls(), 1); // 刚刷新过
  r.tick(60_000); const next = r.refresher.auto(e => errors.push(e)); await settle(); assert.equal(r.calls(), 2); r.finish(); await next;
  assert.deepEqual(errors, []);
  r.tick(60_000); r.failWith(new Error('坏了')); const bad = r.refresher.auto(e => errors.push(e)); await settle(); r.finish(); await bad;
  assert.equal(errors.length, 1);
});
test('IPC：不收任何参数；来源窗口不对一律拒绝，且不启动查询', async () => {
  const r = rig(), main = { url: 'file:///app/index.html' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: main } } as unknown as BrowserWindow;
  const good = { sender: window.webContents, senderFrame: main } as unknown as IpcMainInvokeEvent;
  const trusted = (event: IpcMainInvokeEvent) => trustedSender(event, window, main.url);
  const handler = quotaRefreshHandler(r.refresher, trusted);
  await assert.rejects(handler({ ...good, sender: {} } as unknown as IpcMainInvokeEvent), /来源/);
  await assert.rejects(handler({ ...good, senderFrame: { url: main.url } } as unknown as IpcMainInvokeEvent), /来源/);
  await assert.rejects(handler({ ...good, senderFrame: { url: 'file:///other.html' } } as unknown as IpcMainInvokeEvent), /来源/);
  assert.equal(r.calls(), 0);
  for (const args of [['x'], [{}], [1, 2], [undefined]]) await assert.rejects(handler(good, ...args), /不需要参数/);
  assert.equal(r.calls(), 0);
  const ok = handler(good); await settle(); assert.equal(r.calls(), 1); r.finish(); await ok;
});
test('IPC 通道登记在白名单里，主进程用同一个校验入口接上，查询用核心现有的 queryQuota', async () => {
  assert.equal(channels.quotaRefresh, 'xa:quota-refresh');
  assert.equal(Object.values(channels).filter(v => v === 'xa:quota-refresh').length, 1);
  const main = await readFile(join(root, 'app/main/index.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\(channels\.quotaRefresh, quotaRefreshHandler\(quota, event => trustedSender\(event, window, pageUrl\)\)\)/);
  assert.match(main, /query: \(\) => queryQuota\(\)/);
  assert.match(main, /clearInterval\(quotaTimer\)/);
});
