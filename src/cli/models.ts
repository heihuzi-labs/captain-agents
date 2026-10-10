import type { ViewModels } from '../core/view-types.ts';
import type { ModelResult } from '../core/models.ts';
export function formatModels(results: ModelResult[]) {
  return results.map(result => {
    const name = { codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }[result.provider];
    return `${name}：${result.error ? `查不到（${result.error}）` : ''}\n` +
      result.current.map(item => `  当前 ${item.who}：${item.model}（${item.present === null ? '无法核对' : item.present ? '在列表中' : '不在列表中'}）`).join('\n') +
      (result.models.length ? '\n' + result.models.map(m => `  ${m.slug}  ${m.name}${m.visibility ? `  可见性：${m.visibility}` : ''}`).join('\n') : '');
  }).join('\n\n');
}

export function formatDiscoveredModels(view: ViewModels) {
  return view.channels.map(c => `${c.name} 发现的模型：${c.error ? `查询失败（${c.error}），沿用上次名单` : !c.discoverable ? '仅内置模型' : c.at ? '' : '尚未刷新'}\n` +
    c.models.map(m => `  ${m.model}  ${m.shown}（${m.kept ? '保留' : '未保留'}${m.gone ? '，已下线' : ''}${m.fresh ? '，新' : ''}）`).join('\n')).join('\n\n');
}
