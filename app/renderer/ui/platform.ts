// 界面上两种系统不一样的地方：快捷键的修饰键、顶栏给窗口按钮留的位置（docs/ui-spec.md 第 11 节）。
export const isWindows = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);
// 写在悬停提示里的修饰键：macOS 是 ⌘，Windows 是 Ctrl。
export const MOD = isWindows ? 'Ctrl+' : '⌘';
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => isWindows ? e.ctrlKey : e.metaKey;
