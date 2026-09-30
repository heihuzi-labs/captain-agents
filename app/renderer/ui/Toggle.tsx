import type { ButtonHTMLAttributes } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'type' | 'aria-checked' | 'aria-label' | 'title'> & {
  label: string;                        // 可访问名（读屏和测试都用它）
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;                   // 整个变灰、点不动（勾选保留）
  locked?: string;                      // 现在不能改，写这句原因：仍可聚焦，悬停显示原因，点了没反应
};
function Toggle({ kind, label, checked, onChange, disabled = false, locked, className, ...rest }: Props & { kind: 'switch' | 'checkbox' }) {
  const stuck = locked !== undefined;
  return <button {...rest} type="button" role={kind} className={[kind === 'switch' ? 'switch' : 'check-dot', className].filter(Boolean).join(' ')}
    aria-label={label} aria-checked={checked} aria-disabled={stuck || undefined} disabled={disabled} title={locked}
    onClick={() => { if (!stuck) onChange(!checked); }}>
    {kind === 'switch' ? <span className="switch-knob" /> : <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4 5 8.9l4.5-5.3" /></svg>}
  </button>;
}
// 滑动开关：全应用所有“开 / 关”都用它（防休眠、通知、开机启动、选手启用……）。role="switch"，空格或回车切换；焦点框跟全应用一致。
export const Switch = (props: Props) => <Toggle kind="switch" {...props} />;
// 勾选点：表格里的“选 / 不选”，小圆点，勾了的填色并带对号（不只靠颜色）。role="checkbox"，键盘操作同上。
export const CheckDot = (props: Props) => <Toggle kind="checkbox" {...props} />;
