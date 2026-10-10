import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { MoreMenu } from './MoreMenu.tsx';
import type { MoreMenuHandle, MoreMenuItem } from './MoreMenu.tsx';

// badge：右边的小数字或小字；note：名字下面一行小字。都是可选的，设置页不用。
// menu：这一行自己的“…”菜单（协作页会话列表的标为未读、归档）。移到这一行才显出“…”，点开再选；右键这一行打开同一个菜单。
// 不放一点就生效的图标按钮：容易误触。
export type SideNavItem = { id: string; label: string; badge?: ReactNode; note?: ReactNode; menu?: { label: string; items: MoreMenuItem[] } };
// 带菜单的一行：页签和“…”是兄弟（按钮里不能再放按钮）。页签列表之外的行（“已归档”里的）也用它。
export function SideNavRow({ menu, children }: { menu: { label: string; items: MoreMenuItem[] }; children: ReactNode }) {
  const handle = useRef<MoreMenuHandle>(null);
  return <div className="sidenav-item more-row" onContextMenu={e => { e.preventDefault(); e.stopPropagation(); handle.current?.openAt({ x: e.clientX, y: e.clientY }); }}>
    {children}<span className="sidenav-more"><MoreMenu ref={handle} label={menu.label} items={menu.items} /></span>
  </div>;
}
// 两栏布局：左边窄栏分页，右边内容区单独滚动（设置窗口用）。
// 左栏是一组竖排的页签：上下键切换（首尾循环，Home / End 跳到头尾），选中的页签才在 Tab 序列里，内容区随之切换。
// 放进页面（历史页）而不是弹窗时，由页面传 className 定左栏宽度和整体高度（样式在 layout.css）；右边内容区照样自己滚动。
// footer：左栏页签下面的一节（历史页的“已归档”）。不在页签列表里，避免折起时上下键走进去。
// header：左栏页签上面的一行（协作页的“群聊 ＋ 新建”），同样不在页签列表里。
export function SideNavLayout({ label, items, value, onChange, children, className, footer, header }: {
  label: string; items: SideNavItem[]; value: string; onChange: (id: string) => void; children: ReactNode; className?: string; footer?: ReactNode; header?: ReactNode;
}) {
  const base = useId(), tabs = useRef(new Map<string, HTMLButtonElement>());
  const selected = items.findIndex(item => item.id === value);
  const move = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next = e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index + last) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault(); onChange(items[next].id); tabs.current.get(items[next].id)?.focus();
  };
  return <div className={'sidenav-layout' + (className ? ' ' + className : '')}>
    <div className="sidenav">
      {header}
      <div className="sidenav-tabs" role="tablist" aria-orientation="vertical" aria-label={label}>{items.map((item, i) => {
        const on = i === selected;
        const tab = <button key={item.id} type="button" role="tab" id={`${base}-tab-${item.id}`} className="sidenav-tab" aria-selected={on} aria-controls={`${base}-panel`}
          tabIndex={i === (selected >= 0 ? selected : 0) ? 0 : -1} data-autofocus={on || undefined} ref={node => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
          onClick={() => onChange(item.id)} onKeyDown={e => move(e, i)}>
          <span className="sidenav-label">{item.label}</span>{item.badge != null && <span className="sidenav-badge num">{item.badge}</span>}{item.note != null && <span className="sidenav-note">{item.note}</span>}</button>;
        return item.menu ? <SideNavRow key={item.id} menu={item.menu}>{tab}</SideNavRow> : tab;
      })}</div>
      {footer}
    </div>
    <div className="sidenav-body" role="tabpanel" id={`${base}-panel`} aria-labelledby={selected >= 0 ? `${base}-tab-${value}` : undefined}>{children}</div>
  </div>;
}
