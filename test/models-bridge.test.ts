import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { modelsRefresher, modelsRefreshHandler, modelsKeepHandler, modelsScheduler, MODELS_EVERY_MS } from '../app/main/models.ts';
import { channels } from '../app/shared/ipc.ts';
import { root } from './helpers.ts';
import type { ModelsCache } from '../src/core/roster.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const good = {} as IpcMainInvokeEvent;
const trusted = (event: IpcMainInvokeEvent) => event === good;

test('模型刷新桥：验证来源/零参数，正在刷新和一分钟冷却不重复问，失败也冷却', async () => {
  let calls = 0, updates = 0, time = 0, release!: () => void, failure = false;
  const refresh = modelsRefresher({ now: () => time, query: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); if (failure) throw new Error('磁盘不可写'); } }, async () => { updates++; });
  const handler = modelsRefreshHandler(refresh, trusted);
  await assert.rejects(handler({} as IpcMainInvokeEvent), /来源/);
  for (const args of [[1], [undefined], [[], {}]]) await assert.rejects(handler(good, ...args), /不需要参数/);
  assert.equal(calls, 0);
  const first = handler(good); await settle(); assert.equal(calls, 1);
  await assert.rejects(handler(good), /正在刷新/); release(); await first; assert.equal(updates, 1);
  time = 59_999; await assert.rejects(handler(good), /刚刷新/);
  time = 60_000; const second = handler(good); await settle(); release(); await second; assert.equal(calls, 2);
  failure = true; time += 60_000; const third = handler(good); const rejected = assert.rejects(third, /磁盘/); await settle(); release(); await rejected;
  await assert.rejects(handler(good), /刚刷新/); assert.equal(updates, 2);
});

test('模型刷新桥：一分钟内已有 CLI/前次启动写的缓存也不重复问', async () => {
  let calls = 0, time = 59_999;
  const refresh = modelsRefresher({ now: () => time, readCache: async () => ({ at: new Date(0).toISOString(), channels: {} }), query: async () => { calls++; } }, async () => {});
  await assert.rejects(refresh.refresh([]), /刚刷新/); assert.equal(calls, 0);
  time += 60_000; await refresh.refresh([]); assert.equal(calls, 1);
});

test('保留桥：先检查来源、参数个数、通道、列表内容，非法请求不写；并发保存拒绝', async () => {
  const calls: unknown[] = []; let updates = 0, release!: () => void;
  const handler = modelsKeepHandler({ keep: async (channel, models) => { calls.push([channel, models]); await new Promise<void>(resolve => { release = resolve; }); } }, async () => { updates++; }, trusted);
  await assert.rejects(handler({} as IpcMainInvokeEvent, 'codex', []), /来源/);
  for (const args of [[], ['codex'], ['codex', [], true], [null, []], ['constructor', []], ['bad', []], ['codex', null], ['codex', 'gpt-6'],
    ['codex', [3]], ['codex', new Array(1)], ['codex', ['../secret']], ['codex', ['gpt-6', 'gpt-6']], ['codex', Array(501).fill('gpt-6')]]) await assert.rejects(handler(good, ...args));
  assert.deepEqual(calls, []);
  const first = handler(good, 'codex', ['gpt-6.1-sol']); await settle();
  await assert.rejects(handler(good, 'grok', []), /正在保存/); release(); await first;
  assert.deepEqual(calls, [['codex', ['gpt-6.1-sol']]]); assert.equal(updates, 1);
  const second = handler(good, 'grok', []); await settle(); release(); await second; assert.equal(updates, 2);
});

test('后台模型刷新：不阻塞 start，有新缓存跳过，24 小时过期才问，stop 后不再执行', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 100_000, calls = 0;
  let cached: ModelsCache | null = { at: new Date(now).toISOString(), channels: {} };
  const errors: unknown[] = [];
  const scheduler = modelsScheduler({ readCache: async () => cached, now: () => now }, { auto: async () => { calls++; cached = { at: new Date(now).toISOString(), channels: {} }; } }, e => errors.push(e));
  assert.equal(scheduler.start(), undefined); scheduler.start(); await settle(); assert.equal(calls, 0);
  now += MODELS_EVERY_MS; t.mock.timers.tick(MODELS_EVERY_MS); await settle(); assert.equal(calls, 1);
  now += MODELS_EVERY_MS; t.mock.timers.tick(MODELS_EVERY_MS); await settle(); assert.equal(calls, 2);
  scheduler.stop(); now += MODELS_EVERY_MS; t.mock.timers.tick(MODELS_EVERY_MS); await settle(); assert.equal(calls, 2); assert.deepEqual(errors, []);
  cached = null; scheduler.start(); await settle(); assert.equal(calls, 3); scheduler.stop();
});

test('后台模型刷新：等待磁盘时退出不启动查询，错误只交给日志回调', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release!: (v: ModelsCache | null) => void, calls = 0;
  const scheduler = modelsScheduler({ readCache: () => new Promise(resolve => { release = resolve; }) }, { auto: async () => { calls++; } }, () => {});
  scheduler.start(); scheduler.stop(); release(null); await settle(); assert.equal(calls, 0);
  const errors: unknown[] = [];
  const broken = modelsScheduler({ readCache: async () => { throw new Error('读取失败'); } }, { auto: async () => { calls++; } }, error => errors.push(error));
  broken.start(); await settle(); broken.stop(); assert.equal(errors.length, 1); assert.equal(calls, 0);
});

test('桥两层白名单与真实窗口冒烟清单一致，主进程关闭时停定时器', async () => {
  const main = await readFile(join(root, 'app/main/index.ts'), 'utf8');
  const preload = await readFile(join(root, 'app/preload/index.ts'), 'utf8');
  const smoke = await readFile(join(root, 'test/e2e/smoke.ts'), 'utf8');
  for (const key of ['modelsKeep', 'modelsRefresh'] as const) {
    assert.ok(channels[key]); assert.ok(main.includes(`ipcMain.handle(channels.${key}`)); assert.ok(preload.includes(`ipcRenderer.invoke(channels.${key}`)); assert.ok(smoke.includes(`'${key}'`));
  }
  assert.match(main, /modelsRefreshHandler\(models, event => trustedSender/);
  assert.match(main, /modelSchedule\?\.stop\(\)/); assert.match(main, /if \(!e2eHidden\) \{\s+modelSchedule = modelsScheduler/);
});
