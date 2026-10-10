import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { modelNote } from '../../app/renderer/components/ModelPicker.tsx';
import type { View } from '../../src/core/view-types.ts';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); });
type Model = View['models']['channels'][number]['models'][number];
const model = (model: string, shown: string, extra: Partial<Model> = {}): Model =>
  ({ model, who: 'codex', shown, description: null, efforts: ['medium', 'high', 'xhigh'], fast: false, kept: false, builtin: false, fresh: false, gone: false, ...extra });
function modelsView(): View {
  const v = fixtureView();
  v.models = { at: '2026-10-10T02:00:00.000Z', channels: [
    { channel: 'codex', name: 'Codex', icon: 'codex', discoverable: true, at: '2026-10-10T02:00:00.000Z', error: null, models: [
      model('gpt-6-astra', 'GPT-6 Astra', { kept: true, builtin: true, description: 'Frontier intelligence for the most demanding work.' }),
      model('gpt-6.1-sol', 'GPT-6.1 Sol', { who: 'codex-6-1-sol', fresh: true, description: 'Latest workhorse model for coding and everyday work.' }),
      model('gpt-6-luna', 'GPT-6 Luna', { who: 'codex-luna', kept: true, builtin: true, gone: true, efforts: ['high', 'xhigh'] }),
    ] },
    { channel: 'deepseek', name: 'DeepSeek', icon: 'deepseek', discoverable: false, at: null, error: null, models: [
      model('deepseek-v4-pro', 'DeepSeek V4 Pro', { who: 'deepseek', kept: true, builtin: true, efforts: ['high'] })] },
  ] };
  return v;
}
async function open(view = modelsView(), bridge: Parameters<typeof fixtureBridge>[0] = {}) {
  window.xa = fixtureBridge(bridge);
  render(<Settings close={() => {}} view={view} />);
  fireEvent.click(await screen.findByRole('tab', { name: '选手与模型' }));
  await screen.findByText(/关掉的不会被派活/);
}
const group = (name: string) => screen.getByRole('region', { name });

test('modelNote：三档齐全且没有快速版时返回空串', () => {
  expect(modelNote({ efforts: ['medium', 'high', 'xhigh'], fast: false })).toBe('');
});
test('modelNote：强度不全时只列出支持的档位', () => {
  expect(modelNote({ efforts: ['medium'], fast: false })).toBe('只有中档');
  expect(modelNote({ efforts: ['high', 'xhigh'], fast: false })).toBe('只有高档、超高档');
});
test('modelNote：三档齐全且有快速版时只写有快速版', () => {
  expect(modelNote({ efforts: ['medium', 'high', 'xhigh'], fast: true })).toBe('有快速版');
});
test('modelNote：强度不全且有快速版时用间隔点及两侧空格连接', () => {
  expect(modelNote({ efforts: ['high', 'xhigh'], fast: true })).toBe('只有高档、超高档 · 有快速版');
});

