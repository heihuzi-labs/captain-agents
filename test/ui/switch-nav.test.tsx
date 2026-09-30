import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CheckDot, SideNavLayout, Switch } from '../../app/renderer/ui/index.ts';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { fixtureBridge, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); });

test('Switch：role=switch、有可访问名；点击切换；禁用点不动；锁住时可聚焦、悬停写原因、点了没反应', () => {
  const change = vi.fn();
  const { rerender } = render(<Switch label="系统通知" checked={false} onChange={change} />);
  const toggle = screen.getByRole('switch', { name: '系统通知' });
  expect(toggle.tagName).toBe('BUTTON'); expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle); expect(change).toHaveBeenLastCalledWith(true);
  rerender(<Switch label="系统通知" checked onChange={change} />);
  fireEvent.click(screen.getByRole('switch')); expect(change).toHaveBeenLastCalledWith(false);
  expect(change).toHaveBeenCalledTimes(2);
  rerender(<Switch label="系统通知" checked onChange={change} disabled />);
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('switch')); expect(change).toHaveBeenCalledTimes(2);
  rerender(<Switch label="系统通知" checked onChange={change} locked="至少要留一位选手" />);
  const locked = screen.getByRole('switch') as HTMLButtonElement;
  expect(locked.disabled).toBe(false); expect(locked.getAttribute('aria-disabled')).toBe('true'); expect(locked.title).toBe('至少要留一位选手');
  locked.focus(); expect(document.activeElement).toBe(locked);
  fireEvent.click(locked); expect(change).toHaveBeenCalledTimes(2);
});

test('CheckDot：role=checkbox、勾选状态用 aria-checked 表达，带对号图形，操作同 Switch', () => {
  const change = vi.fn();
  render(<><CheckDot label="中档" checked onChange={change} /><CheckDot label="高档" checked={false} onChange={change} locked="至少要留一种强度" /></>);
  const [a, b] = screen.getAllByRole('checkbox');
  expect(a.getAttribute('aria-checked')).toBe('true'); expect(a.querySelector('svg path')).not.toBeNull();
  fireEvent.click(a); expect(change).toHaveBeenCalledWith(false);
  fireEvent.click(b); expect(change).toHaveBeenCalledTimes(1); expect(b.title).toBe('至少要留一种强度');
});

function Nav() {
  const [id, setId] = useState('a');
  return <SideNavLayout label="分页" items={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }, { id: 'c', label: '丙' }]} value={id} onChange={setId}><p>内容 {id}</p></SideNavLayout>;
}
test('SideNavLayout：竖排页签，上下键切换并把焦点跟过去（首尾循环，Home、End 跳头尾）；只有选中的页签在 Tab 序列里', () => {
  render(<Nav />);
  const tab = (name: string) => screen.getByRole('tab', { name });
  expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('vertical');
  expect(tab('甲').getAttribute('aria-selected')).toBe('true'); expect(tab('乙').tabIndex).toBe(-1); expect(tab('甲').tabIndex).toBe(0);
  expect(screen.getByRole('tabpanel').textContent).toBe('内容 a'); expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('甲').id);
  tab('甲').focus();
  fireEvent.keyDown(tab('甲'), { key: 'ArrowDown' });
  expect(tab('乙').getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tab('乙')); expect(screen.getByRole('tabpanel').textContent).toBe('内容 b');
  fireEvent.keyDown(tab('乙'), { key: 'ArrowUp' }); expect(document.activeElement).toBe(tab('甲'));
  fireEvent.keyDown(tab('甲'), { key: 'ArrowUp' }); expect(document.activeElement).toBe(tab('丙'));   // 循环
  fireEvent.keyDown(tab('丙'), { key: 'ArrowDown' }); expect(document.activeElement).toBe(tab('甲'));
  fireEvent.keyDown(tab('甲'), { key: 'End' }); expect(tab('丙').getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(tab('丙'), { key: 'Home' }); expect(tab('甲').getAttribute('aria-selected')).toBe('true');
  fireEvent.click(tab('乙')); expect(screen.getByRole('tabpanel').textContent).toBe('内容 b');
});

test('设置窗口：焦点落在当前分页上、Esc 关闭；记得上次的分页，记不住（存储不可用）也能用', async () => {
  window.xa = fixtureBridge();
  const close = vi.fn();
  const view = fixtureView();
  const first = render(<Settings close={close} view={view} />);
  await screen.findByLabelText('系统通知');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: '通用' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(screen.getByRole('tab', { name: '选手与模型' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  first.unmount();
  render(<Settings close={close} view={view} />);
  expect((await screen.findByRole('tab', { name: '选手与模型' })).getAttribute('aria-selected')).toBe('true');   // 记得上次
  cleanup();
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('存储不可用'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储不可用'); });
  render(<Settings close={close} view={view} />);
  fireEvent.click(await screen.findByRole('tab', { name: '看板颜色' }));
  expect(screen.getByRole('tab', { name: '看板颜色' }).getAttribute('aria-selected')).toBe('true'); expect(screen.getByLabelText('进行中')).toBeTruthy();
  get.mockRestore(); set.mockRestore();
});
