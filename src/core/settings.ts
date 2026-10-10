import { builtinWhos, isBuiltin, isChannel, isModelName, isWho, keptWhos, loadRoster, setModelsCatalog, spec, specFor, vendorOf, whos } from './roster.ts';
import type { ModelsConfig, Vendor } from './roster.ts';
import { discoveredModel, readModelsCache, timestamp } from './model-cache.ts';
import type { ModelsCache } from './model-cache.ts';
import { join } from 'node:path';
import { paths } from './paths.ts';
import { readOptional, withLock, writeJson } from './fsx.ts';
import { effectiveWorkers, validateWorkersPatch } from './policy.ts';
import type { WorkersPolicy } from './policy.ts';
import { relativePath } from './project.ts';

// 外观：跟随系统、浅色、深色；缺省或写坏了都按跟随系统。
export const appearances = ['system', 'light', 'dark'] as const;
export type Appearance = typeof appearances[number];
export const isAppearance = (value: unknown): value is Appearance => appearances.includes(value as Appearance);
// 已归档的项目名（去重、按名字排好）。名字规则和登记项目一样（字母、汉字、数字、下划线、连字符），最多 200 个。
const PROJECT_NAME = /^[\p{L}\p{N}_-]+$/u;
const isArchived = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200
  && value.every(n => typeof n === 'string' && n.length <= 64 && n !== '.' && n !== '..' && PROJECT_NAME.test(n));
const tidyArchived = (names: string[]) => [...new Set(names)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
export type Settings = { keepAwake: boolean; notifications: boolean; appearance: Appearance; storage: Storage; limits: Limits; archivedProjects: string[]; columns?: Record<string, string>; workers: WorkersPolicy; networkAllowed: boolean; models: ModelsConfig };
export type SettingsPatch = Partial<Omit<Settings, 'workers' | 'networkAllowed' | 'models'>> & { workers?: WorkersPolicy };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const columns = (value: unknown): value is Record<string, string> => object(value) && Object.values(value).every(v => typeof v === 'string');
// 派活限制只由主人在桌面应用里修改；同时最多跑不能超过 LIMIT_CAPS。
// maxRunning：同时在跑加排队的上限，1–12；quotaStop：50%、60%、70%、80%、90%、不设限（null）。
// 缺省 80%；null 只关闭百分比停派，厂家报告已触顶时仍拒绝（2026-10-10 主人决定）。
export const LIMIT_CAPS = { maxRunning: 12 } as const;
export const quotaStops = [50, 60, 70, 80, 90, null] as const;
export type QuotaStop = typeof quotaStops[number];
export const isQuotaStop = (value: unknown): value is QuotaStop => quotaStops.some(stop => stop === value);
export type Limits = { maxRunning: number; quotaStop: QuotaStop };
export const defaultLimits: Limits = { maxRunning: LIMIT_CAPS.maxRunning, quotaStop: 80 };
const isLimits = (value: unknown): value is Limits => object(value) && Object.keys(value).every(k => k === 'maxRunning' || k === 'quotaStop')
  && Number.isInteger(value.maxRunning) && (value.maxRunning as number) >= 1 && (value.maxRunning as number) <= LIMIT_CAPS.maxRunning
  && isQuotaStop(value.quotaStop);
// 自动清理旧日志：活结束多少天后，把原始日志和运行文件移到废纸篓（任务记录、报告、改动、打分都留着）。只许 7、14、30 天。
export const slimDays = [7, 14, 30] as const;
export type SlimDays = typeof slimDays[number];
export type Storage = { slim: boolean; days: SlimDays };
const isStorage = (value: unknown): value is Storage => object(value) && Object.keys(value).every(k => k === 'slim' || k === 'days')
  && typeof value.slim === 'boolean' && slimDays.includes(value.days as SlimDays);

async function readConfig(): Promise<Record<string, unknown>> {
  const raw = await readOptional(join(paths().home, 'config.json'));
  if (!raw.trim()) return {};
  try { const value: unknown = JSON.parse(raw); return object(value) ? value : {}; }
  catch { return {}; }
}
function settings(config: Record<string, unknown>): Settings {
  const models = effectiveModels(config.models);
  loadRoster(models.extra, models.dropped);
  const colors = config.columns ?? (object(config.board) ? config.board.columns : undefined);
  return {
    keepAwake: typeof config.keepAwake === 'boolean' ? config.keepAwake : true,
    notifications: typeof config.notifications === 'boolean' ? config.notifications : true,
    appearance: isAppearance(config.appearance) ? config.appearance : 'system',
    storage: isStorage(config.storage) ? config.storage : { slim: true, days: 14 },
    limits: isLimits(config.limits) ? config.limits : { ...defaultLimits },
    archivedProjects: isArchived(config.archivedProjects) ? tidyArchived(config.archivedProjects) : [],
    workers: effectiveWorkers(config.workers), models,
    // 联网总开关：缺省或写坏了都按关，旧的项目 network 字段忽略。
    networkAllowed: config.networkAllowed === true,
    ...(columns(colors) ? { columns: colors } : {}),
  };
}

// 额外禁读的家目录位置（相对家目录，例如 ".my-secrets"），三家隔离都加上。只在 config.json 里手写，只能多加限制；
// 写错了一律报错、不派活，不会悄悄少一层保护。
export async function extraDenyRead(): Promise<string[]> {
  const value = (await readConfig()).denyReadHome;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every(v => typeof v === 'string' && v.length <= 200 && !v.startsWith('~') && !/[\u0000-\u001f\u007f]/u.test(v))) {
    throw new Error('设置里的 denyReadHome 必须是相对家目录的路径列表（例如 [".my-secrets"]），最多 50 项。');
  }
  for (const v of value) relativePath(v);
  return [...new Set(value as string[])];
}

