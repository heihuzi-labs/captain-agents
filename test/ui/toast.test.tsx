import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Toast } from '../../app/renderer/ui/Toast.tsx';
import type { ToastMessage } from '../../app/renderer/ui/Toast.tsx';

afterEach(() => { cleanup(); vi.useRealTimers(); });
function Host({ message, closed = () => {} }: { message: ToastMessage; closed?: () => void }) {
  const [shown, setShown] = useState(true);
  return shown ? <Toast message={message} onClose={() => { closed(); setShown(false); }} /> : null;
}
const advance = (time: number) => act(() => { vi.advanceTimersByTime(time); });

test('纯文字礼貌播报，8 秒自动消失', () => {
  vi.useFakeTimers(); render(<Host message={{ id: 1, text: '<b>已归档</b>' }} />);
  const toast = screen.getByRole('status'); expect(toast.getAttribute('aria-live')).toBe('polite');
  expect(toast.textContent).toContain('<b>已归档</b>'); expect(toast.querySelector('b')).toBeNull();
  advance(7999); expect(screen.getByRole('status')).toBeTruthy(); advance(1); expect(screen.queryByRole('status')).toBeNull();
});

test('悬停暂停，离开重新计 8 秒', () => {
  vi.useFakeTimers(); render(<Host message={{ id: 1, text: '已归档' }} />);
  advance(7000); fireEvent.mouseEnter(screen.getByRole('status')); advance(20000);
  expect(screen.getByRole('status')).toBeTruthy(); fireEvent.mouseLeave(screen.getByRole('status'));
  advance(7999); expect(screen.getByRole('status')).toBeTruthy(); advance(1); expect(screen.queryByRole('status')).toBeNull();
});

test('按钮聚焦暂停，内部换焦点不重启；悬停和焦点都离开才计时', () => {
  vi.useFakeTimers(); render(<Host message={{ id: 1, text: '已归档', action: { label: '撤销', onClick: vi.fn() } }} />);
  const toast = screen.getByRole('status'), undo = screen.getByRole('button', { name: '撤销' });
  advance(7000); act(() => undo.focus()); advance(10000); expect(screen.getByRole('status')).toBeTruthy();
  act(() => screen.getByRole('button', { name: '关闭提示' }).focus()); advance(10000);
  fireEvent.mouseEnter(toast); act(() => (document.activeElement as HTMLElement).blur()); advance(10000);
  expect(screen.getByRole('status')).toBeTruthy(); fireEvent.mouseLeave(toast); advance(8000);
  expect(screen.queryByRole('status')).toBeNull();
});

test('× 立即关闭并清理计时，动作按钮调用', () => {
  vi.useFakeTimers(); const action = vi.fn(), closed = vi.fn();
  render(<Host message={{ id: 1, text: '已归档', action: { label: '撤销', onClick: action } }} closed={closed} />);
  fireEvent.click(screen.getByRole('button', { name: '撤销' })); expect(action).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' })); expect(screen.queryByRole('status')).toBeNull();
  advance(8000); expect(closed).toHaveBeenCalledTimes(1);
});

test('新的替换旧的、更新动作、重新计 8 秒，相同文案也重计', () => {
  vi.useFakeTimers(); const old = vi.fn(), next = vi.fn();
  const { rerender } = render(<Host message={{ id: 1, text: '旧提示', action: { label: '旧动作', onClick: old } }} />);
  advance(7000); rerender(<Host message={{ id: 2, text: '新提示', action: { label: '新动作', onClick: next } }} />);
  expect(screen.getAllByRole('status')).toHaveLength(1); expect(screen.queryByText('旧提示')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '新动作' })); expect(next).toHaveBeenCalledTimes(1); expect(old).not.toHaveBeenCalled();
  advance(7000); rerender(<Host message={{ id: 3, text: '新提示' }} />);
  advance(7999); expect(screen.getByRole('status')).toBeTruthy(); advance(1); expect(screen.queryByRole('status')).toBeNull();
});

test('新提示去掉聚焦的动作后，恢复自动关闭', () => {
  vi.useFakeTimers();
  const { rerender } = render(<Host message={{ id: 1, text: '旧提示', action: { label: '撤销', onClick: vi.fn() } }} />);
  act(() => screen.getByRole('button', { name: '撤销' }).focus());
  advance(10000); expect(screen.getByRole('status')).toBeTruthy();
  rerender(<Host message={{ id: 2, text: '新提示' }} />);
  advance(8000); expect(screen.queryByRole('status')).toBeNull();
});
