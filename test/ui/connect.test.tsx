import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { LEAD_RULE } from '../../src/core/intro.ts';
import type { ConnectStatus } from '../../src/core/intro.ts';
import { connectFixture, fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup(extra: Parameters<typeof fixtureBridge>[0] = {}) {
  localStorage.setItem('xa.settings-page', 'intro');
  window.xa = fixtureBridge(extra);
  render(<Settings close={() => {}} view={fixtureView()} />);
}
const row = async (name: string) => (await screen.findByRole('group', { name }));

test('一键接入：五家按顺序一行一家，标签和按钮跟着状态走；共用的没有按钮', async () => {
  setup();
  const group = (await screen.findByText('一键接入')).closest('.setting-group') as HTMLElement;
  const rows = await within(group).findAllByRole('group');
  expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['Claude', 'Codex', 'Grok', 'Cursor', 'DeepSeek Harness']);
  expect(within(rows[0]).getByText('已接入')).toBeTruthy();
  expect(within(rows[0]).getByRole('button').textContent).toBe('撤下');
  expect(within(rows[1]).getByText('还没接入')).toBeTruthy();
  expect(within(rows[1]).getByRole('button').textContent).toBe('接入');
  expect(within(rows[2]).getByText('和 Claude 共用一份规矩')).toBeTruthy();
  expect(within(rows[2]).queryByRole('button')).toBeNull();
  expect(within(rows[3]).getByText('会写进 ~/.cursor/rules/xagents.mdc（只对家目录下的项目生效）')).toBeTruthy();
  expect(within(rows[3]).getByRole('button').textContent).toBe('接入');
  // DeepSeek Harness 用 DeepSeek 的图标，小字提醒跑 xagents 要主人批准。
  expect(within(rows[4]).getByText('会写进 ~/.dsh/AGENTS.md 末尾（它跑 xagents 时要你点批准）')).toBeTruthy();
  expect(within(rows[4]).getByRole('button').textContent).toBe('接入');
  expect(rows[4].querySelector('[data-icon="deepseek"], .mono-mark[data-brand="deepseek"]')).toBeTruthy();
});

test('没装的那家整行变淡、没有按钮；内容不是最新的给“更新”', async () => {
  const list: ConnectStatus[] = connectFixture();
  list[1] = { ...list[1], state: 'outdated', note: '内容不是最新的，再接入一次就更新' };
  list[3] = { ...list[3], state: 'missing', note: '这台电脑上没找到 Cursor' };
  setup({ connectStatus: vi.fn(async () => list) });
  expect((await row('Codex')).querySelector('button')!.textContent).toBe('更新');
  const cursor = await row('Cursor');
  expect(cursor.classList.contains('setting-row-dim')).toBe(true);
  expect(within(cursor).getByText('没装')).toBeTruthy();
  expect(within(cursor).queryByRole('button')).toBeNull();
});

test('点“接入”先确认：列出要改的文件和那段话原文（纯文字），确认后才走桥', async () => {
  const after = connectFixture().map(s => s.ai === 'codex' ? { ...s, state: 'on' as const, note: '写在 ~/.codex/AGENTS.md 末尾' } : s);
  const connect = vi.fn(async () => after);
  setup({ connect });
  fireEvent.click(within(await row('Codex')).getByRole('button', { name: '接入' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('~/.codex/AGENTS.md');
  const rule = dialog.querySelector('pre')!;
  expect(rule.textContent).toBe(LEAD_RULE);
  expect(rule.querySelector('*')).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '接入' }));
  await waitFor(() => expect(connect).toHaveBeenCalledWith('codex'));
  const codex = await row('Codex');
  await waitFor(() => expect(within(codex).getByText('已接入', { selector: '.chip' })).toBeTruthy());
  expect(within(codex).getByRole('button').textContent).toBe('撤下');
});

test('点“先不改”不接入', async () => {
  const connect = vi.fn(async () => connectFixture());
  setup({ connect });
  fireEvent.click(within(await row('Codex')).getByRole('button', { name: '接入' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '先不改' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(connect).not.toHaveBeenCalled();
});

test('点“撤下”直接走桥，小字换成核心返回的说明（备份在哪）', async () => {
  const after = connectFixture().map(s => s.ai === 'claude' ? { ...s, state: 'off' as const, note: '已撤下 ~/.claude/rules/xagents.md；原文件备份在 /废纸篓/派活工作台-接入备份-claude' } : s.ai === 'grok' ? { ...s, state: 'off' as const } : s);
  const disconnect = vi.fn(async () => after);
  setup({ disconnect });
  fireEvent.click(within(await row('Claude')).getByRole('button', { name: '撤下' }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledWith('claude'));
  expect(await within(await row('Claude')).findByText('已撤下 ~/.claude/rules/xagents.md；原文件备份在 /废纸篓/派活工作台-接入备份-claude')).toBeTruthy();
});

test('接入失败写在这一页最上面，状态不变', async () => {
  setup({ connect: vi.fn(async () => { throw new Error('~/.codex/AGENTS.md 刚被改过，请再试一次。'); }) });
  fireEvent.click(within(await row('Codex')).getByRole('button', { name: '接入' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '接入' }));
  expect((await screen.findByRole('alert')).textContent).toBe('没能接入：~/.codex/AGENTS.md 刚被改过，请再试一次。');
  expect(within(await row('Codex')).getByText('还没接入')).toBeTruthy();
});

test('读不出状态时只写一行原因，不画四行', async () => {
  setup({ connectStatus: vi.fn(async () => { throw new Error('家目录读不了。'); }) });
  expect(await screen.findByText('读不出接入状态：家目录读不了。')).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Claude' })).toBeNull();
});
