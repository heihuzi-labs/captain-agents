// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { builtinEnvironments } from 'vitest/runtime';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobActions, settingsActions, settingsPatch } from '../../app/main/actions.ts';
import { notificationTracker, notices } from '../../app/main/notifications.ts';
import type { Settings as Values, SettingsPatch } from '../../app/shared/ipc.ts';
import { cleanComment } from '../../src/core/comments.ts';
import { effectiveWorkers } from '../../src/core/policy.ts';
import type { ViewJob } from '../../src/core/view-types.ts';
import { fixtureView, fixtureJob, fixtureBridge } from './fixtures.tsx';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'xa-d3-notifications-')); directories.push(path); return path; }
function core() {
  return { readJob: vi.fn(async (id: string) => { if (id === 'missing') throw Error('不存在'); return { id }; }), decide: vi.fn(async () => {}), requestRedo: vi.fn(async () => {}), stop: vi.fn(async () => {}), comment: vi.fn(async () => {}), checkComment: cleanComment };
}
test('写操作校验数量、类型、任务存在和决定范围，再用固定来源调用核心', async () => {
  const mock = core(), action = jobActions(mock);
  for (const args of [[], ['x'], ['x', 'other'], [123, 'adopt'], ['../x', 'adopt'], ['', 'drop'], ['x'.repeat(201), 'drop'], ['x', 'adopt', 'injected'], ['missing', 'adopt']]) await expect(action('decide', args)).rejects.toThrow();
  for (const name of ['redo', 'stop'] as const) for (const args of [[], [null], ['x', true], ['missing']]) await expect(action(name, args)).rejects.toThrow();
  expect(mock.decide).not.toHaveBeenCalled(); expect(mock.stop).not.toHaveBeenCalled();
  await action('decide', ['任务-1', 'adopt']);
  expect(mock.decide).toHaveBeenCalledWith('任务-1', 'adopt', '主人在应用里选的', 'owner');
  await action('redo', ['x']); expect(mock.requestRedo).toHaveBeenCalledWith('x');
  await action('stop', ['x']); expect(mock.stop).toHaveBeenCalledWith('x');
});
test('同一任务跨通道互斥，不同任务可同时处理，失败后释放', async () => {
  let finish: (() => void) | undefined;
  const mock = core(); mock.decide = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const action = jobActions(mock), pending = action('decide', ['x', 'adopt']);
  await Promise.resolve();
  await expect(action('stop', ['x'])).rejects.toThrow('正在处理');
  await expect(action('redo', ['x'])).rejects.toThrow('正在处理');
  await action('stop', ['y']); finish?.(); await pending;
  mock.stop = vi.fn(async () => { throw Error('失败'); });
  await expect(action('stop', ['x'])).rejects.toThrow('失败');
  await action('redo', ['x']);
});
test('拒绝登记记录与任务号不一致', async () => {
  const mock = core(); mock.readJob = vi.fn(async () => ({ id: 'other' }));
  await expect(jobActions(mock)('stop', ['x'])).rejects.toThrow('不一致');
  expect(mock.stop).not.toHaveBeenCalled();
});
test('设置拒绝未知字段、非布尔和非法颜色，允许恢复默认', () => {
  for (const patch of [null, [], 'x', { path: '/outside' }, { notifications: 'false' }, { openAtLogin: 1 }, { keepAwake: null }, { columns: [] }, { columns: { running: '#abc' } }, { columns: { running: 'red' } }, { columns: { invalid: '#abcdef' } }, JSON.parse('{"__proto__":{}}')]) expect(() => settingsPatch(patch)).toThrow();
  expect(settingsPatch({ columns: {}, notifications: false })).toEqual({ columns: {}, notifications: false });
  expect(settingsPatch({ columns: { done: '#12AbEf' } })).toEqual({ columns: { done: '#12AbEf' } });
});
test('设置只通过核心写入，自启只交给系统，数量错误不产生副作用', async () => {
  const mock = { readSettings: vi.fn(async () => ({ keepAwake: true, notifications: true, appearance: 'system' as const, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 12, quotaStop: 80 as const }, workers: effectiveWorkers(undefined), networkAllowed: false })), writeSettings: vi.fn(async () => {}), setNetworkAllowed: vi.fn(async () => {}), getLogin: () => false, setLogin: vi.fn() }, updated = vi.fn(async () => {});
  const settings = settingsActions(mock, updated);
  await expect(settings.get([1])).rejects.toThrow();
  await expect(settings.set([])).rejects.toThrow();
  await expect(settings.set([{ notifications: true }, 2])).rejects.toThrow();
  await settings.set([{ openAtLogin: true }]);
  expect(mock.setLogin).toHaveBeenCalledWith(true); expect(mock.writeSettings).not.toHaveBeenCalled();
  await settings.set([{ keepAwake: false, columns: { done: '#123456' }, notifications: false, openAtLogin: false }]);
  expect(mock.writeSettings).toHaveBeenCalledWith({ keepAwake: false, columns: { done: '#123456' }, notifications: false });
  expect(updated).toHaveBeenCalledTimes(2);
});
test('联网的专用入口：参数个数和类型先查，内容交给核心；普通设置补丁不认联网字段', async () => {
  const mock = { readSettings: vi.fn(async () => ({ keepAwake: true, notifications: true, appearance: 'system' as const, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 12, quotaStop: 80 as const }, workers: effectiveWorkers(undefined), networkAllowed: false })), writeSettings: vi.fn(async () => {}), setNetworkAllowed: vi.fn(async () => {}), getLogin: () => false, setLogin: vi.fn() }, updated = vi.fn(async () => {});
  const settings = settingsActions(mock, updated);
  for (const bad of [[], ['true'], [1], [true, 1]]) await expect(settings.allowNetwork(bad)).rejects.toThrow();
  expect(mock.setNetworkAllowed).not.toHaveBeenCalled(); expect(updated).not.toHaveBeenCalled();
  expect((await settings.allowNetwork([true])).networkAllowed).toBe(false);
  expect(mock.setNetworkAllowed).toHaveBeenCalledWith(true);
  expect(updated).toHaveBeenCalledTimes(1);
  expect(() => settingsPatch({ network: {} })).toThrow(); expect(() => settingsPatch({ networkAllowed: false })).toThrow();
});
test('启动只建立基线，后续结论各一次；重启、反复推送和关开通知不补发；做完和出错不发', async () => {
  const path = await directory(), send = vi.fn(), track = await notificationTracker(path, send), view = fixtureView();
  view.jobs = [fixtureJob('old', { title: '旧题', decision: { kind: 'adopt', by: 'lead', at: 't0', note: '旧结论' } })];
  await track(view); expect(send).not.toHaveBeenCalled();
  view.jobs.push(fixtureJob('new', { title: '新题', decision: { kind: 'adopt', by: 'lead', at: 't1', note: '新结论' } }));
  await Promise.all([track(view), track(view)]);
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].target).toEqual({ kind: 'job', id: 'new' });
  expect(send.mock.calls[0][0].body).toBe('新题：用了 Codex/模型 那份——新结论');
  expect(JSON.parse(await readFile(join(path, 'notification-events.json'), 'utf8'))).toContain('job:new:lead:t1');
  const restarted = await notificationTracker(path, send); await restarted(view); await restarted(view); expect(send).toHaveBeenCalledTimes(1);
  view.settings.notifications = false;
  view.jobs.push(fixtureJob('muted', { title: '静音', decision: { kind: 'drop', by: 'lead', at: 'tm', note: '关掉时定的' } }));
  await restarted(view);
  view.settings.notifications = true; await restarted(view); expect(send).toHaveBeenCalledTimes(1);
  view.jobs.push(fixtureJob('error', { state: 'failed' }), fixtureJob('finished'));
  await restarted(view); expect(send).toHaveBeenCalledTimes(1);
  expect(notices(view).some(n => /等你处理|件等你|等你挑/.test(n.body))).toBe(false);
});
test('做完、出错、失联、验收没过和主人自己的“用这份”都不发通知；负责人拍板才发结论', async () => {
  const view = fixtureView(); view.jobs = [fixtureJob('a'), fixtureJob('b', { state: 'running' })];
  view.batches = [{ id: 'batch', title: '修复题', summary: '', kind: '修复', base: '', started: '', jobs: ['a', 'b'] }];
  expect(notices(view)).toEqual([]);
  view.jobs[1].state = 'done';
  expect(notices(view)).toEqual([]);
  view.jobs[0].check = { ok: false, label: '没过', note: '' };
  expect(notices(view)).toEqual([]);
  view.jobs[1].state = 'failed'; expect(notices(view)).toEqual([]);
  view.jobs[1].state = 'lost'; expect(notices(view)).toEqual([]);
  view.jobs[0].decision = { kind: 'adopt', by: 'owner', at: 'owner', note: '主人在应用里选的' };
  view.jobs[1].redo = { by: 'owner', at: '' };
  expect(notices(view)).toEqual([]);
  view.jobs[0].check = null; view.jobs[0].decision = { kind: 'adopt', by: 'lead', at: 'lead', note: '这份能用' };
  expect(notices(view).map(n => n.body)).toEqual(['a：用了 Codex/模型 那份——这份能用']);
  expect(notices(view)[0].target).toEqual({ kind: 'job', id: 'a' });
});
test('成员缺失的批次按单家结论通知；启动已有错误、失联、验收未过也不通知', async () => {
  const view = fixtureView(); view.jobs = [fixtureJob('a', { title: '剩下的', decision: { kind: 'drop', by: 'lead', at: 't', note: '不要' } })];
  view.batches = [{ id: 'batch', title: '修复', summary: '', kind: '', base: '', started: '', jobs: ['a', 'missing'] }];
  expect(notices(view).map(n => [n.key, n.target.kind, n.body])).toEqual([['job:a:lead:t', 'job', '剩下的：没用——不要']]);
  view.jobs.push(fixtureJob('failed', { state: 'failed' }), fixtureJob('lost', { state: 'lost' }), fixtureJob('check', { check: { ok: false, label: '', note: '' } }));
  const send = vi.fn(), track = await notificationTracker(await directory(), send);
  await track(view); await track(view); expect(send).not.toHaveBeenCalled();
});

