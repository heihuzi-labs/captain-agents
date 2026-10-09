import type { IpcMainInvokeEvent } from 'electron';
import type { Settings, SettingsPatch } from '../shared/ipc.ts';
import { defaultColumns } from '../shared/ipc.ts';
import { validateWorkersPatch } from '../../src/core/policy.ts';
import { isAppearance, LIMIT_CAPS, quotaStops, slimDays } from '../../src/core/settings.ts';
import type { Appearance, QuotaStop, SlimDays } from '../../src/core/settings.ts';

// 归档名单：和核心 settings.ts 同一条线（数组、每个是合法项目名、最多 200 个）。名字规则同登记项目。
const PROJECT_NAME = /^[\p{L}\p{N}_-]+$/u;
function archivedProjects(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('归档名单必须是项目名列表。');
  if (value.length > 200) throw new Error('归档项目最多 200 个。');
  const names: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const name: unknown = value[i];
    if (typeof name !== 'string' || name.length > 64 || name === '.' || name === '..' || !PROJECT_NAME.test(name)) throw new Error('归档项目的名字不合法。');
    names.push(name);
  }
  return names;
}

type Operations = {
  readJob(id: string): Promise<{ id: string }>;
  decide(id: string, kind: 'adopt' | 'drop', note: string, by: 'owner'): Promise<unknown>;
  requestRedo(id: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  comment(id: string, text: string, by: 'owner'): Promise<unknown>;
  checkComment(text: unknown): string;
};
// 锁覆盖校验和核心调用；四个通道共用同一个锁集合（同一任务同时只处理一个请求）。
export function jobActions(core: Operations) {
  const pending = new Set<string>();
  return async (action: 'decide' | 'redo' | 'stop' | 'comment', args: unknown[]) => {
    if (args.length !== (action === 'decide' || action === 'comment' ? 2 : 1)) throw new Error('请求参数数量不对。');
    const [id, kind] = args;
    if (typeof id !== 'string' || id.length > 200 || !/^[\p{L}\p{N}_-]+$/u.test(id)) throw new Error('任务号无效。');
    if (action === 'decide' && kind !== 'adopt' && kind !== 'drop') throw new Error('只能选择用这份或不要了。');
    const text = action === 'comment' ? core.checkComment(args[1]) : '';
    if (pending.has(id)) throw new Error('这件事正在处理，请稍等。');
    pending.add(id);
    try {
      let record;
      try { record = await core.readJob(id); } catch { throw new Error('找不到这条任务，请刷新后再试。'); }
      if (record.id !== id) throw new Error('任务号与登记记录不一致。');
      if (action === 'decide' && (kind === 'adopt' || kind === 'drop')) await core.decide(id, kind, '主人在应用里选的', 'owner');
      else if (action === 'comment') await core.comment(id, text, 'owner');
      else if (action === 'redo') await core.requestRedo(id);
      else await core.stop(id);
    } finally { pending.delete(id); }
  };
}
export function settingsPatch(value: unknown): SettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('设置格式不对。');
  const patch: SettingsPatch = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'keepAwake' || key === 'notifications' || key === 'openAtLogin') {
      if (typeof v !== 'boolean') throw new Error('开关只能是开或关。');
      patch[key] = v;
    } else if (key === 'appearance') {
      if (!isAppearance(v)) throw new Error('外观只能是跟随系统、浅色或深色。');
      patch.appearance = v;
    } else if (key === 'storage') {
      // 自动清理：开关和天数两项都要有，天数只许 7、14、30；多一个字段就拒绝。
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new Error('自动清理设置格式不对。');
      const entries = Object.entries(v), { slim, days } = v as Record<string, unknown>;
      if (entries.length !== 2 || typeof slim !== 'boolean' || !slimDays.includes(days as SlimDays)) throw new Error('自动清理只能填开或关，天数只能是 7、14 或 30。');
      patch.storage = { slim, days: days as SlimDays };
    } else if (key === 'limits') {
      // 派活限制：只能在上限以内（同时最多跑 1–12 件、停派线 50/60/70/80%），两项都要给、不许多字段。
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => k !== 'maxRunning' && k !== 'quotaStop')) throw new Error('派活限制须包含“同时最多跑”和“额度停派线”两项。');
      const { maxRunning, quotaStop } = v as Record<string, unknown>;
      if (!Number.isInteger(maxRunning) || (maxRunning as number) < 1 || (maxRunning as number) > LIMIT_CAPS.maxRunning) throw new Error(`同时最多跑只能是 1–${LIMIT_CAPS.maxRunning} 件。`);
      if (!quotaStops.includes(quotaStop as QuotaStop)) throw new Error('额度停派线只能是 50%、60%、70%、80%。');
      patch.limits = { maxRunning: maxRunning as number, quotaStop: quotaStop as QuotaStop };
    } else if (key === 'workers') {
      patch.workers = validateWorkersPatch(v);
    } else if (key === 'columns') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new Error('列颜色格式不对。');
      const columns: Record<string, string> = {};
      for (const [column, color] of Object.entries(v)) {
        if (!Object.hasOwn(defaultColumns, column) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('列颜色只能填写六位十六进制颜色。');
        columns[column] = color;
      }
      patch.columns = columns;
    } else if (key === 'archivedProjects') {
      patch.archivedProjects = archivedProjects(v);
    } else throw new Error('包含不认识的设置。');
  }
  return patch;
}
export function settingsActions(core: {
  readSettings(): Promise<Omit<Settings, 'openAtLogin'>>;
  writeSettings(patch: Omit<SettingsPatch, 'openAtLogin'>): Promise<void>;
  getLogin(): boolean;
  setLogin(value: boolean): void;
  // 外观改了立刻生效（主进程给 nativeTheme 赋值、换窗口底色）；保存成功后才调用。
  setAppearance?(value: Appearance): void;
  // 自动清理的开关或天数存下之后，立刻清理一次（主进程自己排，出错自己记；这里不等结果）。
  storageChanged?(): void;
}, updated: () => Promise<void>) {
  let pending = false;
  const get = async (args: unknown[]): Promise<Settings> => {
    if (args.length) throw new Error('读取设置不需要参数。');
    return { ...await core.readSettings(), openAtLogin: core.getLogin() };
  };
  const set = async (args: unknown[]) => {
    if (args.length !== 1) throw new Error('设置参数数量不对。');
    const { openAtLogin, ...patch } = settingsPatch(args[0]);
    if (pending) throw new Error('设置正在保存，请稍等。');
    pending = true;
    try {
      if (Object.keys(patch).length) await core.writeSettings(patch);
      if (openAtLogin !== undefined) core.setLogin(openAtLogin);
      if (patch.appearance !== undefined) core.setAppearance?.(patch.appearance);
      if (patch.storage !== undefined) core.storageChanged?.();
      await updated();
      return await get([]);
    } finally { pending = false; }
  };
  return { get, set };
}

