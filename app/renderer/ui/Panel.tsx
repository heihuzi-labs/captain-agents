import type { ReactNode } from 'react';

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={'panel' + (className ? ' ' + className : '')}>{children}</div>;
}
// 弹窗里的一块内容：小标题 + 正文。
export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <section className="panel section"><h3>{title}</h3>{children}</section>;
}
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
