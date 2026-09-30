import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { createPortal } from 'react-dom';

type Point = { x: number; y: number };
export type MoreMenuHandle = { openAt: (point: Point) => void };
export type MoreMenuItem = { label: string; note?: string; onSelect: () => void };
// 所有实例共用一个关闭入口，切换菜单不把焦点抢回旧按钮。
let closeActive: (() => void) | undefined;

export function MoreMenu({ label, items, ref }: { label: string; items: MoreMenuItem[]; ref?: Ref<MoreMenuHandle> }) {
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const [anchor, setAnchor] = useState<Point | 'button' | null>(null);
  const close = useCallback(() => {
    setAnchor(null);
    if (closeActive === close) closeActive = undefined;
  }, []);
  const open = useCallback((at: Point | 'button') => {
    closeActive?.();
    closeActive = close;
    setAnchor(at);
  }, [close]);
  useImperativeHandle(ref, () => ({ openAt: open }), [open]);
  useEffect(() => () => { if (closeActive === close) closeActive = undefined; }, [close]);

  useLayoutEffect(() => {
    if (!anchor || !menu.current) return;
    const el = menu.current;
    const place = () => {
      const box = el.getBoundingClientRect(), trigger = button.current!.getBoundingClientRect();
      const x = anchor === 'button' ? trigger.right - box.width : anchor.x;
      const y = anchor === 'button' ? trigger.bottom + 4 : anchor.y;
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    };
    place();
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer?.disconnect();
    };
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (e: Event) => {
      if (e.target instanceof Node && !menu.current?.contains(e.target) && !button.current?.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('click', outside);
    document.addEventListener('contextmenu', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('click', outside);
      document.removeEventListener('contextmenu', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('blur', close);
    };
  }, [anchor, close]);
  const restore = () => { close(); button.current?.focus(); };
  return <>
    <button ref={button} type="button" className="more-btn" aria-label={label} aria-haspopup="menu" aria-expanded={!!anchor} aria-controls={anchor ? id : undefined}
      onClick={e => { e.stopPropagation(); if (anchor) close(); else open('button'); }}
      onKeyDown={e => {
        if (['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); open('button'); }
      }}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" /></svg></button>
    {anchor && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className="more-menu"
      onClick={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={e => {
        const rows = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Tab') { restore(); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); restore(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation();
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
          rows[next]?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation(); rows[index]?.click();
        }
      }}>
      {items.map((item, index) => <button key={index} type="button" role="menuitem" tabIndex={-1} className="more-item"
        onClick={() => { restore(); item.onSelect(); }}>
        <span>{item.label}</span>{item.note && <span className="more-note">{item.note}</span>}
      </button>)}
    </div>, document.body)}
  </>;
}
