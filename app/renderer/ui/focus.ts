// 焦点框只在键盘操作时出现：根元素上记最近一次操作是键盘还是鼠标，样式见 ui.css。
// 带 ⌘、Ctrl、Option 的快捷键不算键盘操作（和浏览器自己的判断一致）；还没操作过算鼠标。
let watching = false;
export function watchInput() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const root = document.documentElement, mark = (input: 'keyboard' | 'pointer') => { if (root.dataset.input !== input) root.dataset.input = input; };
  mark('pointer');
  document.addEventListener('keydown', e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) mark('keyboard'); }, true);
  document.addEventListener('pointerdown', () => mark('pointer'), true);
  document.addEventListener('mousedown', () => mark('pointer'), true);
}