// 写入是先写临时文件再改名，读不到半截内容。读不加锁，否则每次读都会建了再删锁目录，把文件监视叫醒。
export async function readSettings(): Promise<Settings> {
  const [config, cache] = await Promise.all([readConfig(), readModelsCache()]);
  const current = settings(config);
  setModelsCatalog(cache);
  return current;
}

// 回调在设置锁内读取并计算补丁，避免并发读改写丢失更新。
export async function writeSettings(update: SettingsPatch | ((current: Settings) => SettingsPatch)): Promise<void> {
  await withLock(paths().home, async () => {
    const config = await readConfig();
    const current = settings(config);
    const patch = typeof update === 'function' ? update(structuredClone(current)) : update;
    if (object(patch) && Object.hasOwn(patch, 'autoUpdateCheck')) throw new Error('自动检查更新不能通过普通设置补丁修改，请使用专门的开关。');
    if (object(patch) && (Object.hasOwn(patch, 'network') || Object.hasOwn(patch, 'networkAllowed'))) throw new Error('联网不能通过普通设置补丁修改，请使用桌面应用的联网总开关。');
    if (!object(patch) || Object.entries(patch).some(([key, value]) =>
      key === 'workers' ? false : key === 'columns' ? !columns(value) : key === 'appearance' ? !isAppearance(value) : key === 'storage' ? !isStorage(value) : key === 'limits' ? !isLimits(value) : key === 'archivedProjects' ? !isArchived(value) : !['keepAwake', 'notifications'].includes(key) || typeof value !== 'boolean')) {
      throw new Error(`设置不合法：防休眠和通知须为开或关，外观须为跟随系统、浅色或深色，自动清理须为开或关、天数只能 7、14、30，同时最多跑 1–${LIMIT_CAPS.maxRunning} 件、额度停派线只能 50%、60%、70%、80%、90%、不设限，归档项目须为项目名列表，列颜色须为文字映射。`);
    }
    const workersPatch = Object.hasOwn(patch, 'workers') ? validateWorkersPatch(patch.workers) : {};
    const workers = { ...current.workers, ...workersPatch };
    if (!keptWhos.some(who => workers[who]?.enabled)) throw new Error('至少要有一位选手开着，请先打开另一位选手。');
    const archived = patch.archivedProjects ? { archivedProjects: tidyArchived(patch.archivedProjects) } : {};
    const { network: _network, ...retained } = config;
    await writeJson(join(paths().home, 'config.json'), { ...retained, ...current, ...patch, ...archived, workers });
  });
}

// 联网总开关只能走这里（桥上单独一个函数），普通设置补丁改不了。
export async function setNetworkAllowed(on: unknown): Promise<void> {
  if (typeof on !== 'boolean') throw new Error('联网总开关只能是开或关。');
  await withLock(paths().home, async () => {
    const config = await readConfig();
    const { network: _network, ...retained } = config;
    await writeJson(join(paths().home, 'config.json'), { ...retained, networkAllowed: on });
  });
}

// 在线更新独立于选手联网权限；普通设置补丁没有这个字段，也不能修改它。
export async function readAutoUpdateCheck(): Promise<boolean> {
  const value = (await readConfig()).autoUpdateCheck;
  return typeof value === 'boolean' ? value : true;
}
export async function setAutoUpdateCheck(on: unknown): Promise<void> {
  if (typeof on !== 'boolean') throw new Error('自动检查更新只能是开或关。');
  await withLock(paths().home, async () => {
    const config = await readConfig();
    await writeJson(join(paths().home, 'config.json'), { ...config, autoUpdateCheck: on });
  });
}

