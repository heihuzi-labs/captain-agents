import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ViewJob } from '../../../src/core/view-types.ts';
import { Button } from './Button.tsx';
import { Chip, Dot } from './Chip.tsx';
import { watchInput } from './focus.ts';
import { cssVars } from './style.ts';

watchInput();
const OPERABLE = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]';
// 已打开的弹窗，最后一个在最上面；只有最上面的弹窗处理键盘，下面的暂时不可操作。
const open: HTMLElement[] = [];
export const hasNestedModal = () => open.length > 1;

export function CloseButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="close-button" aria-label="关闭" title="关闭（Esc）" onClick={onClick}>✕</button>;
}
// 一批的圆点：有一家在跑算在跑，否则排队、完成、出错、失联、已停，按这个先后取第一个有的。
const ORDER: ViewJob['state'][] = ['running', 'queued', 'done', 'failed', 'lost', 'stopped'];
// 任务弹窗的头部（单家、一批共用）：[← 这一批] + 状态圆点 + 类型标签 + 题目。
export function TaskHead({ jobs, kind, title, back }: { jobs: ViewJob[]; kind: string; title: string; back?: ReactNode }) {
  const state = ORDER.find(s => jobs.some(j => j.state === s)) ?? 'stopped';
  return <span className="task-head">{back}<Dot state={state} />{kind && <Chip>{kind}</Chip>}<span className="job-title ellip" title={title}>{title}</span></span>;
}
type Props = {
  label: string; title: ReactNode; onClose: () => void; footer?: ReactNode; children: ReactNode;
  size?: 'md' | 'sm' | 'lg'; role?: 'dialog' | 'alertdialog'; scrollKey?: string; hue?: string;
  flush?: boolean;   // 正文不留边距、不整体滚动：内容自己分栏、自己滚动（设置窗口）
};
// 全应用唯一的弹窗外框：暗色遮罩、标题栏、右上角关闭按钮、Esc 或点暗处关闭、焦点管理；属于多家一批时顶部加批次色带。
// 打开时焦点落到第一个可操作的控件（没有就落到关闭按钮）；外框本身不接收焦点，也不显示焦点框。
export function Modal({ label, title, onClose, footer, children, size = 'md', role = 'dialog', scrollKey, hue, flush = false }: Props) {
  const root = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  // 换到另一张内容时回到顶部。
  useEffect(() => { body.current?.scrollTo?.(0, 0); }, [scrollKey]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const previous = document.activeElement;
    const lower = open.filter(other => !other.hasAttribute('inert'));
    lower.forEach(other => other.setAttribute('inert', ''));
    open.push(el);
    const nodes = () => [...el.querySelectorAll<HTMLElement>(OPERABLE)];
    (el.querySelector<HTMLElement>('[data-autofocus]') ?? nodes()[0])?.focus();
    const key = (e: KeyboardEvent) => {
      if (open.at(-1) !== el) return;
      if (e.key === 'Escape') { e.preventDefault(); close.current(); }
      else if (e.key === 'Tab') {
        const list = nodes();
        if (!list.length) return;
        const active = document.activeElement, inside = active instanceof HTMLElement && el.contains(active);
        if (e.shiftKey && (!inside || active === list[0])) { e.preventDefault(); list.at(-1)!.focus(); }
        else if (!e.shiftKey && (!inside || active === list.at(-1))) { e.preventDefault(); list[0].focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      open.splice(open.indexOf(el), 1);
      lower.forEach(other => other.removeAttribute('inert'));
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="modal" data-modal-root ref={root}>
    <div className="scrim" onClick={onClose} />
    <div className={'sheet sheet-' + size + (hue ? ' banded' : '')} style={hue ? cssVars({ '--batch': hue }) : undefined} role={role} aria-modal="true" aria-label={label}>
      <div className="modal-bar"><div className="modal-title">{title}</div><CloseButton onClick={onClose} /></div>
      <div className={'modal-body' + (flush ? ' modal-flush' : '')} ref={body}>{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </div>, document.body);
}
// 二次确认：说清后果，默认焦点在“先不改”上。
// tone：确认按钮的款式，默认危险款；不会丢东西的确认（接入 AI）用主要款。detail：那句话下面的细节（纯文字）。
export function ConfirmDialog({ message, detail, confirmLabel, cancelLabel = '先不改', tone = 'danger', busy = false, onConfirm, onCancel }: {
  message: string; detail?: ReactNode; confirmLabel: string; cancelLabel?: string; tone?: 'danger' | 'primary'; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <Modal role="alertdialog" size="sm" label="请确认" title="请确认" onClose={onCancel}>
    <p className="confirm-message">{message}</p>
    {detail}
    <div className="modal-actions">
      <Button data-autofocus disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
      <Button variant={tone} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </Modal>;
}