test('只有一家的批次按单家通知，点击直达该任务', () => {
  const view = fixtureView(); view.jobs = [fixtureJob('one', { title: '单家题', decision: { kind: 'adopt', by: 'lead', at: 't', note: '就它' } })];
  view.batches = [{ id: 'single-batch', title: '单家', summary: '', kind: '', base: '', started: '', jobs: ['one'] }];
  expect(notices(view)).toHaveLength(1);
  expect(notices(view)[0].target).toEqual({ kind: 'job', id: 'one' });
  expect(notices(view)[0].body).toBe('单家题：用了 Codex/模型 那份——就它');
});
test('一批里多件同时拍板合成一条；先后拍板则各发新的那一件；结论只取前 40 字', async () => {
  const path = await directory(), send = vi.fn(), track = await notificationTracker(path, send), view = fixtureView();
  view.jobs = [fixtureJob('a', { batch: 'b', title: '甲', who: 'codex' }), fixtureJob('b', { batch: 'b', title: '乙', who: 'grok' })];
  view.batches = [{ id: 'b', title: '修复题', summary: '', kind: '修复', base: '', started: '', jobs: ['a', 'b'] }];
  await track(view); expect(send).not.toHaveBeenCalled();
  view.jobs[0].decision = { kind: 'adopt', by: 'lead', at: 't1', note: '这份清楚' };
  view.jobs[1].decision = { kind: 'drop', by: 'lead', at: 't2', note: '那份跑不过' };
  await track(view);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].target).toEqual({ kind: 'batch', id: 'b' });
  expect(send.mock.calls[0][0].body).toBe('修复题：用了 Codex/模型 那份——这份清楚；没用——那份跑不过');
  expect(send.mock.calls[0][0].body).not.toMatch(/等你处理|件等你/);
  const later = fixtureView();
  later.jobs = [fixtureJob('c', { batch: 'c', title: '先', who: 'codex' }), fixtureJob('d', { batch: 'c', title: '后', who: 'grok' })];
  later.batches = [{ id: 'c', title: '另一批', summary: '', kind: '修复', base: '', started: '', jobs: ['c', 'd'] }];
  const sendLater = vi.fn(), trackLater = await notificationTracker(await directory(), sendLater);
  await trackLater(later);
  later.jobs[0].decision = { kind: 'adopt', by: 'lead', at: 't3', note: '先定这家' };
  await trackLater(later);
  later.jobs[1].decision = { kind: 'drop', by: 'lead', at: 't4', note: '后定的不用' };
  await trackLater(later);
  expect(sendLater).toHaveBeenCalledTimes(2);
  expect(sendLater.mock.calls[0][0].target).toEqual({ kind: 'job', id: 'c' });
  expect(sendLater.mock.calls[1][0]).toMatchObject({ target: { kind: 'job', id: 'd' }, body: '后：没用——后定的不用' });
  const long = fixtureView();
  long.jobs = [fixtureJob('long', { title: '长结论', decision: { kind: 'adopt', by: 'lead', at: 't', note: '字'.repeat(41) } })];
  expect(notices(long)[0].body).toBe(`长结论：用了 Codex/模型 那份——${'字'.repeat(40)}`);
});
test('主人自己点的“用这份”不发通知', async () => {
  const view = fixtureView(), send = vi.fn(), track = await notificationTracker(await directory(), send);
  view.jobs = [fixtureJob('mine', { title: '待定' })];
  await track(view);
  view.jobs[0].decision = { kind: 'adopt', by: 'owner', at: 'now', note: '主人在应用里选的' };
  await track(view);
  expect(send).not.toHaveBeenCalled();
  expect(notices(view)).toEqual([]);
});