// 配置逐项回退，只返回规范化结果；不会因读取坏项而写盘。
export function effectiveModels(stored: unknown): ModelsConfig {
  const result: ModelsConfig = { extra: {}, dropped: [], seen: {} };
  if (!object(stored)) return result;
  if (object(stored.extra)) for (const [who, value] of Object.entries(stored.extra)) {
    if (!object(value) || !isChannel(value.channel) || value.channel === 'deepseek' || !timestamp(value.added)) continue;
    const m = discoveredModel(value.channel, { ...value, fast: value.fast !== undefined });
    if (!m) continue;
    const s = specFor(value.channel, m);
    if (s.who !== who || isBuiltin(who)) continue;
    if (value.fast !== undefined && (!object(value.fast) || !s.fast || Object.keys(value.fast).length !== 1
      || ('model' in s.fast ? value.fast.model !== s.fast.model : value.fast.suffix !== s.fast.suffix))) continue;
    result.extra[who] = { channel: value.channel, model: m.model, shown: m.shown, efforts: m.efforts,
      ...(m.description !== undefined ? { description: m.description } : {}), ...(s.fast ? { fast: s.fast } : {}), added: value.added };
  }
  const known = new Set([...builtinWhos, ...Object.keys(result.extra)]);
  if (Array.isArray(stored.dropped)) result.dropped = [...new Set(stored.dropped.filter((w): w is string => typeof w === 'string' && known.has(w)))];
  if (result.dropped.length === known.size) result.dropped = [];
  if (object(stored.seen)) for (const [channel, models] of Object.entries(stored.seen)) {
    if (isChannel(channel) && Array.isArray(models)) result.seen[channel] = [...new Set(models.filter(isModelName))];
  }
  return result;
}
export async function loadConfiguredRoster(): Promise<void> { await readSettings(); }

// 桥与核心共用参数边界；只接受整份模型名列表，绝不收通道接法、隔离或任意配置字段。
export function modelSelection(channel: unknown, models: unknown): { channel: Vendor; models: string[] } {
  if (!isChannel(channel)) throw new Error('模型通道只能选 Codex、Grok、Cursor 或 DeepSeek。');
  if (!Array.isArray(models) || models.length > 500 || !Array.from(models).every(isModelName)) throw new Error('保留模型须为模型名列表，最多 500 项。');
  if (new Set(models).size !== models.length) throw new Error('保留的模型不能重复。');
  return { channel, models: [...models] };
}
// 第一次问到某一家的名单时，把它记成基线（seen）：之后新冒出来的才标“新”，不然头一回三十个模型全是“新”，没有意义。
// 已经有基线的通道不动（主人保存选择时才更新）。
export async function baselineSeenModels(cache: ModelsCache | null): Promise<void> {
  if (!cache) return;
  await withLock(paths().home, async () => {
    const config = await readConfig(), current = settings(config), seen = { ...current.models.seen };
    let changed = false;
    for (const [channel, entry] of Object.entries(cache.channels)) {
      if (!isChannel(channel) || channel === 'deepseek' || seen[channel] !== undefined || !entry?.models.length) continue;
      seen[channel] = entry.models.map(m => m.model); changed = true;
    }
    if (changed) await writeJson(join(paths().home, 'config.json'), { ...config, models: { ...current.models, seen } });
  });
}
export async function keepModels(channelValue: unknown, modelValues: unknown): Promise<void> {
  const { channel, models } = modelSelection(channelValue, modelValues);
  await withLock(paths().home, async () => {
    const config = await readConfig();
    const current = settings(config);
    const cache = await readModelsCache();
    const latest = channel === 'deepseek' ? [] : cache?.channels[channel]?.models ?? [];
    const extra = { ...current.models.extra };
    const chosen: string[] = [];
    for (const model of models) {
      const existing = whos.find(w => vendorOf(w) === channel && spec(w).model === model);
      if (existing) { chosen.push(existing); continue; }
      if (channel === 'deepseek') throw new Error('DeepSeek 只能在内置两位里选。');
      const discovered = latest.find(m => m.model === model);
      if (!discovered) throw new Error(`模型 ${model} 不在这一家最近的名单里，请先刷新。`);
      const s = specFor(channel, discovered);
      if (isWho(s.who) || Object.hasOwn(extra, s.who)) throw new Error(`模型 ${model} 的选手号 ${s.who} 与已有模型冲突，不能保留。`);
      extra[s.who] = { channel, model, shown: discovered.shown, efforts: [...s.efforts],
        ...(discovered.description !== undefined ? { description: discovered.description } : {}),
        ...(s.fast ? { fast: s.fast } : {}), added: new Date().toISOString() };
      chosen.push(s.who);
    }
    const dropped = new Set(current.models.dropped);
    for (const who of whos.filter(w => vendorOf(w) === channel)) {
      if (chosen.includes(who)) dropped.delete(who); else dropped.add(who);
    }
    for (const who of chosen) dropped.delete(who);
    if (![...whos, ...chosen].some(who => !dropped.has(who))) throw new Error('至少保留一位选手，请先保留另一位。');
    const next: ModelsConfig = { extra, dropped: [...dropped], seen: { ...current.models.seen,
      [channel]: channel === 'deepseek' ? whos.filter(w => vendorOf(w) === channel).map(w => spec(w).model) : latest.map(m => m.model) } };
    await writeJson(join(paths().home, 'config.json'), { ...config, models: next });
    loadRoster(next.extra, next.dropped);
    setModelsCatalog(cache);
  });
}
