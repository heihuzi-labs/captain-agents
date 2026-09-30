import type { DashboardSlice, Tokens } from '../core/dashboard.ts';
import { rangeLabel } from '../core/dashboard.ts';
import { spec } from '../core/roster.ts';
import { duration, localTime, number, table } from './format.ts';

const rate = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const score = (value: number | null) => value === null ? '—' : `${value.toFixed(1)} 分`;
const points = (value: number | null) => value === null ? '—' : `${value > 0 && value < 0.005 ? '<0.01' : value < 1 ? value.toFixed(2) : value.toFixed(1)} 个百分点`;
const tokenCells = (tokens: Tokens | null) => tokens ? [number(tokens.fresh), number(tokens.cached), number(tokens.out)] : ['—', '—', '—'];

export function formatReport(report: DashboardSlice): string {
  const { kpi, workers, daily, projects } = report;
  const blocks = [
    `仪表盘 · ${rangeLabel[report.range]} · ${report.project || '全部项目（含已归档）'}\n${localTime(report.from)} 至 ${localTime(report.to)}`,
    `汇总\n件数 ${kpi.jobs} · 做完 ${kpi.done} · 出错、失联或停下 ${kpi.failed}\n采用率 ${rate(kpi.adoptRate)} · 平均分 ${score(kpi.avgScore)} · 总用时 ${duration(kpi.seconds)}\ntoken：新读 ${number(kpi.tokens.fresh)} · 缓存命中 ${number(kpi.tokens.cached)} · 写出 ${number(kpi.tokens.out)}\n没有 token 记录 ${kpi.withoutUsage} 件`,
    `各池额度（按用量分摊）\n${kpi.pools.length ? table(['额度池', '花费', '件数'], kpi.pools.map(p => [p.pool, points(p.points), String(p.jobs)])) : '暂无记录。'}`,
    `各家对比（额度按用量分摊）\n${table(['选手', '件数', '采用率', '平均分', '返工比例', '用时中位数', '新读中位数', '缓存中位数', '写出中位数', '每件额度（平均）', '缺用量件数'], workers.map(w => [
      spec(w.who).name, String(w.jobs), rate(w.adoptRate), score(w.avgScore), rate(w.reworkRate), w.medianSeconds === null ? '—' : duration(w.medianSeconds),
      ...tokenCells(w.medianTokens), points(w.avgPoints), String(w.withoutUsage),
    ]))}`,
    `每天\n${table(['日期', '件数', '新读', '缓存命中', '写出'], daily.map(d => [d.day, String(d.jobs), ...tokenCells(d.tokens)]))}`,
  ];
  if (!report.project) blocks.push(`按项目\n${table(['项目', '件数', '总用时', '新读', '缓存命中', '写出'], projects.map(p => [p.name, String(p.jobs), duration(p.seconds), ...tokenCells(p.tokens)]))}`);
  return blocks.join('\n\n');
}
