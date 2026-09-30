import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cssVars } from './style.ts';

// 卡片不画状态色边：状态靠所在的列和卡上的状态标签表达。
type Hue = { hue?: string };
const withHue = (hue?: string) => hue ? cssVars({ '--batch': hue }) : undefined;

export function ReplyDot() {
  return <span className="reply-dot" role="img" aria-label="有留言等负责人回复" title="有留言等负责人回复" />;
}
type CardProps = ButtonHTMLAttributes<HTMLButtonElement> & Hue & { compact?: boolean; marked?: boolean; ref?: Ref<HTMLButtonElement> };
// 看板上的一张卡：属于多家一批时顶部加批次色带；有未回复的留言时右上角一个小圆点。
export function Card({ hue, compact = false, marked = false, className, children, ref, ...rest }: CardProps) {
  return <button type="button" ref={ref} className={['card', compact ? 'card-compact' : '', hue ? 'banded' : '', className].filter(Boolean).join(' ')} style={withHue(hue)} {...rest}>
    {marked && <ReplyDot />}{children}
  </button>;
}
// 一批同时在跑的活：一张大卡，里面每家一行。
export function BatchGroup({ hue, head, children }: { hue?: string; head: ReactNode; children: ReactNode }) {
  return <div className={'card card-batch' + (hue ? ' banded' : '')} style={withHue(hue)}>{head}{children}</div>;
}
export function MemberRow({ className, children, ref, marked = false, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { marked?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return <button type="button" ref={ref} className={['member-row', className].filter(Boolean).join(' ')} {...rest}>{marked && <ReplyDot />}{children}</button>;
}
