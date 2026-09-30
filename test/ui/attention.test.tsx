// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import type { ViewJob } from '../../src/core/view-types.ts';
import { fixtureJob, fixtureView } from './fixtures.tsx';
import { ownerAttention } from '../../app/shared/attention.ts';
import { derive } from '../../app/renderer/lib/board.ts';
import { notices, notificationTracker } from '../../app/main/notifications.ts';
import { startDesktop } from '../../app/main/startup.ts';
import { watchRegistry } from '../../app/main/watch.ts';
import { createTray } from '../../app/main/tray.ts';

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (menu: unknown) => menu },
  nativeImage: { createFromBitmap: () => ({ setTemplateImage() {}, isTemplateImage: () => true }) },
  Tray: class {
    setToolTip() {} setTitle() {} setImage() {} setContextMenu() {}
    isDestroyed() { return false; } destroy() {}
  },
}));

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'xa-attention-')); directories.push(path); return path; }
function batch(states: ViewJob['state'][]) {
  const view = fixtureView(); view.jobs = states.map((state, i) => fixtureJob(`member-${i}`, { state }));
  view.batches = [{ id: 'batch', title: '这批任务', summary: '测试', kind: '修复', base: '', started: '', jobs: view.jobs.map(j => j.id) }];
  return view;
}
for (const [states, choose] of [
  [['done', 'done', 'done'], true], [['done', 'done', 'failed'], true],
  [['done', 'done', 'stopped'], true], [['done', 'done', 'lost'], true], [['done', 'running'], false],
] as [ViewJob['state'][], boolean][]) test(`${states.join(' + ')}：看板与共享判定一致，做完或出错不发通知`, () => {
  const view = batch(states), shared = ownerAttention(view).attention;
  expect(shared.some(e => e.type === 'decide')).toBe(choose);
  expect(derive(view).attention).toEqual(shared);
  expect(notices(view)).toEqual([]);
  expect(notices(view).some(n => /等你处理|件等你|等你挑/.test(n.body))).toBe(false);
});

test('验收没过、已采用、已重做、缺失成员和重叠批次沿用看板语义', () => {
  const view = batch(['done', 'failed']);
  view.jobs[0].check = { ok: false, label: '', note: '' };
  expect(ownerAttention(view).attention.map(e => e.type)).toEqual(['check', 'failed']);
  view.jobs[0].check = null; view.jobs[0].decision = { kind: 'adopt', by: 'owner', at: '' };
  expect(ownerAttention(view).attention.map(e => e.type)).toEqual(['failed']);
  view.jobs[1].redo = { by: 'owner', at: '' }; expect(notices(view)).toEqual([]);
  view.jobs = [fixtureJob('member-0')];
  view.batches.push({ ...view.batches[0], id: 'overlap' });
  expect(notices(view)).toEqual([]);
  view.jobs[0].decision = { kind: 'adopt', by: 'lead', at: 't', note: '用它' };
  expect(notices(view)).toHaveLength(1);
  expect(notices(view)[0].target).toEqual({ kind: 'job', id: 'member-0' });
  expect(notices(view)[0].body).toBe('member-0：用了 Codex/模型 那份——用它');
  expect(derive(view).attention).toEqual(ownerAttention(view).attention);
});

for (const raw of ['', '["half', '{}', '[42]']) test(`通知记录损坏 ${JSON.stringify(raw)}：重建基线不补发，之后只发一次`, async () => {
  const dir = await directory(), file = join(dir, 'notification-events.json');
  await writeFile(file, raw);
  const send = vi.fn(), track = await notificationTracker(dir, send), view = batch(['done', 'done', 'failed']);
  await track(view); await track(view); expect(send).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(file, 'utf8')).sort()).toEqual(notices(view).map(n => n.key).sort());
  view.jobs.push(fixtureJob('new', { state: 'lost', title: '断了的' }));
  await Promise.all([track(view), track(view)]); expect(send).not.toHaveBeenCalled();
  view.jobs.push(fixtureJob('picked', { title: '新题', decision: { kind: 'drop', by: 'lead', at: 't', note: '不用' } }));
  await Promise.all([track(view), track(view)]); expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({ key: 'job:picked:lead:t', body: '新题：没用——不用', target: { kind: 'job', id: 'picked' } });
  expect(await readdir(dir)).toEqual(['notification-events.json']);
});

test('损坏通知记录在空看板下也原子修复', async () => {
  const dir = await directory(), file = join(dir, 'notification-events.json'); await writeFile(file, '');
  await (await notificationTracker(dir, vi.fn()))(fixtureView());
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
});

test('先开窗口再读取；通知或登记处读取失败不结束启动，监听仍建立', async () => {
  const calls: string[] = [], error = new Error('登记处损坏');
  await startDesktop({
    openWindow: async () => { calls.push('window'); },
    startNotifications: async () => { calls.push('notifications'); throw error; },
    startWatching: async () => { calls.push('watch'); },
    refresh: async () => { calls.push('read'); throw error; },
    onError: () => { calls.push('error'); },
  });
  expect(calls).toEqual(['window', 'notifications', 'error', 'watch', 'read', 'error']);
});

test('没有文件变化也定期重读；失败后恢复，关闭时清理计时和监听', async () => {
  const home = await directory(), previous = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = home;
  vi.useFakeTimers();
  const publish = vi.fn(), error = vi.fn(), closed = vi.fn(), read = vi.fn(async () => fixtureView());
  read.mockRejectedValueOnce(new Error('暂时读不到'));
  let close: (() => void) | undefined;
  try {
    close = await watchRegistry(() => true, publish, error, read,
      () => Object.assign(new EventEmitter(), { close: closed }) as unknown as FSWatcher);
    await vi.advanceTimersByTimeAsync(5000); expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); expect(publish).toHaveBeenCalledOnce();
    close(); expect(closed).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(2);
  } finally {
    close?.(); if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous;
  }
});


test('菜单栏待处理数量与共享判定一致，唯一运行任务变失联后数字归零', () => {
  vi.useFakeTimers();
  const tray = createTray(vi.fn(), vi.fn()), view = batch(['done', 'done', 'failed']);
  try {
    tray.update(view);
    expect(tray.inspect().attention).toBe(ownerAttention(view).attention.length);
    expect(tray.inspect().attention).toBe(2);
    view.jobs = [fixtureJob('runner', { state: 'running' })]; view.batches = [];
    tray.update(view); expect(tray.inspect().title).toBe('1');
    view.jobs[0].state = 'lost'; tray.update(view);
    expect(tray.inspect()).toMatchObject({ title: '', running: 0, attention: 1 });
    expect(notices(view)).toEqual([]);
  } finally { tray.destroy(); }
  expect(vi.getTimerCount()).toBe(0);
});

test('没有活在跑或排队时，不定时重读', async () => {
  const home = await directory(), previous = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = home;
  vi.useFakeTimers();
  const idle = () => { const v = fixtureView(); v.jobs = v.jobs.filter(j => j.state !== 'running' && j.state !== 'queued'); return v; };
  const read = vi.fn(async () => idle());
  let close: (() => void) | undefined;
  try {
    close = await watchRegistry(() => true, vi.fn(), vi.fn(), read,
      () => Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher);
    await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20000); expect(read).toHaveBeenCalledOnce();
  } finally {
    close?.(); if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous;
  }
});
