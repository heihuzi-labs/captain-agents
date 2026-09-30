import type { QuotaSnapshot } from '../core/quota.ts';
import { localTime } from './format.ts';
const line = (entry: QuotaSnapshot['providers'][number]) => `套餐 ${entry.plan ?? '未知'}；${entry.bars.map(b => `${b.label} ${b.used === null ? '查不到' : `${b.approx ? '不到 ' : ''}${b.used}%`}，${localTime(b.reset)} 重置`).join('；')}${entry.reached ? `；已触顶：${entry.reached}` : ''}${entry.onDemand ? `；按量付费 ${entry.onDemand}` : ''}（数据时间 ${localTime(entry.at)}）`;
// 这次没查到但有上一次的数据：照样列出，并写明是上一次的。
export function formatQuota(snapshot: QuotaSnapshot) {
  return snapshot.providers.map(entry => !entry.error ? `${entry.name}：${line(entry)}`
    : entry.bars.some(b => b.used !== null) ? `${entry.name}：这次没查到（${entry.error}）；上一次的数据：${line(entry)}`
    : `${entry.name}：查不到（${entry.error}）`).join('\n');
}
