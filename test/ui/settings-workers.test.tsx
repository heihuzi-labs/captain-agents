import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Settings as Values, SettingsPatch } from '../../app/shared/ipc.ts';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); });

type Workers = Values['workers'];
// 假的设置存取：先记下每次保存，按约定“选手逐个整体替换”合并；hold 时保存一直挂着，由测试放行；reject 时保存被核心拒绝。
function setup({ view = fixtureView(), workers, reject, hold }: { view?: ReturnType<typeof fixtureView>; workers?: Workers; reject?: string; hold?: boolean } = {}) {
  let current: Values = { keepAwake: true, notifications: true, appearance: 'system' as const, openAtLogin: false, storage: { slim: true, days: 14 }, limits: { maxRunning: 6, quotaStop: 80 as const }, workers: structuredClone(workers ?? view.settings.workers) };
  const release: (() => void)[] = [];
  const apply = (patch: SettingsPatch) => { current = { ...current, ...patch, workers: { ...current.workers, ...patch.workers } }; return structuredClone(current); };
  const setSettings = vi.fn((patch: SettingsPatch) => reject ? Promise.reject(new Error(reject))
    : hold ? new Promise<Values>(resolve => release.push(() => resolve(apply(patch)))) : Promise.resolve(apply(patch)));
  window.xa = fixtureBridge({ getSettings: vi.fn(async () => structuredClone(current)), setSettings });
  render(<Settings close={() => {}} view={view} />);
  return { view, setSettings, release };
}
const row = (who: string) => document.querySelector<HTMLElement>(`[data-who="${who}"]`)!;
const control = (who: string, name: string) => within(row(who)).getByRole('checkbox', { name }) as HTMLButtonElement;
const power = (who: string) => within(row(who)).getByRole('switch', { name: '启用' }) as HTMLButtonElement;
const on = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';
const names = (who: string) => [...row(who).querySelectorAll('[role=checkbox],[role=switch]')].map(item => item.getAttribute('aria-label'));
// 打开“选手与模型”这一页。
const ready = async () => { fireEvent.click(await screen.findByRole('tab', { name: '选手与模型' })); await screen.findByText(/关掉的不会被派活/); };
const all = ['medium', 'high', 'xhigh'];

