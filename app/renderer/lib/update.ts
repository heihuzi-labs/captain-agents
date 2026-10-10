import { useSyncExternalStore } from 'react';
import type { AppInfo, UpdateState } from '../../shared/ipc.ts';

// 更新的状态（docs/ui-spec.md 第 18 节）：整个窗口只订阅这一处，顶栏提示、更新弹窗、设置里的“更新”一组共用。
// dialog：更新弹窗开没开（顶栏提示和设置里的“查看”都能打开它）。
export type UpdateView = { info: AppInfo | null; dialog: boolean };
let current: UpdateView = { info: null, dialog: false }, started = false;
const listeners = new Set<() => void>();
const set = (next: Partial<UpdateView>) => { current = { ...current, ...next }; listeners.forEach(fn => fn()); };
const setState = (update: UpdateState) => { if (current.info) set({ info: { ...current.info, update } }); };
function start() {
  if (started) return;
  started = true;
  // 老的后台没有这几个函数时（比如窗口代码比后台新），当作“不带在线更新”，不报错。
  if (typeof window.xa?.appInfo !== 'function') return;
  void window.xa.appInfo().then(info => set({ info })).catch(() => {});
  window.xa.onUpdate?.(setState);
}
const subscribe = (fn: () => void) => { start(); listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useUpdate = () => useSyncExternalStore(subscribe, () => current);
export const openUpdateDialog = () => set({ dialog: true });
export const closeUpdateDialog = () => set({ dialog: false });
// 这几个动作的结果都从 onUpdate 推回来；直接返回了新状态的，顺手先用上。出错由调用的地方显示原因。
export async function checkUpdate() { setState(await window.xa.updateCheck()); }
export const downloadUpdate = () => window.xa.updateDownload();
export const restartForUpdate = () => window.xa.updateRestart();
export async function setAutoCheck(on: boolean) { set({ info: await window.xa.setAutoUpdateCheck(on) }); }
// 测试之间把状态清回去。
export function resetUpdateForTest() { current = { info: null, dialog: false }; started = false; listeners.clear(); }

export const megabytes = (bytes: number) => bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
export const percent = (state: Extract<UpdateState, { phase: 'downloading' }>) => state.size > 0 ? Math.min(100, Math.floor(state.received / state.size * 100)) : 0;
// 顶栏提示上的字；不需要提示时是 null（出错也不在顶栏挂着，设置里看得到原因）。
export function pillText(state: UpdateState | undefined): string | null {
  if (!state) return null;
  if (state.phase === 'available') return `新版本 ${state.version}`;
  if (state.phase === 'downloading') return `下载中 ${percent(state)}%`;
  if (state.phase === 'ready') return '重启以更新';
  return null;
}
