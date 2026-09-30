import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoreMenu } from '../../app/renderer/ui/MoreMenu.tsx';
import type { MoreMenuHandle } from '../../app/renderer/ui/MoreMenu.tsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const items = () => ['第一项', '第二项', '第三项'].map(label => ({ label, onSelect: vi.fn() }));
const trigger = () => screen.getByRole('button', { name: '更多操作：项目' });
const key = (value: string) => fireEvent.keyDown(document.activeElement!, { key: value });

test('点击打开，说明是纯文字；点外面或窗口失焦关闭', () => {
  render(<MoreMenu label="更多操作：项目" items={[{ label: '归档', note: '<img src=x>说明', onSelect: vi.fn() }]} />);
  expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger());
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('menu').querySelector('img')).toBeNull();
  expect(screen.getByText('<img src=x>说明')).toBeTruthy();
  fireEvent.click(document.body); expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger()); fireEvent.blur(window); expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger()); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
});

test.each(['Enter', ' ', 'ArrowDown'])('%s 打开并选第一项，Esc 关闭还焦点', input => {
  render(<MoreMenu label="更多操作：项目" items={items()} />);
  act(() => trigger().focus()); key(input);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '第一项' }));
  key('Escape'); expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger());
});

test('上下循环、Home/End，回车执行后关闭，Tab 关闭回到按钮继续正常导航', () => {
  const choices = items(); render(<MoreMenu label="更多操作：项目" items={choices} />);
  fireEvent.click(trigger());
  const focused = (name: string) => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name }));
  key('ArrowUp'); focused('第三项'); key('ArrowDown'); focused('第一项');
  key('ArrowDown'); focused('第二项'); key('End'); focused('第三项'); key('Home'); focused('第一项');
  key('Enter'); expect(choices[0].onSelect).toHaveBeenCalledTimes(1); expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger());
  fireEvent.click(trigger()); expect(key('Tab')).toBe(true); expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

test('空格和鼠标执行都只调用一次并关闭菜单；点击打开按钮也能关', () => {
  const choices = items(); render(<MoreMenu label="更多操作：项目" items={choices} />);
  fireEvent.click(trigger()); key(' '); expect(choices[0].onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger()); fireEvent.click(screen.getByRole('menuitem', { name: '第二项' }));
  expect(choices[1].onSelect).toHaveBeenCalledTimes(1); expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger()); fireEvent.click(trigger()); expect(screen.queryByRole('menu')).toBeNull();
});

test('不同入口同一时间只开一个，卸载清理不影响后来菜单', () => {
  const first = render(<MoreMenu label="第一菜单" items={items()} />);
  render(<MoreMenu label="第二菜单" items={items()} />);
  const a = screen.getByRole('button', { name: '第一菜单' }), b = screen.getByRole('button', { name: '第二菜单' });
  fireEvent.click(a); fireEvent.click(b);
  expect(screen.getAllByRole('menu')).toHaveLength(1); expect(screen.getByRole('menu', { name: '第二菜单' })).toBeTruthy();
  expect(a.getAttribute('aria-expanded')).toBe('false');
  first.unmount(); expect(screen.getByRole('menu', { name: '第二菜单' })).toBeTruthy();
  cleanup(); render(<MoreMenu label="更多操作：项目" items={items()} />); fireEvent.click(trigger());
  expect(screen.getAllByRole('menu')).toHaveLength(1);
});

test('指定位置和按钮右对齐；窗口各边、缩小后都向内收（模拟布局尺寸）', () => {
  const ref = createRef<MoreMenuHandle>();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('more-menu') ? new DOMRect(0, 0, 200, 100) : new DOMRect(280, 20, 20, 20);
  });
  render(<MoreMenu ref={ref} label="更多操作：项目" items={items()} />);
  fireEvent.click(trigger()); expect(screen.getByRole('menu').style.left).toBe('100px'); expect(screen.getByRole('menu').style.top).toBe('44px');
  act(() => ref.current!.openAt({ x: window.innerWidth - 1, y: window.innerHeight - 1 }));
  const menu = screen.getByRole('menu');
  expect(parseFloat(menu.style.left) + 200).toBe(window.innerWidth - 8);
  expect(parseFloat(menu.style.top) + 100).toBe(window.innerHeight - 8);
  act(() => ref.current!.openAt({ x: -50, y: -50 })); expect(menu.style.left).toBe('8px'); expect(menu.style.top).toBe('8px');
  act(() => ref.current!.openAt({ x: 900, y: 700 }));
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(240);
  fireEvent(window, new Event('resize'));
  expect(menu.style.left).toBe('112px'); expect(menu.style.top).toBe('132px');
});