test('留言通道：校验数量、任务号、文字长度和字符，只以主人身份调用核心；与其他操作互斥', async () => {
  const mock = core(), action = jobActions(mock);
  for (const args of [[], ['x'], ['x', 'a', 'b'], [5, '你好'], ['../x', '你好'], ['x', 5], ['x', ''], ['x', '   '], ['x', 'a\u0000b'], ['x', 'a\tb'], ['x', '文'.repeat(501)], ['missing', '你好']]) await expect(action('comment', args)).rejects.toThrow();
  expect(mock.comment).not.toHaveBeenCalled();
  await action('comment', ['任务-1', '  你好\n世界  ']);
  expect(mock.comment).toHaveBeenCalledWith('任务-1', '你好\n世界', 'owner');
  let finish: (() => void) | undefined; mock.comment = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = action('comment', ['x', '一']); await new Promise(resolve => setTimeout(resolve, 0));
  await expect(action('comment', ['x', '二'])).rejects.toThrow('正在处理'); await expect(action('stop', ['x'])).rejects.toThrow('正在处理');
  finish?.(); await pending; mock.comment = vi.fn(async () => {}); await action('comment', ['x', '三']);
});
test('负责人回复主人留言时通知一次；连续两条负责人留言、启动时已有的回复、关掉通知都不发', async () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString();
  const view = fixtureView(); view.jobs = [fixtureJob('talk', { state: 'running', comments: [{ by: 'owner', text: '早', at: at(1) }, { by: 'lead', text: '旧回复', at: at(2) }] })];
  const send = vi.fn(), track = await notificationTracker(await directory(), send);
  await track(view); expect(send).not.toHaveBeenCalled();
  view.jobs = [fixtureJob('talk', { state: 'running', comments: [...view.jobs[0].comments, { by: 'owner', text: '再问', at: at(3) }] })];
  await track(view); expect(send).not.toHaveBeenCalled();
  view.jobs = [fixtureJob('talk', { state: 'running', comments: [...view.jobs[0].comments, { by: 'lead', text: '这是第二条回复，写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', at: at(4) }] })];
  await Promise.all([track(view), track(view)]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].target).toEqual({ kind: 'job', id: 'talk' });
  expect(send.mock.calls[0][0].body).toMatch(/^Codex · talk：负责人回复了你的留言：这是第二条回复.*…$/);
  view.jobs = [fixtureJob('talk', { state: 'running', comments: [...view.jobs[0].comments, { by: 'lead', text: '连着补一条', at: at(5) }] })];
  await track(view); expect(send).toHaveBeenCalledTimes(1);
  view.settings.notifications = false;
  view.jobs = [fixtureJob('talk', { state: 'running', comments: [...view.jobs[0].comments, { by: 'owner', text: '又问', at: at(6) }, { by: 'lead', text: '关着通知的回复', at: at(7) }] })];
  await track(view); view.settings.notifications = true; await track(view); expect(send).toHaveBeenCalledTimes(1);
  expect(notices(view).filter(n => n.key.includes(':reply:'))).toHaveLength(3);
});

