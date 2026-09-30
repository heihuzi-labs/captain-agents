import type { Stat } from '../core/stats.ts';
import { table } from './format.ts';
export function statsTable(rows: Stat[]) {
  const rate = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
  return table(['选手', '类型', '次数', '做完率', '验收通过率', '采用率', '平均用时（做完的，不含休眠）', '平均额度变化'], rows.map(r => [r.fast ? `${r.who}（快速版）` : r.who, r.kind, `${r.count}${r.small ? '（少）' : ''}`, rate(r.doneRate), r.verified ? `${rate(r.verifyRate)}（${r.passed}/${r.verified} 合格）` : '—（没有验收记录）', rate(r.adoptRate), r.averageSeconds === null ? '—' : `${r.averageSeconds.toFixed(1)} 秒`, r.averageQuotaDelta === null ? '—' : `${r.averageQuotaDelta.toFixed(2)} 个百分点` ]));
}
