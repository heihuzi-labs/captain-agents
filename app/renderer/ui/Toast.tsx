import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './Button.tsx';

export type ToastAction = { label: string; onClick: () => void };
export type ToastMessage = { id: number; text: string; action?: ToastAction };
export function Toast({ message, onClose }: { message: ToastMessage; onClose: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // 新提示去掉了原来聚焦的动作时，浏览器未必触发 blur，重新核对实际焦点。
  useLayoutEffect(() => { setFocused(!!root.current?.contains(document.activeElement)); }, [message.id]);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(() => close.current(), 8000);
    return () => clearTimeout(timer);
  }, [message.id, hovered, focused]);
  return <div ref={root} role="status" aria-live="polite" aria-atomic="true" className="toast"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
    <span className="toast-text">{message.text}</span>
    {message.action && <Button size="sm" onClick={message.action.onClick}>{message.action.label}</Button>}
    <button type="button" className="toast-close" aria-label="关闭提示" onClick={onClose}>×</button>
  </div>;
}
