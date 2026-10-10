// 只读缓存放在这里，设置装载无需依赖启动各家程序的发现逻辑。
import { join } from 'node:path';
import { readOptional } from './fsx.ts';
import { paths } from './paths.ts';
import { isModelName, isolations, specFor } from './roster.ts';
import type { DiscoveredModel, Effort, ModelsCache, Vendor } from './roster.ts';
export type { ModelsCache } from './roster.ts';
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function discoveredModel(channel: Vendor, value: unknown): DiscoveredModel | null {
  if (!object(value) || !isModelName(value.model) || typeof value.shown !== 'string' || !value.shown.trim()
    || value.shown.length > 500 || typeof value.fast !== 'boolean' || !Array.isArray(value.efforts)
    || (value.description !== undefined && typeof value.description !== 'string')) return null;
  const efforts = (['medium', 'high', 'xhigh'] as Effort[]).filter(e => (value.efforts as unknown[]).includes(e));
  if (!efforts.length) return null;
  const model: DiscoveredModel = { model: value.model, shown: value.shown, efforts, fast: channel === 'codex' || channel === 'deepseek' ? false : value.fast,
    ...(typeof value.description === 'string' ? { description: value.description } : {}) };
  try { specFor(channel, model); return model; } catch { return null; }
}
export async function readModelsCache(): Promise<ModelsCache | null> {
  const raw = await readOptional(join(paths().cache, 'models.json'));
  if (!raw.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value) || !timestamp(value.at) || !object(value.channels)) return null;
  const cache: ModelsCache = { at: value.at, channels: {} };
  for (const channel of isolations) {
    const entry = value.channels[channel];
    if (!object(entry) || !timestamp(entry.at) || !Array.isArray(entry.models) || (entry.error !== undefined && typeof entry.error !== 'string')) continue;
    const models = entry.models.map(m => discoveredModel(channel, m));
    // 坏缓存不能冒充一次成功的空名单，把所有模型误标成下线。
    if (models.some(m => !m)) continue;
    cache.channels[channel] = { at: entry.at, models: models as DiscoveredModel[], ...(typeof entry.error === 'string' ? { error: entry.error } : {}) };
  }
  return cache;
}
