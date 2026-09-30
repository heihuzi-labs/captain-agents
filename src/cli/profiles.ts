import type { Profile } from '../core/profiles.ts';
import { table } from './format.ts';

export function profilesTable(rows: Profile[]): string {
  if (!rows.length) return '还没有已结束的任务档案。';
  const tags = (items: Profile['good']) => items.map(({ tag, n }) => `${tag}（${n}）`).join('、') || '—';
  return table(['选手', '类型', '件数', '平均分', '返工比例', '平均用时（做完的，不含休眠）', '平均步数', '跑命令', '优点', '毛病', '说明'], rows.map(r => [
    `${r.who}${r.fast ? '（快速版）' : ''}`, r.kind, String(r.count), r.avgScore === null ? '—' : `${r.avgScore.toFixed(1)} 分`,
    r.reworkRate === null ? '—' : `${(r.reworkRate * 100).toFixed(1)}%`, r.avgSeconds === null ? '—' : `${r.avgSeconds.toFixed(1)} 秒`,
    r.avgSteps === null ? '—' : r.avgSteps.toFixed(1), r.avgToolSeconds === null ? '—' : `${r.avgToolSeconds.toFixed(1)} 秒`,
    tags(r.good), tags(r.bad), r.small ? '样本少，仅供参考' : '',
  ]));
}
