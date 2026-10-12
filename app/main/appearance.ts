import type { Appearance } from '../../src/core/settings.ts';

// 窗口还没画出页面时的底色，和 app/renderer/styles/tokens.css 的 --bg 一致（浅色、深色各一个），避免切换时闪一下。
export const WINDOW_BACKGROUND = { light: '#f5f5f2', dark: '#131312' } as const;
export const windowBackground = (dark: boolean) => dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;

// 只依赖 nativeTheme 的这一小块，方便测试。themeSource 的三个值和外观设置一一对应：
// 渲染层现有的深浅两套变量（prefers-color-scheme）会跟着自动切换，菜单栏图标是模板图，不受影响。
export type ThemeLike = { themeSource: Appearance; shouldUseDarkColors: boolean };
// Windows：右上角三个窗口按钮由系统画在顶栏上（docs/ui-spec.md 第 11 节）。底色同顶栏（--bg），符号色同正文（--text），高度同顶栏。
export const TITLEBAR_SYMBOL = { light: '#1c1c1a', dark: '#ecebe7' } as const;
export const TOPBAR_HEIGHT = 48;
export const titleBarOverlay = (dark: boolean) => ({ color: windowBackground(dark), symbolColor: dark ? TITLEBAR_SYMBOL.dark : TITLEBAR_SYMBOL.light, height: TOPBAR_HEIGHT });
export type WindowLike = { isDestroyed(): boolean; setBackgroundColor(color: string): void; setTitleBarOverlay?(options: ReturnType<typeof titleBarOverlay>): void };
export function applyAppearance(theme: ThemeLike, value: Appearance, window?: WindowLike | null) {
  theme.themeSource = value;
  syncBackground(theme, window);
}
export function syncBackground(theme: Pick<ThemeLike, 'shouldUseDarkColors'>, window?: WindowLike | null, overlay = process.platform === 'win32') {
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(windowBackground(theme.shouldUseDarkColors));
  // 只有 Windows 的窗口有这一层；别的系统上调用会报错，所以由调用方决定给不给这个函数。
  if (overlay) window.setTitleBarOverlay?.(titleBarOverlay(theme.shouldUseDarkColors));
}
