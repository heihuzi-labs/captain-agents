import type { Appearance } from '../../src/core/settings.ts';

// 窗口还没画出页面时的底色，和 app/renderer/styles/tokens.css 的 --bg 一致（浅色、深色各一个），避免切换时闪一下。
export const WINDOW_BACKGROUND = { light: '#f5f5f2', dark: '#131312' } as const;
export const windowBackground = (dark: boolean) => dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;

// 只依赖 nativeTheme 的这一小块，方便测试。themeSource 的三个值和外观设置一一对应：
// 渲染层现有的深浅两套变量（prefers-color-scheme）会跟着自动切换，菜单栏图标是模板图，不受影响。
export type ThemeLike = { themeSource: Appearance; shouldUseDarkColors: boolean };
export type WindowLike = { isDestroyed(): boolean; setBackgroundColor(color: string): void };
export function applyAppearance(theme: ThemeLike, value: Appearance, window?: WindowLike | null) {
  theme.themeSource = value;
  syncBackground(theme, window);
}
export function syncBackground(theme: Pick<ThemeLike, 'shouldUseDarkColors'>, window?: WindowLike | null) {
  if (window && !window.isDestroyed()) window.setBackgroundColor(windowBackground(theme.shouldUseDarkColors));
}
