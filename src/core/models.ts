import { codexPath } from './workers.ts';
import { launchModels, isolationOf, isolations, vendorOf } from './roster.ts';
import { cleanTerminal, executeQuery, grokEnvironment } from './quota.ts';
import type { Provider, QueryExecutor } from './quota.ts';
import type { Who } from './job.ts';

export type Model = { slug: string; name: string; visibility?: string };
export type ModelResult = { provider: Provider; models: Model[]; current: { who: Who; model: string; present: boolean | null }[]; error?: string };
export function parseCodexModels(raw: string): Model[] {
  const data = JSON.parse(raw), list = Array.isArray(data) ? data : data.models;
  if (!Array.isArray(list)) throw new Error('模型列表格式无法识别');
  return list.map(item => {
    if (typeof item?.slug !== 'string' || !item.slug) throw new Error('模型列表缺少 slug');
    return { slug: item.slug, name: item.display_name ?? item.slug, ...(typeof item.visibility === 'string' ? { visibility: item.visibility } : {}) };
  });
}
export function parseTextModels(raw: string, provider: 'grok' | 'cursor'): Model[] {
  const models = new Map<string, Model>();
  for (const line of cleanTerminal(raw).replace(/[\u200b-\u200d\ufeff]/g, '').split('\n')) {
    // 接受项目符号、表格和“slug - 名称”，仅把完整模型标识当成候选。
    const match = /(?:^|[\s│|*•>])((?:claude|gpt|grok)-[a-z0-9][a-z0-9.+_-]*)(?=$|[\s│|:(])/i.exec(line);
    if (!match || (provider === 'grok' && !match[1].startsWith('grok-'))) continue;
    const slug = match[1], remainder = line.slice(match.index + match[0].length).replace(/^[\s│|:–—-]+/, '').replace(/[│|]\s*$/, '').trim();
    models.set(slug, { slug, name: remainder || slug });
  }
  if (!models.size) throw new Error('未识别到 Claude、GPT 或 Grok 的模型列表');
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
    } catch (e) { return { provider, models: [], current, error: (e as Error).message }; }
  }));
}
