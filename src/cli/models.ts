import type { ModelResult } from '../core/models.ts';
export function formatModels(results: ModelResult[]) {
  return results.map(result => {
    const name = { codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }[result.provider];
    return `${name}：${result.error ? `查不到（${result.error}）` : ''}\n` +
      result.current.map(item => `  当前 ${item.who}：${item.model}（${item.present === null ? '无法核对' : item.present ? '在列表中' : '不在列表中'}）`).join('\n') +
      (result.models.length ? '\n' + result.models.map(m => `  ${m.slug}  ${m.name}${m.visibility ? `  可见性：${m.visibility}` : ''}`).join('\n') : '');
  }).join('\n\n');
}
