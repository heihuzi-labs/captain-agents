import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'md' | 'sm' };
// 唯一的动作按钮：主要（推荐的一步）、次要（取消、恢复默认）、危险（不可撤回或会丢东西）。
export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: Props) {
  return <button type={type} className={['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className].filter(Boolean).join(' ')} {...rest} />;
}
