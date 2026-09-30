// 定时清理旧日志：启动 1 分钟后一次，之后每 6 小时一次，改开关或天数时立刻一次。
// 清理本身是核心的 slimOld（开关关着它自己什么也不做）；这里只管什么时候跑。出错只交给 onError 记日志，不弹窗、不发通知。
export const SLIM_FIRST_MS = 60_000;
export const SLIM_EVERY_MS = 6 * 3600_000;

export function slimScheduler(core: { run(): Promise<unknown>; onError(error: unknown): void }, firstMs = SLIM_FIRST_MS, everyMs = SLIM_EVERY_MS) {
  let first: ReturnType<typeof setTimeout> | undefined, every: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined, again = false, stopped = false;
  // 同一时间只跑一次；正在跑时又来一次（比如刚改了天数），等这次跑完再补一次，让新设置生效。
  const now = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      try { await core.run(); } catch (error) { core.onError(error); }
    })().finally(() => {
      running = undefined;
      if (again) { again = false; void now(); }
    });
    return running;
  };
  const start = () => {
    if (stopped || first || every) return;   // 只启动一次
    // 1 分钟后跑第一次，之后每隔 6 小时（从第一次算起）。
    first = setTimeout(() => {
      first = undefined; void now();
      every = setInterval(() => { void now(); }, everyMs);
      every.unref?.();
    }, firstMs);
    first.unref?.();
  };
  const stop = () => {
    stopped = true;
    if (first) clearTimeout(first);
    if (every) clearInterval(every);
    first = every = undefined;
  };
  return { start, now, stop };
}
