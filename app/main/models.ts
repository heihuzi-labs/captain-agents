import type { IpcMainInvokeEvent } from 'electron';
import { modelSelection } from '../../src/core/settings.ts';
import type { ModelsCache, Vendor } from '../../src/core/roster.ts';
import { quotaRefresher, QUOTA_GAP_MS } from './actions.ts';

export const MODELS_EVERY_MS = 24 * 60 * 60_000;
export function modelsRefresher(core: { query(): Promise<unknown>; now?(): number; readCache?(): Promise<ModelsCache | null> }, updated: () => Promise<void>) {
  return quotaRefresher({ now: core.now, query: async () => {
    const cache = await core.readCache?.();
    if (cache && (core.now?.() ?? Date.now()) - Date.parse(cache.at) < QUOTA_GAP_MS) throw new Error('刚刷新过，请稍后再试。');
    await core.query();
  } }, updated, QUOTA_GAP_MS, '模型');
}
export function modelsRefreshHandler(refresher: Pick<ReturnType<typeof modelsRefresher>, 'refresh'>, trusted: (event: IpcMainInvokeEvent) => boolean) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error('不允许的请求来源。');
    await refresher.refresh(args);
  };
}
export function modelsKeepHandler(core: { keep(channel: Vendor, models: string[]): Promise<void> }, updated: () => Promise<void>, trusted: (event: IpcMainInvokeEvent) => boolean) {
  let pending = false;
  return async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error('不允许的请求来源。');
    if (args.length !== 2) throw new Error('保留模型需要通道和模型名列表两个参数。');
    const { channel, models } = modelSelection(args[0], args[1]);
    if (pending) throw new Error('模型正在保存，请稍等。');
    pending = true;
    try { await core.keep(channel, models); await updated(); }
    finally { pending = false; }
  };
}
// 先开窗口，再在后台检查缓存；定时器与手动刷新共用一分钟防重复的刷新器。
export function modelsScheduler(core: { readCache(): Promise<ModelsCache | null>; now?(): number }, refresher: Pick<ReturnType<typeof modelsRefresher>, 'auto'>, onError: (e: unknown) => void) {
  let stopped = true, timer: ReturnType<typeof setInterval> | undefined;
  const tick = async () => {
    try {
      const cache = await core.readCache();
      if (!stopped && (!cache || (core.now?.() ?? Date.now()) - Date.parse(cache.at) >= MODELS_EVERY_MS)) await refresher.auto(onError);
    } catch (error) { onError(error); }
  };
  return {
    start() { if (!stopped) return; stopped = false; timer = setInterval(() => { void tick(); }, MODELS_EVERY_MS); void tick(); },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; },
  };
}