test('选手与模型：每家组头有“管理模型”，有新发现的带“新 N”，说明里提一句；保留着但已下线的那一行标“已下线”', async () => {
  await open();
  expect(screen.getByText(/发现了 1 个新模型/)).toBeTruthy();
  const manage = within(group('Codex')).getByRole('button', { name: /管理模型/ });
  expect(manage.textContent).toContain('新 1');
  expect(within(group('DeepSeek')).getByRole('button', { name: /管理模型/ }).textContent).toBe('管理模型');
  expect(within(document.querySelector<HTMLElement>('[data-who="codex-luna"]')!).getByText('已下线')).toBeTruthy();
});
test('管理模型：分“已保留”“未保留”两段列出模型（说明、“新”“已下线”，右边只写例外），勾选保留哪些，保存交给 modelsKeep；没改不能保存', async () => {
  await open();
  fireEvent.click(within(group('Codex')).getByRole('button', { name: /管理模型/ }));
  const dialog = await screen.findByRole('dialog', { name: '管理模型：Codex' });
  expect(within(dialog).getByText(/上次检查/)).toBeTruthy();
  const boxes = within(dialog).getAllByRole('checkbox');
  expect(boxes.map(b => [b.getAttribute('aria-label'), b.getAttribute('aria-checked')])).toEqual([['保留 GPT-6 Astra', 'true'], ['保留 GPT-6 Luna', 'true'], ['保留 GPT-6.1 Sol', 'false']]);
  expect(within(within(dialog).getByRole('region', { name: '已保留' })).getAllByRole('checkbox')).toHaveLength(2);
  expect(within(within(dialog).getByRole('region', { name: '未保留' })).getAllByRole('checkbox')).toHaveLength(1);
  expect(within(dialog).getByText('已保留 2 个')).toBeTruthy(); expect(within(dialog).getByText('共 3 个')).toBeTruthy();
  // 三个模型：不出搜索框。
  expect(within(dialog).queryByRole('searchbox')).toBeNull();
  expect(within(dialog).getByText('Latest workhorse model for coding and everyday work.')).toBeTruthy();
  expect(within(dialog).getByText('新')).toBeTruthy(); expect(within(dialog).getByText('已下线')).toBeTruthy();
  // 右边只写例外：Luna 少一档才写；Astra 三档齐全、没有快速版，什么都不写。
  expect(within(dialog).getByText('只有高档、超高档')).toBeTruthy();
  expect(within(dialog).queryByText(/中档/)).toBeNull();
  const save = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(boxes[2]); fireEvent.click(boxes[1]);
  expect(save.disabled).toBe(false);
  // 概况跟着勾选变；行留在原来那一段，不跳。
  expect(within(dialog).getByText('已保留 2 个')).toBeTruthy();
  expect(within(dialog).getAllByRole('checkbox').map(b => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
  fireEvent.click(save);
  await waitFor(() => expect(window.xa.modelsKeep).toHaveBeenCalledWith('codex', ['gpt-6-astra', 'gpt-6.1-sol']));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '管理模型：Codex' })).toBeNull());
});
test('管理模型：刷新走 modelsRefresh，失败说明原因；没问到时提示用的是上一次的名单；固定的那家没有刷新', async () => {
  const v = modelsView(); v.models.channels[0].error = 'Codex 没登录';
  const modelsRefresh = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('刚检查过，一分钟后再试'));
  await open(v, { modelsRefresh, modelsKeep: vi.fn(async () => { throw new Error('至少要保留一位选手'); }) });
  fireEvent.click(within(group('Codex')).getByRole('button', { name: /管理模型/ }));
  const dialog = await screen.findByRole('dialog', { name: '管理模型：Codex' });
  expect(within(dialog).getByText(/这次没问到（Codex 没登录）/)).toBeTruthy();
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '刷新' })); });
  expect(modelsRefresh).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '刷新' })); });
  expect(within(dialog).getByRole('alert').textContent).toBe('没能刷新：刚检查过，一分钟后再试');
  fireEvent.click(within(dialog).getAllByRole('checkbox')[0]);
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '保存' })); });
  expect(within(dialog).getByRole('alert').textContent).toBe('没能保存：至少要保留一位选手');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  fireEvent.click(within(group('DeepSeek')).getByRole('button', { name: /管理模型/ }));
  const fixed = await screen.findByRole('dialog', { name: '管理模型：DeepSeek' });
  expect(within(fixed).getByText('这一家的模型是固定的，不会自动发现')).toBeTruthy();
  expect(within(fixed).queryByRole('button', { name: '刷新' })).toBeNull();
});
test('管理模型：模型多时出搜索框，按名字筛；Cursor 的模型按家族排到一起、新的在前，名字前有家族图标，有快速版的写出来', async () => {
  const v = modelsView();
  const names: [string, string, Partial<Model>?][] = [['gpt-5.4', 'GPT-5.4 1M', { fast: true }], ['claude-opus-5', 'Claude Opus 5 1M'], ['grok-4.7', 'Grok 4.7', { kept: true, who: 'cursor-grok' }], ['claude-opus-5-5', 'Claude Opus 5.5 1M'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol 1M'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['gpt-5.5', 'GPT-5.5 1M'], ['claude-opus-4-8', 'Claude Opus 4.8 1M']];
  v.models.channels.push({ channel: 'cursor', name: 'Cursor', icon: 'cursor', discoverable: true, at: '2026-10-10T02:00:00.000Z', error: null, models: names.map(([id, shown, extra]) => model(id, shown, { who: 'cursor-' + id, ...extra })) });
  await open(v);
  fireEvent.click(within(group('Cursor')).getByRole('button', { name: /管理模型/ }));
  const dialog = await screen.findByRole('dialog', { name: '管理模型：Cursor' });
  const shown = () => within(dialog).getAllByRole('checkbox').map(b => b.getAttribute('aria-label')!.replace('保留 ', ''));
  expect(shown()).toEqual(['Grok 4.7', 'Claude Sonnet 5.5', 'Claude Opus 5.5 1M', 'Claude Opus 5 1M', 'Claude Opus 4.8 1M', 'Claude Haiku 5.5', 'GPT-5.6 Sol 1M', 'GPT-5.5 1M', 'GPT-5.4 1M']);
  expect(within(dialog).getByText('有快速版')).toBeTruthy();
  expect(dialog.querySelectorAll('.mp-row .logo').length).toBe(9);
  const search = within(dialog).getByRole('searchbox', { name: '搜索模型' });
  fireEvent.change(search, { target: { value: 'OPUS' } });
  expect(shown()).toEqual(['Claude Opus 5.5 1M', 'Claude Opus 5 1M', 'Claude Opus 4.8 1M']);
  expect(within(dialog).queryByRole('region', { name: '已保留' })).toBeNull();
  fireEvent.change(search, { target: { value: '没有这个' } });
  expect(within(dialog).getByText('没有名字里带这几个字的模型')).toBeTruthy();
  // 筛掉的行，勾选状态还在：概况不变。
  expect(within(dialog).getByText('已保留 1 个')).toBeTruthy();
});