// 本文件其余用例测主进程，要用 Node 自己的环境；下面的界面用例只在这一组里开一个 jsdom 页面，界面模块等页面有了再加载。
describe('界面：文案与设置', () => {
  let teardown: ((global: typeof globalThis) => unknown) | undefined;
  let ui: typeof import('@testing-library/react'), board: typeof import('../../app/renderer/components/Board.tsx');
  let settings: typeof import('../../app/renderer/components/Settings.tsx'), lib: typeof import('../../app/renderer/lib/board.ts');
  beforeAll(async () => {
    teardown = (await builtinEnvironments.jsdom.setup(globalThis, { jsdom: {} })).teardown;
    [ui, board, settings, lib] = await Promise.all([import('@testing-library/react'), import('../../app/renderer/components/Board.tsx'),
      import('../../app/renderer/components/Settings.tsx'), import('../../app/renderer/lib/board.ts')]);
  });
  afterEach(() => { ui.cleanup(); localStorage.clear(); });
  afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await teardown?.(globalThis); });
  function attention(view: ReturnType<typeof fixtureView>) {
    const [entry] = lib.derive(view).attention;
    return ui.render(<board.AttentionCard entry={entry} workers={view.workers} open={() => {}} />);
  }
  test('失联卡片写“做到一半停了”，不写工程说法', () => {
    const view = fixtureView(); view.jobs = [fixtureJob('lost', { state: 'lost' })];
    const { container } = attention(view);
    expect(container.textContent).toContain('中途断了'); expect(container.textContent).toContain('做到一半停了');
    expect(container.textContent).not.toMatch(/进程|看管|日志|副本|分支|提交/);
  });
  test.each([
    [[null, null], '2 家做完了'],
    [[{ ok: true, label: '通过', note: '' }, null], '2 家做完了，1 家通过验收'],
    [[{ ok: true, label: '通过', note: '' }, { ok: true, label: '通过', note: '' }], '2 家都做完了，都通过验收'],
  ] as [ViewJob['check'][], string][])('批次验收小结 %j → %s', (checks, text) => {
    const view = fixtureView(); view.jobs = checks.map((check, i) => fixtureJob('j' + i, { batch: 'b', who: i ? 'grok' : 'codex', check }));
    view.batches = [{ id: 'b', title: '一批', summary: '', kind: '实现', base: '', started: '', jobs: ['j0', 'j1'] }];
    const { container } = attention(view);
    expect(board.checkSummary(view.jobs)).toBe(text);
    expect(container.querySelector('.card-note')?.textContent).toBe(text);
    expect(container.textContent).not.toContain('0 家');
  });
  test('取色：拖动时不保存，松手才存；保存中来的新值存完再存最新的一个；保存时不禁用整组', async () => {
    const calls: SettingsPatch[] = [], finishes: (() => void)[] = [];
    let current: Values = { keepAwake: true, notifications: true, appearance: 'system' as const, openAtLogin: false, storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 as const }, workers: effectiveWorkers(undefined), networkAllowed: false };
    window.xa = fixtureBridge({ setSettings: vi.fn((patch: SettingsPatch) => new Promise<Values>(resolve => {
      calls.push(patch); finishes.push(() => { current = { ...current, ...patch, workers: { ...current.workers, ...patch.workers } }; resolve(current); });
    })) });
    const { act, fireEvent, render, screen, waitFor } = ui;
    render(<settings.Settings close={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: '看板颜色' }));
    const color = await screen.findByLabelText('进行中') as HTMLInputElement;
    for (const value of ['#111111', '#222222']) fireEvent.input(color, { target: { value } });
    expect(color.value).toBe('#222222'); expect(calls).toHaveLength(0);
    fireEvent.change(color, { target: { value: '#333333' } });
    expect(calls).toEqual([{ columns: { running: '#333333' } }]);
    expect(color.closest('fieldset')!.disabled).toBe(false); expect(color.disabled).toBe(false);
    fireEvent.change(color, { target: { value: '#444444' } });
    fireEvent.change(screen.getByLabelText('已完成'), { target: { value: '#555555' } });
    fireEvent.change(color, { target: { value: '#666666' } });
    expect(calls).toHaveLength(1); expect(color.value).toBe('#666666');
    await act(async () => finishes[0]());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ columns: { running: '#666666', done: '#555555' } });
    expect(color.value).toBe('#666666');
    await act(async () => finishes[1]());
    expect(calls).toHaveLength(2); expect(current.columns).toEqual({ running: '#666666', done: '#555555' });
    expect(color.value).toBe('#666666'); expect((screen.getByLabelText('已完成') as HTMLInputElement).value).toBe('#555555');
  });
  test('焦点框只在键盘操作时出现：根元素记最近一次是键盘还是鼠标，带 ⌘ 的快捷键不算', async () => {
    const { fireEvent, render, screen } = ui;
    window.xa = fixtureBridge(); render(<settings.Settings close={() => {}} />);
    await screen.findByLabelText('系统通知');
    const root = document.documentElement;
    expect(root.dataset.input).toBe('pointer');
    fireEvent.keyDown(document, { key: ',', metaKey: true }); expect(root.dataset.input).toBe('pointer');
    fireEvent.keyDown(document, { key: 'Tab' }); expect(root.dataset.input).toBe('keyboard');
    fireEvent.mouseDown(document.body); expect(root.dataset.input).toBe('pointer');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(root.dataset.input).toBe('keyboard');
    fireEvent.pointerDown(document.body); expect(root.dataset.input).toBe('pointer');
  });
});