test('按厂家分组（Codex、Grok、Cursor、DeepSeek），组内一张对齐的表；表头只出现一次；强度只列能选的，快速版只在支持时出现', async () => {
  const view = fixtureView();
  view.roster[0].efforts = ['high', 'xhigh'];   // Codex 只能选高档、超高档，也没有快速版
  view.quota = [
    { name: 'Codex', icon: 'codex', plan: 'pro', at: null, bars: [{ label: '周额度', used: 31, reset: null }] },
    { name: 'Grok', icon: 'grok', plan: null, at: null, bars: [{ label: '本期额度', used: null, reset: null }] },
    { name: 'Cursor', icon: 'cursor', plan: 'pro', at: null, bars: [{ label: '自家模型池', used: 8, reset: null }, { label: '其他模型池', used: 47, reset: null }] },
  ];
  setup({ view }); await ready();
  // 分页：通用、选手与模型、看板颜色
  expect(within(screen.getByRole('tablist', { name: '设置分页' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['通用', '选手与模型', '看板颜色', '接入 AI']);
  // 分组：按 roster 首次出现的顺序，Cursor 三个模型在同一组
  const groups = [...document.querySelectorAll<HTMLElement>('.setting-group')].filter(g => g.getAttribute('aria-label')); // 最上面的“派活限制”不是厂家组
  expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Codex', 'Grok', 'Cursor', 'DeepSeek']);
  expect(groups.map(g => [...g.querySelectorAll<HTMLElement>('[data-who]')].map(r => r.dataset.who))).toEqual([['codex', 'codex-luna'], ['grok'], ['cursor-grok', 'cursor-opus', 'cursor-sonnet'], ['deepseek', 'deepseek-flash']]);
  // 组头：厂家小图标 + 名字；右边淡色写套餐和用得最多的池；查不到就不写用量
  expect(groups.map(g => g.querySelector('.setting-group-head > span:nth-child(2)')!.textContent)).toEqual(['Codex', 'Grok', 'Cursor', 'DeepSeek']);
  // DeepSeek 按用量扣自己的余额，简单版不查，组头不写用量
  expect(groups.map(g => g.querySelector('.wk-quota')!.textContent)).toEqual(['pro · 本周用了 31%', '', 'pro · 其他池用了 47%', '']);
  expect(groups.every(g => g.querySelector('.setting-group-head img,.setting-group-head .mono-mark'))).toBe(true);
  // 表头只有一份，六列；每一行也是六格，列才对得齐
  const header = document.querySelectorAll('.wk-cols');
  expect(header).toHaveLength(1);
  expect([...header[0].children].map(c => c.textContent)).toEqual(['模型', '中档', '高档', '超高档', '快速版', '启用']);
  expect(header[0].children[4].getAttribute('title')).toBe('同一个模型，跑在更快的机器上，额度按两倍扣');
  for (const r of document.querySelectorAll('[data-who]')) expect(r.children).toHaveLength(6);
  // 不再有浏览器自带的方形勾选框，也没有每行三行的旧写法
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(document.querySelector('.ident')).toBeNull();
  // 模型名；Cursor 里的行在模型名前带模型家族的小图标，Codex、Grok 组不带
  expect(row('codex').querySelector('.wk-model')!.textContent).toBe('模型');
  expect(row('cursor-opus').querySelector('.wk-model')!.textContent).toBe('Opus');
  expect(row('cursor-opus').querySelector('.wk-model img,.wk-model .mono-mark')).not.toBeNull();
  expect(row('cursor-grok').querySelector('.wk-model img,.wk-model .mono-mark')).not.toBeNull();
  expect(row('codex').querySelector('.wk-model img,.wk-model .mono-mark')).toBeNull();
  expect(row('grok').querySelector('.wk-model img,.wk-model .mono-mark')).toBeNull();
  // 每行的控件
  expect(names('codex')).toEqual(['高档', '超高档', '启用']);
  expect(names('grok')).toEqual(['中档', '高档', '超高档', '快速版', '启用']);
  expect(names('cursor-sonnet')).toEqual(['中档', '高档', '超高档', '启用']);
  // 强度列固定：Codex 没有“中档”时，那一格是空的，“高档”仍在第三格
  expect(row('codex').children[1].children).toHaveLength(0);
  expect(row('codex').children[2].getAttribute('aria-label')).toBe('高档');
  expect(row('cursor-sonnet').children[4].children).toHaveLength(0);     // 不支持快速版：空格，不写字
  expect(row('cursor-sonnet').children[4].textContent).toBe('');
  // 全开时所有强度都勾着，快速版按存的值；控件是勾选点和开关
  expect(control('grok', '中档').getAttribute('role')).toBe('checkbox');
  expect(on(control('grok', '中档'))).toBe(true); expect(on(control('grok', '快速版'))).toBe(true);
  expect(on(power('grok'))).toBe(true);
});

test('没有选手名单时不画“选手与模型”这一页（设置其余部分照常）', async () => {
  window.xa = fixtureBridge(); render(<Settings close={() => {}} />);
  await screen.findByLabelText('系统通知');
  expect(within(screen.getByRole('tablist', { name: '设置分页' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['通用', '看板颜色', '接入 AI']);
});

test('关掉、打开、改强度、开关快速版，都发出这位选手的整份设置', async () => {
  const { setSettings } = setup(); await ready();
  const grok = (patch: object) => ({ workers: { 'cursor-grok': { enabled: true, efforts: all, fast: true, ...patch } } });
  fireEvent.click(power('cursor-grok'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(grok({ enabled: false })));
  fireEvent.click(power('cursor-grok'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(grok({ enabled: true })));
  fireEvent.click(control('cursor-grok', '中档'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(grok({ efforts: ['high', 'xhigh'] })));
  fireEvent.click(control('cursor-grok', '中档'));   // 再勾回来：始终按 中档→高档→超高档 排好
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(grok({ efforts: all })));
  fireEvent.click(control('cursor-grok', '快速版'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(grok({ fast: false })));
  await waitFor(() => expect(on(control('cursor-grok', '快速版'))).toBe(false));
  fireEvent.click(control('cursor-grok', '快速版'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(grok({ fast: true })));
  expect(setSettings).toHaveBeenCalledTimes(6);
  for (const call of setSettings.mock.calls) expect(Object.keys(call[0])).toEqual(['workers']);   // 一次只带 workers，不夹带别的项
});

test('保存中来的多项改动合并成一次再存，选手之间互不覆盖', async () => {
  const { setSettings, release } = setup({ hold: true }); await ready();
  fireEvent.click(power('grok'));
  expect(setSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(control('cursor-opus', '快速版')); fireEvent.click(control('cursor-opus', '高档')); fireEvent.click(control('codex', '超高档'));
  expect(setSettings).toHaveBeenCalledTimes(1);                                   // 保存没完成前不再发
  expect(power('grok').disabled).toBe(false);                                     // 不禁用整组
  expect(on(control('cursor-opus', '高档'))).toBe(false);                         // 界面先显示新值
  await act(async () => release[0]());
  await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(2));
  expect(setSettings.mock.calls[1][0]).toEqual({ workers: {
    'cursor-opus': { enabled: true, efforts: ['medium', 'xhigh'], fast: false },
    codex: { enabled: true, efforts: ['medium', 'high'], fast: false },
  } });
  await act(async () => release[1]());
  expect(on(power('grok'))).toBe(false);
  expect(on(control('cursor-opus', '高档'))).toBe(false);
});

test('最后一位开着的选手不能关：开关点不了，悬停说明原因；有人重新打开后又能关', async () => {
  const { setSettings } = setup(); await ready();
  for (const who of ['codex', 'codex-luna', 'grok', 'cursor-grok', 'cursor-opus', 'deepseek', 'deepseek-flash']) {
    expect(power(who).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(power(who));
    await waitFor(() => expect(on(power(who))).toBe(false));
  }
  expect(setSettings).toHaveBeenCalledTimes(7);
  const last = power('cursor-sonnet');
  expect(on(last)).toBe(true); expect(last.getAttribute('aria-disabled')).toBe('true'); expect(last.title).toBe('至少要留一位选手');
  fireEvent.click(last);
  expect(setSettings).toHaveBeenCalledTimes(7); expect(on(last)).toBe(true);
  for (const who of ['codex', 'grok']) expect(power(who).hasAttribute('title')).toBe(false);
  fireEvent.click(power('codex'));
  await waitFor(() => expect(on(power('codex'))).toBe(true));
  await waitFor(() => expect(power('cursor-sonnet').getAttribute('aria-disabled')).toBeNull());   // 有两位开着，最后一位的锁解开
  expect(power('cursor-sonnet').hasAttribute('title')).toBe(false);
  expect(power('codex').getAttribute('aria-disabled')).toBeNull();
});

test('每位选手至少留一种强度：最后一个勾不能取消，悬停说明原因', async () => {
  const workers = fixtureView().settings.workers; workers.grok.efforts = ['high'];
  const { setSettings } = setup({ workers }); await ready();
  const only = control('grok', '高档');
  expect(on(only)).toBe(true); expect(only.getAttribute('aria-disabled')).toBe('true'); expect(only.title).toBe('至少要留一种强度');
  fireEvent.click(only);
  expect(setSettings).not.toHaveBeenCalled(); expect(on(only)).toBe(true);
  expect(control('grok', '中档').hasAttribute('aria-disabled')).toBe(false);
  expect(control('codex', '高档').hasAttribute('aria-disabled')).toBe(false);   // 别的选手不受影响
  fireEvent.click(control('grok', '中档'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ workers: { grok: { enabled: true, efforts: ['medium', 'high'], fast: true } } }));
  await waitFor(() => expect(control('grok', '高档').hasAttribute('aria-disabled')).toBe(false));   // 有两个勾，锁解开
  fireEvent.click(control('grok', '中档'));
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ workers: { grok: { enabled: true, efforts: ['high'], fast: true } } }));
  await waitFor(() => expect(control('grok', '高档').getAttribute('aria-disabled')).toBe('true'));
});

test('关掉的模型：整行变淡，强度和快速版点不动、保留原值；重新打开后还原', async () => {
  const workers = fixtureView().settings.workers; workers['cursor-opus'] = { enabled: false, efforts: ['high'], fast: true };
  const { setSettings } = setup({ workers }); await ready();
  const grey = () => ['中档', '高档', '超高档', '快速版'].map(name => control('cursor-opus', name));
  expect(grey().every(c => c.disabled)).toBe(true);
  expect(grey().map(on)).toEqual([false, true, false, true]);
  expect(row('cursor-opus').dataset.off).toBe('true'); expect(power('cursor-opus').disabled).toBe(false);   // 开关本身还能点
  expect(control('cursor-grok', '中档').disabled).toBe(false);                                            // 别的模型照常
  fireEvent.click(grey()[1]); fireEvent.click(grey()[3]);                                                  // 灰的点不动
  expect(setSettings).not.toHaveBeenCalled();
  fireEvent.click(power('cursor-opus'));
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ workers: { 'cursor-opus': { enabled: true, efforts: ['high'], fast: true } } }));
  await waitFor(() => expect(grey().some(c => c.disabled)).toBe(false));
  expect(grey().map(on)).toEqual([false, true, false, true]); expect(row('cursor-opus').dataset.off).toBeUndefined();
  fireEvent.click(power('cursor-opus'));   // 关的时候也带着原值，不会把强度重置
  await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ workers: { 'cursor-opus': { enabled: false, efforts: ['high'], fast: true } } }));
});

test('保存失败：退回原值，并在这一页顶部用一句话写原因；下一次保存成功后提示消失', async () => {
  const { setSettings } = setup({ reject: "Error invoking remote method 'xa:settings-set': Error: 主人只允许 Grok 用高档。" });
  await ready();
  fireEvent.click(power('grok')); fireEvent.click(control('grok', '中档'));
  expect(on(power('grok'))).toBe(false);   // 先显示新值
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('没能保存：主人只允许 Grok 用高档。');
  expect(alert.nextElementSibling!.textContent).toContain('关掉的不会被派活');   // 写在这一页的最顶部
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(on(power('grok'))).toBe(true);                                        // 都退回原值
  expect(on(control('grok', '中档'))).toBe(true); expect(row('grok').dataset.off).toBeUndefined();
  expect(setSettings).toHaveBeenCalledTimes(1);
  setSettings.mockImplementation(async patch => ({ keepAwake: true, notifications: true, appearance: 'system' as const, openAtLogin: false, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 6, quotaStop: 80 as const }, workers: { ...fixtureView().settings.workers, ...patch.workers } }));
  fireEvent.click(control('cursor-grok', '快速版'));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(() => expect(on(control('cursor-grok', '快速版'))).toBe(false));
});

test('别项保存失败，原因写在最上面（各页都看得到），不写成选手的提示', async () => {
  const { setSettings } = setup({ reject: '磁盘满了。' });
  fireEvent.click(await screen.findByLabelText('系统通知'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('保存失败：磁盘满了。');
  expect(setSettings).toHaveBeenCalledWith({ notifications: false });
  expect(screen.getByLabelText('系统通知').getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: '选手与模型' }));
  expect(screen.getAllByRole('alert')).toHaveLength(1);   // 换到选手页，同一条提示仍在页面最上面
});
