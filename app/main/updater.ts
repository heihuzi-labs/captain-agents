import type { AppInfo, UpdateState } from '../shared/ipc.ts';
import type { UpdateFeed, UpdatePackage } from './update-feed.ts';
import { selectUpdate, verifyFeed } from './update-feed.ts';

export const UPDATE_FIRST_MS = 60_000;
export const UPDATE_EVERY_MS = 24 * 60 * 60_000;
export type UpdateClock = { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
const realClock: UpdateClock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
export type UpdaterOptions = {
  version: string; platform: string; arch: string; publicKey: string; autoCheck: boolean; offReason?: string;
  fetchFeed(): Promise<Uint8Array>;
  download(pkg: UpdatePackage, progress: (received: number) => void): Promise<string>;
  prepare(zip: string, version: string): Promise<string>;
  restart(staged: string, version: string): Promise<void>;
  saveAutoCheck(on: boolean): Promise<void>;
  publish(state: UpdateState): void;
  clock?: UpdateClock;
};
// 与 Electron 无关：网络、磁盘、进程和时钟都由主进程适配器提供，测试不用端口或真实应用。
export function createUpdater(options: UpdaterOptions) {
  const clock = options.clock ?? realClock;
  let state: UpdateState = options.offReason ? { phase: 'off', reason: options.offReason } : { phase: 'idle', checked: null };
  let available: { feed: UpdateFeed; pkg: UpdatePackage } | undefined, staged: string | undefined;
  let busy = false, saving = false, started = false, autoCheck = options.autoCheck, timer: unknown;
  const info = (): AppInfo => ({ version: options.version, update: structuredClone(state), autoCheck });
  const change = (next: UpdateState) => { state = next; options.publish(structuredClone(next)); };
  const enabled = () => { if (state.phase === 'off') throw new Error(state.reason); if (busy) throw new Error('更新正在处理，请稍等。'); };
  const fail = (prefix: string, error: unknown) => {
    const detail = error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '操作失败，请稍后重试。';
    change({ phase: 'error', message: `${prefix}：${detail}` });
  };
  async function check(): Promise<UpdateState> {
    enabled();
    if (state.phase === 'ready') throw new Error('更新已经准备好，请重启以完成更新。');
    busy = true; available = undefined; staged = undefined;
    change({ phase: 'checking' });
    try {
      const feed = verifyFeed(await options.fetchFeed(), options.publicKey);
      const pkg = selectUpdate(feed, options.version, options.platform, options.arch);
      if (pkg) { available = { feed, pkg }; change({ phase: 'available', version: feed.version, notes: feed.notes, size: pkg.size }); }
      else change({ phase: 'idle', checked: new Date(clock.now()).toISOString() });
    } catch (error) { fail('没能检查更新', error); }
    finally { busy = false; }
    return structuredClone(state);
  }
  async function download(): Promise<void> {
    enabled();
    if (state.phase !== 'available' || !available) throw new Error('没有可下载的更新，请先检查更新。');
    busy = true;
    const { feed, pkg } = available;
    change({ phase: 'downloading', version: feed.version, received: 0, size: pkg.size });
    try {
      const zip = await options.download(pkg, received => change({ phase: 'downloading', version: feed.version, received, size: pkg.size }));
      staged = await options.prepare(zip, feed.version);
      change({ phase: 'ready', version: feed.version });
    } catch (error) { staged = undefined; available = undefined; fail('没能下载更新', error); }
    finally { busy = false; }
  }
  async function restart(): Promise<void> {
    enabled();
    if (state.phase !== 'ready' || !staged) throw new Error('更新还没准备好，不能重启安装。');
    busy = true;
    try { await options.restart(staged, state.version); }
    catch (error) { busy = false; staged = undefined; available = undefined; fail('没能安装更新', error); }
    // 成功启动小程序后保持锁，直到应用退出，防止重复启动两个安装者。
  }
  function unschedule() { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; }
  function schedule(delay: number) {
    unschedule();
    if (!started || !autoCheck || state.phase === 'off') return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (!started || !autoCheck) return;
      if (!busy && (state.phase === 'idle' || state.phase === 'error')) void check();
      schedule(UPDATE_EVERY_MS);
    }, delay);
  }
  async function setAutoCheck(on: boolean): Promise<AppInfo> {
    if (typeof on !== 'boolean') throw new Error('自动检查更新只能是开或关。');
    if (saving) throw new Error('自动检查设置正在保存，请稍等。');
    saving = true;
    try { await options.saveAutoCheck(on); autoCheck = on; schedule(UPDATE_FIRST_MS); return info(); }
    finally { saving = false; }
  }
  return { info, check, download, restart, setAutoCheck,
    start() { if (!started) { started = true; schedule(UPDATE_FIRST_MS); } },
    stop() { started = false; unschedule(); },
  };
}
export type Updater = ReturnType<typeof createUpdater>;
export function updateActions(updater: Updater) {
  const none = (args: unknown[]) => { if (args.length) throw new Error('这个更新操作不需要参数。'); };
  return {
    appInfo(args: unknown[]) { none(args); return updater.info(); },
    updateCheck(args: unknown[]) { none(args); return updater.check(); },
    updateDownload(args: unknown[]) { none(args); return updater.download(); },
    updateRestart(args: unknown[]) { none(args); return updater.restart(); },
    setAutoUpdateCheck(args: unknown[]) {
      if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('自动检查更新只能接收一个开关。');
      return updater.setAutoCheck(args[0]);
    },
  };
}
