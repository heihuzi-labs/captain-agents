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
export type Settings = { keepAwake: boolean; notifications: boolean; appearance: Appearance; storage: Storage; limits: Limits; archivedProjects: string[]; columns?: Record<string, string>; workers: WorkersPolicy };
export type SettingsPatch = Partial<Omit<Settings, 'workers'>> & { workers?: Partial<WorkersPolicy> };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const columns = (value: unknown): value is Record<string, string> => object(value) && Object.values(value).every(v => typeof v === 'string');
// 派活限制：只能往严了调，不能超过 LIMIT_CAPS（原来写死的值）。
// maxRunning：同时在跑加排队的上限，1–12；quotaStop：某家本期额度用到这个百分比就不再派给它，只许 50、60、70、80。
export const LIMIT_CAPS = { maxRunning: 12, quotaStop: 80 } as const;
export const quotaStops = [50, 60, 70, 80] as const;
export type QuotaStop = typeof quotaStops[number];
export type Limits = { maxRunning: number; quotaStop: QuotaStop };
export const defaultLimits: Limits = { maxRunning: LIMIT_CAPS.maxRunning, quotaStop: LIMIT_CAPS.quotaStop };
const isLimits = (value: unknown): value is Limits => object(value) && Object.keys(value).every(k => k === 'maxRunning' || k === 'quotaStop')
  && Number.isInteger(value.maxRunning) && (value.maxRunning as number) >= 1 && (value.maxRunning as number) <= LIMIT_CAPS.maxRunning
  && quotaStops.includes(value.quotaStop as QuotaStop);
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
  const colors = config.columns ?? (object(config.board) ? config.board.columns : undefined);
  return {
    keepAwake: typeof config.keepAwake === 'boolean' ? config.keepAwake : true,
    notifications: typeof config.notifications === 'boolean' ? config.notifications : true,
    appearance: isAppearance(config.appearance) ? config.appearance : 'system',
    storage: isStorage(config.storage) ? config.storage : { slim: true, days: 14 },
    limits: isLimits(config.limits) ? config.limits : { ...defaultLimits },
    archivedProjects: isArchived(config.archivedProjects) ? tidyArchived(config.archivedProjects) : [],
    workers: effectiveWorkers(config.workers),
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
  return settings(await readConfig());
}

// 回调在设置锁内读取并计算补丁，避免并发读改写丢失更新。
export async function writeSettings(update: SettingsPatch | ((current: Settings) => SettingsPatch)): Promise<void> {
  await withLock(paths().home, async () => {
    const config = await readConfig();
    const current = settings(config);
    const patch = typeof update === 'function' ? update(structuredClone(current)) : update;
    if (!object(patch) || Object.entries(patch).some(([key, value]) =>
      key === 'workers' ? false : key === 'columns' ? !columns(value) : key === 'appearance' ? !isAppearance(value) : key === 'storage' ? !isStorage(value) : key === 'limits' ? !isLimits(value) : key === 'archivedProjects' ? !isArchived(value) : !['keepAwake', 'notifications'].includes(key) || typeof value !== 'boolean')) {
      throw new Error(`设置不合法：防休眠和通知须为开或关，外观须为跟随系统、浅色或深色，自动清理须为开或关、天数只能 7、14、30，同时最多跑 1–${LIMIT_CAPS.maxRunning} 件、额度停派线只能 50%、60%、70%、80%，归档项目须为项目名列表，列颜色须为文字映射。`);
    }
    const workersPatch = Object.hasOwn(patch, 'workers') ? validateWorkersPatch(patch.workers) : {};
    const workers = { ...current.workers, ...workersPatch };
    if (!Object.values(workers).some(worker => worker.enabled)) throw new Error('至少要有一位选手开着，请先打开另一位选手。');
    const archived = patch.archivedProjects ? { archivedProjects: tidyArchived(patch.archivedProjects) } : {};
    await writeJson(join(paths().home, 'config.json'), { ...config, ...current, ...patch, ...archived, workers });
  });
}
