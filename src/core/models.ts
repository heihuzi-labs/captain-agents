import { join } from 'node:path';
import { paths } from './paths.ts';
import { withLock, writeJson } from './fsx.ts';
import { readModelsCache } from './model-cache.ts';
export { readModelsCache } from './model-cache.ts';
import type { DiscoveredModel, Effort, ModelsCache, ModelsConfig } from './roster.ts';
import type { ViewModels } from './view-types.ts';
import { codexPath } from './workers.ts';
import { launchModels, isolationOf, isolations, vendorOf, vendors, channelNames, specFor, whos, spec, isBuiltin, isKept, modelGone, isModelName, setModelsCatalog } from './roster.ts';
import { cleanTerminal, executeQuery, grokEnvironment } from './quota.ts';
import type { Provider, QueryExecutor } from './quota.ts';
import type { Who } from './job.ts';

export type Model = { slug: string; name: string; visibility?: string; description?: string; efforts?: Effort[] };
export type ModelResult = { provider: Provider; models: Model[]; current: { who: Who; model: string; present: boolean | null }[]; error?: string };
export function parseCodexModels(raw: string): Model[] {
  const data = JSON.parse(raw), list = Array.isArray(data) ? data : data.models;
  if (!Array.isArray(list)) throw new Error('模型列表格式无法识别');
  return list.map(item => {
    if (typeof item?.slug !== 'string' || !item.slug) throw new Error('模型列表缺少 slug');
    return { slug: item.slug, name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name : item.slug, ...(typeof item.visibility === 'string' ? { visibility: item.visibility } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(Array.isArray(item.supported_reasoning_levels) ? { efforts: (['medium', 'high', 'xhigh'] as Effort[]).filter(e => item.supported_reasoning_levels.some((v: unknown) => typeof v === 'object' && v !== null && 'effort' in v && v.effort === e)) } : {}) };
  });
}
export function parseTextModels(raw: string, provider: 'grok' | 'cursor'): Model[] {
  const models = new Map<string, Model>();
  let recognizedList = false;
  for (const line of cleanTerminal(raw).replace(/[\u200b-\u200d\ufeff]/g, '').split('\n')) {
    // 接受项目符号、表格和“slug - 名称”，仅把完整模型标识当成候选。
    if (/^\s*(?:[│|*•>\-]\s*)?[a-z][a-z0-9]*-[a-z0-9][a-z0-9.+_-]*(?=$|[\s│|:(])/i.test(line)) recognizedList = true;
    const match = /(?:^|[\s│|*•>])((?:claude|gpt|grok)-[a-z0-9][a-z0-9.+_-]*)(?=$|[\s│|:(])/i.exec(line);
    if (!match || (provider === 'grok' && !match[1].startsWith('grok-'))) continue;
    const slug = match[1], remainder = line.slice(match.index + match[0].length).replace(/^[\s│|:–—-]+/, '').replace(/[│|]\s*$/, '').trim();
    models.set(slug, { slug, name: remainder || slug });
  }
  if (!models.size && !recognizedList) throw new Error('未识别到 Claude、GPT 或 Grok 的模型列表');
  return [...models.values()];
}
export async function queryModels(execute: QueryExecutor = executeQuery): Promise<ModelResult[]> {
  return Promise.all(isolations.map(async provider => {
    // “当前”= 派活工作台按选手、强度、快速版会实际启动的每一个模型名，全部来自选手清单。
    // DeepSeek 的模型不在 Codex 自带的列表里，这里不核对（简单版）；它的模型名以 roster.ts 里写明的核对结果为准。
    const current = launchModels().filter(m => isolationOf(m.who) === provider && vendorOf(m.who) === provider).map(m => ({ ...m, present: null as boolean | null }));
    try {
      const raw = await execute(provider === 'codex' ? { file: codexPath(), args: ['debug', 'models'], timeoutMs: 20_000 }
        : provider === 'grok' ? { file: 'grok', args: ['models'], env: grokEnvironment(), timeoutMs: 20_000 }
          : { file: 'cursor-agent', args: ['--list-models'], timeoutMs: 20_000 });
      const models = provider === 'codex' ? parseCodexModels(raw) : parseTextModels(raw, provider);
      return { provider, models, current: current.map(item => ({ ...item, present: models.some(m => m.slug === item.model) })) };
    } catch (e) { return { provider, models: [], current, error: e instanceof Error ? e.message : String(e) }; }
  }));
}

const effortOrder: Effort[] = ['medium', 'high', 'xhigh'];
// 核对保留原始变体，发现只返回平台能够派出的基础模型。
export function normalizeModels(channel: Provider, models: Model[]): DiscoveredModel[] {
  const out = new Map<string, DiscoveredModel>();
  for (const item of models) {
    if (!isModelName(item.slug)) continue;
    if (channel === 'codex') {
      const efforts = effortOrder.filter(e => item.efforts?.includes(e));
      if (item.visibility !== 'list' || !efforts.length) continue;
      // 官方展示名是“GPT-6.1-Sol”这种写法；和选手表里的“GPT-6 Astra”统一成字母前用空格。
      out.set(item.slug, { model: item.slug, shown: item.name.replace(/-(?=[A-Za-z])/g, ' '), efforts, fast: false, ...(item.description ? { description: item.description } : {}) });
    } else if (channel === 'grok') {
      if (!item.slug.startsWith('grok-') || /-(?:build-fast|fast)$/.test(item.slug)) continue;
      out.set(item.slug, { model: item.slug, shown: item.name, efforts: [...effortOrder], fast: models.some(m => m.slug === `${item.slug}-build-fast`) });
    } else {
      const match = /^((?:claude|gpt|grok)-.+?)-(medium|high|xhigh|low|max|none|extra-high)(-fast)?$/.exec(item.slug);
      if (!match) continue;
      const [, model, effort, fast] = match;
      // 名单里每个强度、快速版各占一行，名字里带着“Low”“None”“Fast”“No Thinking”这类档位字样；合并成一个模型时去掉它们。
      const base = item.name === item.slug ? model : item.name.replace(/\s+\(default\)$/i, '').replace(/\bNo Thinking\b/gi, '')
        .replace(/\b(?:Extra High|XHigh|Medium|High|Low|Max|None|Fast)\b/gi, '').replace(/\s{2,}/g, ' ').trim() || model;
      // 有的“带思考”版本名字里不写 Thinking（只在不带思考的那版写 No Thinking）：补上，免得两行同名。
      const shown = model.endsWith('-thinking') && base !== model && !/thinking/i.test(base) ? `${base} Thinking` : base;
      const entry = out.get(model) ?? { model, shown, efforts: [], fast: false };
      entry.efforts = effortOrder.filter(e => e === effort || entry.efforts.includes(e));
      entry.fast ||= !!fast;
      out.set(model, entry);
    }
  }
  return [...out.values()].filter(m => m.efforts.length);
}
export async function refreshModels(execute: QueryExecutor = executeQuery): Promise<ModelsCache> {
  // 与额度共用 cache 目录的登记锁；查询在锁外并行，失败时在锁内读取最新旧名单。
  const results = await queryModels(execute);
  return withLock(paths().cache, async () => {
    const previous = await readModelsCache();
    const cache = modelsCacheFrom(results, previous);
    await writeJson(join(paths().cache, 'models.json'), cache);
    setModelsCatalog(cache);
    return cache;
  });
}
// 刷新名单，并给第一次问到的通道记下基线（见 settings.ts 的 baselineSeenModels）。命令行和桌面应用都走这里。
export async function refreshModelsWithBaseline(execute: QueryExecutor = executeQuery): Promise<ModelsCache> {
  const cache = await refreshModels(execute);
  const { baselineSeenModels } = await import('./settings.ts');
  await baselineSeenModels(cache);
  return cache;
}
export function viewModels(config: ModelsConfig, cache: ModelsCache | null): ViewModels {
  return { at: cache?.at ?? null, channels: vendors.map(channel => {
    const latest = channel === 'deepseek' ? undefined : cache?.channels[channel];
    const known = whos.filter(who => vendorOf(who) === channel);
    const merged = new Map<string, DiscoveredModel>();
    for (const who of known) {
      const s = spec(who), extra = config.extra[who];
      merged.set(s.model, { model: s.model, shown: s.shown, efforts: [...s.efforts], fast: !!s.fast, ...(extra?.description ? { description: extra.description } : {}) });
    }
    for (const m of latest?.models ?? []) merged.set(m.model, m);
    return { channel, name: channelNames[channel], icon: channel, discoverable: channel !== 'deepseek', at: latest?.at ?? null, error: latest?.error ?? null,
      models: [...merged.values()].map(m => {
        const registered = known.find(w => spec(w).model === m.model);
        const who = registered ?? specFor(channel, m).who;
        // 已经是选手的，名字用选手自己的（名单里的名字带着“1M”这类后缀，和选手表里对不上）。
        return { ...m, shown: registered ? spec(registered).shown : m.shown, who, description: m.description ?? null, kept: registered !== undefined && isKept(registered),
          builtin: registered !== undefined && isBuiltin(registered),
          // 还没有基线（这一家第一次问到）时都不算新。
          fresh: registered === undefined && config.seen[channel] !== undefined && !config.seen[channel]!.includes(m.model),
          gone: registered !== undefined && isKept(registered) && modelGone(registered, cache) };
      }) };
  }) };
}

export function modelsCacheFrom(results: ModelResult[], previous: ModelsCache | null): ModelsCache {
  const at = new Date().toISOString();
  const cache: ModelsCache = { at, channels: {} };
  for (const result of results) cache.channels[result.provider] = {
    at, models: result.error === undefined ? normalizeModels(result.provider, result.models) : previous?.channels[result.provider]?.models ?? [],
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
  return cache;
}
