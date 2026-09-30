// 全窗口共用一个时钟，只更新订阅的小块 DOM，不触发看板 React render。
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
export function subscribeTick(fn: () => void) {
  listeners.add(fn);
  fn();
  timer ??= setInterval(() => listeners.forEach(tick => tick()), 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
