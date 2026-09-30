import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export type SegmentedItem = {
  id: string; label: string;
  title?: string;        // 悬停提示，如“看板（⌘1）”
};
// 分段切换：一小排互斥的选项，当前项浮起。role="tablist" / "tab"，左右键切换并把焦点跟过去（首尾循环，Home / End 跳头尾），只有当前项在 Tab 序列里。
// disabled：整排变灰、点不动，当前项保留。
export function Segmented({ label, items, value, onChange, disabled = false }: { label: string; items: SegmentedItem[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next = e.key === 'ArrowRight' ? (index + 1) % items.length : e.key === 'ArrowLeft' ? (index + last) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault(); onChange(items[next].id); tabs.current.get(items[next].id)?.focus();
  };
  return <div className="seg" role="tablist" aria-label={label} aria-disabled={disabled || undefined}>{items.map((item, i) => {
    const on = item.id === value;
    return <button key={item.id} type="button" role="tab" className="seg-tab" aria-selected={on} tabIndex={on ? 0 : -1} disabled={disabled}
      title={item.title}
      ref={node => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
      onClick={() => onChange(item.id)} onKeyDown={e => move(e, i)}>{item.label}</button>;
  })}</div>;
}
