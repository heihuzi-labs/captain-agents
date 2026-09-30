import type { CSSProperties } from 'react';
// 把自定义 CSS 变量交给元素（比如批次色带），值必须是 var(--…) 引用，不写死颜色。
export const cssVars = (values: Record<string, string>): CSSProperties => values as CSSProperties;