// 刷新额度：同一时间只跑一次，两次之间（按上一次结束算）至少隔 gapMs。
// 查询本身是核心的 queryQuota（和 xagents quota 同一个）；它会启动各家自己的命令行，应用不联网、不开端口。
export const QUOTA_GAP_MS = 60_000;
export function quotaRefresher(core: { query(): Promise<unknown>; now?(): number }, updated: () => Promise<void>, gapMs = QUOTA_GAP_MS) {
  const now = core.now ?? Date.now;
  let running = false, finished = -Infinity;
  const cooling = () => finished + gapMs - now();
  const refresh = async (args: unknown[]) => {
    if (args.length) throw new Error('刷新额度不需要参数。');
    if (running) throw new Error('正在刷新额度，请稍等。');
    if (cooling() > 0) throw new Error('刚刷新过，请稍后再试。');
    running = true;
    try { await core.query(); }
    finally { running = false; finished = now(); }
    await updated();
  };
  // 定时刷新：正在刷新或刚刷新过就跳过，不当成错误。
  const auto = async (onError: (error: unknown) => void) => {
    if (running || cooling() > 0) return;
    try { await refresh([]); } catch (error) { onError(error); }
  };
  return { refresh, auto };
}
// IPC 入口：先验来源窗口，再交给刷新器（它拒绝任何参数）。
export function quotaRefreshHandler(refresher: Pick<ReturnType<typeof quotaRefresher>, 'refresh'>, trusted: (event: IpcMainInvokeEvent) => boolean) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error('不允许的请求来源。');
    await refresher.refresh(args);
  };
}
