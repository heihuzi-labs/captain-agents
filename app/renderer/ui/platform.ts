// 界面上两种系统不一样的地方：快捷键的修饰键、顶栏给窗口按钮留的位置（docs/ui-spec.md 第 11 节）。
export const isWindows = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);
// 写在悬停提示里的修饰键：macOS 是 ⌘，Windows 是 Ctrl。
export const MOD = isWindows ? 'Ctrl+' : '⌘';
// 界面文字里两种系统叫法不同的东西：删掉的东西去哪、应用常驻在哪。
export const TRASH = isWindows ? '回收站' : '废纸篓';
export const TRAY = isWindows ? '托盘' : '菜单栏';
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => isWindows ? e.ctrlKey : e.metaKey;
