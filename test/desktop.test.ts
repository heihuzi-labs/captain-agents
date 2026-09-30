import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { readIcon } from '../app/main/icons.ts';
import { httpsLink, productionCsp, securePreferences, trustedSender } from '../app/main/security.ts';
import { loadBounds, saveBounds } from '../app/main/window-state.ts';
import { watchRegistry } from '../app/main/watch.ts';
import { settingsActions, settingsPatch } from '../app/main/actions.ts';
import { SLIM_EVERY_MS, SLIM_FIRST_MS, slimScheduler } from '../app/main/slim.ts';
import { SLIM_CHOICES } from '../app/renderer/lib/storage.ts';
import { RANGE_CHOICES } from '../app/renderer/lib/dashboard.ts';
import { ranges, rangeLabel } from '../src/core/dashboard.ts';
import { RUN_CHOICES, STOP_CHOICES } from '../app/renderer/lib/limits.ts';
import { LIMIT_CAPS, quotaStops } from '../src/core/settings.ts';
import { slimDays } from '../src/core/settings.ts';
import { effectiveWorkers } from '../src/core/policy.ts';
import { buildView } from '../src/core/view.ts';
import { writeAtomic, writeJson as atomicJson } from '../src/core/fsx.ts';
import { derive } from '../app/renderer/lib/board.ts';
import type { Job } from '../src/core/job.ts';
import { until } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';

async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await atomicJson(file, value);
}

async function registry(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'xa-desktop-unit-'));
  const previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, batch: '', project: '测试', repo: '/unused', base: 'test', worktree: '/unused', branch: 'test', who: 'codex',
  model: 'test', effort: 'high', mode: 'read-only', kind: '实现', title: '测试', state: 'done',
  created: new Date().toISOString(), ended: new Date().toISOString(), ...extra,
});

test('buildView 只读登记处、兼容旧记录并仅暴露应用所需字段', async t => {
  const home = await registry(t);
  const empty = await buildView();
  assert.deepEqual(empty.jobs, []);
  assert.deepEqual(await readdir(home), []);
  const source = job('running', { state: 'running' }); // 没有存活进程，也不能在读取时落盘改状态。
  await writeJson(join(home, 'jobs/running/job.json'), source);
  await writeJson(join(home, 'batches/batch.json'), { id: 'batch', title: '题目', kind: '实现', started: source.created, base: 'test', jobs: ['running'] });
  await writeJson(join(home, 'config.json'), { board: { columns: { running: '#123456' } } });
  await writeAtomic(join(home, 'jobs/running/report.md'), '报告');
  const before = await readFile(join(home, 'jobs/running/job.json'), 'utf8');
  const view = await buildView();
  assert.equal(view.jobs[0].state, 'lost'); // 只在看板里显示成失联，记录不改。
  assert.equal(view.theme?.columns.running, '#123456');
  assert.equal(await readFile(join(home, 'jobs/running/job.json'), 'utf8'), before);
  assert.ok(!(await readdir(home)).includes('board'));
  assert.equal(view.jobs[0].summary, source.title);
  assert.equal(view.batches[0].summary, '题目');
  assert.equal(view.jobs[0].base, source.base);
  assert.deepEqual(Object.keys(view.jobs[0]).sort(), 'id batch project who model effort kind title state base started ended seconds typical check decision summary redo sleeps comments activity realCheck rating timing'.split(' ').sort());
});

test('桌面视图保留批次归并、失联、验收失败、旧决定默认负责人和 24 小时边界', async t => {
  const home = await registry(t), now = Date.now();
  const jobs = [job('run', { state: 'running', pid: process.pid }), job('wait-a', { batch: 'wait' }), job('wait-b', { batch: 'wait' }),
    job('lost', { state: 'lost' }), job('used', { decision: { kind: 'adopt' } }),
    job('old', { decision: { kind: 'drop' }, ended: new Date(now - 90_000_000).toISOString() }),
    job('check', { verify: { ok: false, steps: [] } })];
  for (const j of jobs) await writeJson(join(home, 'jobs', j.id, 'job.json'), j);
  await writeJson(join(home, 'batches/wait.json'), { id: 'wait', jobs: ['wait-a', 'wait-b'], started: jobs[0].created });
  const view = await buildView();
  const columns = derive(view);
  assert.equal(columns.running.length, 1);
  assert.equal(columns.attention.length, 3);
  assert.equal(columns.done.length, 1);
  assert.equal(view.jobs.find(j => j.id === 'used')?.decision?.by, 'lead');
});

test('图标协议拒绝路径穿越、编码、符号链接目录和文件，只读 PNG', async t => {
  const home = await registry(t);
  const icons = join(home, 'icons'); await mkdir(icons, { recursive: true });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await writeAtomic(join(icons, 'codex.png'), png);
  assert.deepEqual(Buffer.from(await readIcon('xa-icon://icons/codex.png', home)), png);
  for (const url of ['xa-icon://icons/../secret.png', 'xa-icon://icons/%2e%2e/secret.png', 'xa-icon://icons/a%2fb.png',
    'xa-icon://other/codex.png', 'xa-icon://icons/codex.png?x', 'file:///secret.png', 'xa-icon://icons/x.svg']) {
    await assert.rejects(readIcon(url, home));
  }
  await writeAtomic(join(home, 'outside.png'), png);
  await symlink(join(home, 'outside.png'), join(icons, 'escape.png'));
  await assert.rejects(readIcon('xa-icon://icons/escape.png', home));
  await rm(icons, { recursive: true }); await symlink(home, icons);
  await assert.rejects(readIcon('xa-icon://icons/outside.png', home));
});

test('安全白名单：拒绝外部进程、子 frame 和页面伪造，只允许 HTTPS 外链', async () => {
  assert.deepEqual(securePreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
  assert.equal(httpsLink('https://example.invalid/page'), 'https://example.invalid/page');
  for (const url of ['http://example.invalid', 'javascript:alert(1)', 'file:///tmp/x', 'https://user:password@example.invalid']) assert.equal(httpsLink(url), null);
  const mainFrame = { url: 'file:///app/index.html' }, webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  assert.equal(trustedSender(event, window, mainFrame.url), true);
  assert.equal(trustedSender(event, null, mainFrame.url), false);
  assert.equal(trustedSender({ ...event, sender: {} } as IpcMainInvokeEvent, window, mainFrame.url), false);
  assert.equal(trustedSender({ ...event, senderFrame: { url: mainFrame.url } } as IpcMainInvokeEvent, window, mainFrame.url), false);
  assert.equal(trustedSender(event, window, 'file:///other.html'), false);
  const html = await readFile(resolve('app/renderer/index.html'), 'utf8');
  assert.ok(html.includes(productionCsp));
  assert.doesNotMatch(productionCsp, /unsafe-inline|unsafe-eval|https?:/);
});

test('窗口大小存在独立用户目录，损坏设置回退', async t => {
  const home = await registry(t), userData = join(home, 'electron');
  await saveBounds(userData, { x: 40, y: 50, width: 1000, height: 700 });
  assert.deepEqual(await loadBounds(userData), { x: 40, y: 50, width: 1000, height: 700 });
  await writeJson(join(userData, 'window.json'), { width: 10, height: 2 });
  assert.deepEqual(await loadBounds(userData), { width: 1120, height: 760 });
});

test('递归监视单元测试：合并连续变更，无窗口时不计算，关闭后不再推送', async t => {
  const home = await registry(t);
  let opened = false, reads = 0, published = 0;
  const errors: unknown[] = [];
  // 沙箱里的 macOS FSEvents 可能返回 EMFILE；这里用事件替身验证调度，真实 fs.watch 由 Electron 冒烟验证。
  const events = new Map<string, () => void>();
  let closed = 0;
  const close = await watchRegistry(() => opened, () => published++, error => errors.push(error), async () => { reads++; return buildView(); },
    (directory, options, changed) => {
      assert.equal(options.recursive, true); events.set(directory, changed);
      return Object.assign(new EventEmitter(), { close() { closed++; } }) as FSWatcher;
    });
  assert.deepEqual([...events.keys()], ['jobs', 'batches', 'cache'].map(dir => join(home, dir)));
  t.after(close);
  await writeJson(join(home, 'jobs/one/job.json'), job('one'));
  events.get(join(home, 'jobs'))!();
  await sleep(450); assert.equal(reads, 0);
  opened = true;
  for (let i = 0; i < 3; i++) {
    await writeJson(join(home, 'jobs/one/job.json'), job('one', { title: String(i) }));
    events.get(join(home, 'jobs'))!();
  }
  await until(async () => published, value => value === 1, 2000);
  assert.equal(reads, 1);
  await writeJson(join(home, 'cache/quota.json'), {});
  events.get(join(home, 'cache'))!();
  await until(async () => published, value => value === 2, 2000);
  await writeJson(join(home, 'batches/b.json'), { id: 'b', jobs: ['one'], started: new Date().toISOString() });
  events.get(join(home, 'batches'))!();
  await until(async () => published, value => value === 3, 2000);
  close();
  assert.equal(closed, 3);
  await writeJson(join(home, 'jobs/one/job.json'), job('one'));
  events.get(join(home, 'jobs'))!();
  await sleep(450); assert.equal(published, 3); assert.deepEqual(errors, []);
});

test('buildView：每件活带项目名和打分（只有当前一版、标签好坏由核心分好），项目名单合并登记处和任务里出现的，读取不落盘', async t => {
  const home = await registry(t);
  await writeJson(join(home, 'projects/画布.json'), { name: '画布', repo: '/unused' });
  await writeJson(join(home, 'projects/没活的项目.json'), { name: '没活的项目', repo: '/unused' });
  const at = new Date().toISOString();
  const rated = job('rated', { project: '派活工作台', rating: { score: 4, good: '一次做对', improve: '偏慢', tags: ['一次做对', '偏慢', '别的'], at, by: 'lead',
    previous: [{ score: 2, tags: ['需要返工'], at, by: 'lead' }] } });
  const external = job('external', { project: '画布', rating: { external: '网络不好', tags: [], at, by: 'lead' } });
  const plain = job('plain', { project: '画布' });
  for (const j of [rated, external, plain]) await writeJson(join(home, 'jobs', j.id, 'job.json'), j);
  const before = (await readdir(home, { recursive: true })).sort();
  const view = await buildView();
  assert.deepEqual(view.projects, [{ name: '没活的项目', label: '没活的项目', archived: false }, { name: '派活工作台', label: '派活工作台', archived: false }, { name: '画布', label: '画布', archived: false }].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
  const byId = (id: string) => view.jobs.find(j => j.id === id)!;
  assert.equal(byId('rated').project, '派活工作台'); assert.equal(byId('plain').project, '画布');
  assert.deepEqual(byId('rated').rating, { score: 4, good: '一次做对', improve: '偏慢', at,
    tags: [{ tag: '一次做对', kind: 'good' }, { tag: '偏慢', kind: 'bad' }, { tag: '别的', kind: 'other' }] }, '不带改分前的历史，不带 by');
  assert.deepEqual(byId('external').rating, { external: '网络不好', at, tags: [] });
  assert.equal(byId('plain').rating, null);
  assert.deepEqual((await readdir(home, { recursive: true })).sort(), before, '读取不写文件');
});
test('buildView：老记录没有 project 字段也不出错，项目名是空串', async t => {
  const home = await registry(t);
  const { project: _unused, ...old } = job('old'); void _unused;
  await writeJson(join(home, 'jobs/old/job.json'), old);
  const view = await buildView();
  assert.equal(view.jobs[0].project, ''); assert.deepEqual(view.projects, []);
});

test('设置校验：storage 开关和天数（7、14、30）都对才收，天数不对、缺字段、多字段、格式不对一律拒绝', () => {
  for (const days of slimDays) for (const slim of [true, false]) assert.deepEqual(settingsPatch({ storage: { slim, days } }), { storage: { slim, days } });
  assert.deepEqual(settingsPatch({ storage: { slim: false, days: 30 }, keepAwake: false }), { storage: { slim: false, days: 30 }, keepAwake: false });
  const bad: unknown[] = [
    { slim: true, days: 10 }, { slim: true, days: 0 }, { slim: true, days: -7 }, { slim: true, days: '14' }, { slim: true, days: 14.5 }, { slim: true, days: null }, { slim: true, days: 365 },
    { slim: 'yes', days: 14 }, { slim: 1, days: 14 }, { slim: true }, { days: 14 }, {},
    { slim: true, days: 14, extra: 1 }, { slim: true, days: 14, force: true },
    null, undefined, 'on', 14, true, [], [{ slim: true, days: 14 }], Object.create({ slim: true, days: 14 }),
  ];
  for (const storage of bad) assert.throws(() => settingsPatch({ storage }), /自动清理/, JSON.stringify(storage));
  assert.throws(() => settingsPatch({ storage: { slim: true, days: 14 }, slimDays: 14 }), /不认识/, '别的没见过的字段照旧拒绝');
  assert.throws(() => settingsPatch({ slim: true, days: 14 }), /不认识/);
  assert.equal(JSON.stringify(SLIM_CHOICES), JSON.stringify(slimDays), '设置页的天数选项和核心的 slimDays 是同一组');
});
test('设置校验：archivedProjects 须为合法项目名的数组，最多 200 个；不是数组、坏名字、超过 200 个、未知字段都拒绝', async () => {
  assert.deepEqual(settingsPatch({ archivedProjects: ['画布', '派活工作台'] }), { archivedProjects: ['画布', '派活工作台'] });
  assert.deepEqual(settingsPatch({ archivedProjects: [] }), { archivedProjects: [] });
  assert.deepEqual(settingsPatch({ archivedProjects: ['项目_A', 'canvas-1', '甲'] }), { archivedProjects: ['项目_A', 'canvas-1', '甲'] });
  assert.deepEqual(settingsPatch({ archivedProjects: ['a'.repeat(64), '项'.repeat(64)] }), { archivedProjects: ['a'.repeat(64), '项'.repeat(64)] });
  assert.deepEqual(settingsPatch({ archivedProjects: ['画布', '画布'] }), { archivedProjects: ['画布', '画布'] }, '重复的名字这里收下，写盘时由核心去重');
  assert.equal(settingsPatch({ archivedProjects: Array.from({ length: 200 }, (_, i) => 'n' + i) }).archivedProjects?.length, 200);
  assert.deepEqual(settingsPatch({ archivedProjects: ['画布'], keepAwake: false }), { archivedProjects: ['画布'], keepAwake: false });
  for (const value of [null, undefined, {}, '画布', 1, true, { length: 1, 0: '画布' }]) assert.throws(() => settingsPatch({ archivedProjects: value }), /归档名单/, JSON.stringify(value));
  const hole: unknown[] = []; hole[1] = '画布';
  for (const name of ['', '.', '..', 'a b', 'a/b', '../x', 'a.b', 'a'.repeat(65), '名 字', 1, null, undefined]) assert.throws(() => settingsPatch({ archivedProjects: [name] }), /名字不合法/, JSON.stringify(name));
  assert.throws(() => settingsPatch({ archivedProjects: hole }), /名字不合法/);
  assert.throws(() => settingsPatch({ archivedProjects: Array.from({ length: 201 }, (_, i) => 'n' + i) }), /最多 200/);
  assert.throws(() => settingsPatch({ archivedProjects: ['画布'], extra: 1 }), /不认识/);
  assert.throws(() => settingsPatch({ archived: ['画布'] }), /不认识/);
  const writes: unknown[] = [];
  const base = { keepAwake: true, notifications: true, appearance: 'system' as const, storage: { slim: true, days: 14 as const }, workers: effectiveWorkers(undefined) };
  const actions = settingsActions({ readSettings: async () => base, writeSettings: async patch => { writes.push(patch); }, getLogin: () => false, setLogin: () => {} }, async () => {});
  await actions.set([{ archivedProjects: ['画布', '派活工作台'] }]);
  assert.deepEqual(writes, [{ archivedProjects: ['画布', '派活工作台'] }]);
  await assert.rejects(actions.set([{ archivedProjects: '画布' }]), /归档名单/);
  await assert.rejects(actions.set([{ archivedProjects: ['a b'] }]), /名字不合法/);
  await assert.rejects(actions.set([{ archivedProjects: Array.from({ length: 201 }, (_, i) => 'n' + i) }]), /最多 200/);
  await assert.rejects(actions.set([{ archivedProjects: ['画布'], extra: 1 }]), /不认识/);
  assert.deepEqual(writes, [{ archivedProjects: ['画布', '派活工作台'] }], '校验没过不写');
});
test('设置保存：storage 写进去之后才立刻清理一次；保存失败、没改 storage 时不清理；读设置带着 storage', async () => {
  let cleaned = 0, fail = false;
  const base = { keepAwake: true, notifications: true, appearance: 'system' as const, storage: { slim: true, days: 14 as const }, workers: effectiveWorkers(undefined) };
  const writes: unknown[] = [];
  const actions = settingsActions({ readSettings: async () => base, writeSettings: async patch => { if (fail) throw new Error('存不了'); writes.push(patch); }, getLogin: () => false, setLogin: () => {}, storageChanged: () => { cleaned++; } }, async () => {});
  assert.deepEqual((await actions.get([])).storage, { slim: true, days: 14 });
  await actions.set([{ storage: { slim: false, days: 30 } }]);
  assert.deepEqual(writes, [{ storage: { slim: false, days: 30 } }]); assert.equal(cleaned, 1);
  await actions.set([{ notifications: false }]); assert.equal(cleaned, 1, '没改 storage 不清理');
  await assert.rejects(actions.set([{ storage: { slim: true, days: 10 } }]), /自动清理/); assert.equal(cleaned, 1); assert.equal(writes.length, 2, '校验没过不写');
  fail = true;
  await assert.rejects(actions.set([{ storage: { slim: true, days: 7 } }]), /存不了/); assert.equal(cleaned, 1, '保存失败不清理');
});
test('定时清理：启动 1 分钟后一次，之后每 6 小时一次；现在就清理；同时只跑一次；出错只交给日志；退出时清掉定时器', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  let runs = 0, release: (() => void) | undefined, fail = false, hold = false;
  const errors: unknown[] = [];
  const scheduler = slimScheduler({
    run: async () => { runs++; if (fail) throw new Error('清不了'); if (hold) await new Promise<void>(resolve => { release = resolve; }); },
    onError: error => { errors.push(error); },
  });
  assert.equal(SLIM_FIRST_MS, 60_000); assert.equal(SLIM_EVERY_MS, 6 * 3600_000);
  scheduler.start(); scheduler.start();
  t.mock.timers.tick(SLIM_FIRST_MS - 1); await settle(); assert.equal(runs, 0, '不到 1 分钟不跑');
  t.mock.timers.tick(1); await settle(); assert.equal(runs, 1, '启动 1 分钟后跑第一次');
  t.mock.timers.tick(SLIM_EVERY_MS - 1); await settle(); assert.equal(runs, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(runs, 2, '之后每 6 小时一次');
  t.mock.timers.tick(SLIM_EVERY_MS); await settle(); assert.equal(runs, 3);
  await scheduler.now(); assert.equal(runs, 4, '改设置：立刻一次');
  // 正在跑时又改了设置：不并行，等这次跑完再补一次。
  hold = true;
  const first = scheduler.now(); await settle(); assert.equal(runs, 5);
  void scheduler.now(); void scheduler.now(); await settle(); assert.equal(runs, 5, '正在跑，不并行');
  hold = false; release!(); await first; await settle(); await settle(); assert.equal(runs, 6, '跑完后补一次，让新设置生效');
  // 出错：只交给 onError，不抛出、不影响下一次。
  fail = true; await scheduler.now(); assert.equal(errors.length, 1); assert.match(String(errors[0]), /清不了/);
  fail = false; await scheduler.now(); assert.equal(errors.length, 1);
  const after = runs;
  scheduler.stop();
  t.mock.timers.tick(SLIM_EVERY_MS * 3); await settle(); await scheduler.now(); assert.equal(runs, after, '退出后不再跑');
});
test('定时清理：退出前还没到 1 分钟，定时器也被清掉，一次都不跑', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let runs = 0;
  const scheduler = slimScheduler({ run: async () => { runs++; }, onError: () => {} });
  scheduler.start(); scheduler.stop();
  t.mock.timers.tick(SLIM_FIRST_MS + SLIM_EVERY_MS); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(runs, 0);
});

test('表现页的时间范围选项和核心 dashboard.ts 是同一组（窗口里不直接引核心那份）', () => {
  assert.deepEqual(RANGE_CHOICES.map(r => [r.id, r.label]), ranges.map(r => [r, rangeLabel[r]]));
});

test('派活限制：设置页的选项和核心是同一组；主进程只收上限以内、两项齐全的值', () => {
  assert.deepEqual(RUN_CHOICES, Array.from({ length: LIMIT_CAPS.maxRunning }, (_, i) => i + 1));
  assert.deepEqual(STOP_CHOICES, [...quotaStops]); assert.equal(Math.max(...STOP_CHOICES), LIMIT_CAPS.quotaStop);
  assert.deepEqual(settingsPatch({ limits: { maxRunning: 3, quotaStop: 60 } }), { limits: { maxRunning: 3, quotaStop: 60 } });
  for (const bad of [{ maxRunning: 7, quotaStop: 80 }, { maxRunning: 0, quotaStop: 80 }, { maxRunning: 2.5, quotaStop: 80 }, { maxRunning: 3, quotaStop: 90 }, { maxRunning: 3, quotaStop: 55 }, { maxRunning: 3 }, { maxRunning: 3, quotaStop: 60, extra: 1 }, [3, 60], null]) {
    assert.throws(() => settingsPatch({ limits: bad }), JSON.stringify(bad));
  }
});
