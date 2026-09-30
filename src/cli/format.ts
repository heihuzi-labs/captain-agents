import type { Job } from '../core/job.ts';
import { awakeSeconds, sleptSeconds, describeTiming, timeSplit } from '../core/duration.ts';
export function duration(seconds: number) {
  const n = Math.max(0, Math.round(seconds));
  if (n >= 3600) return `${Math.floor(n / 3600)} 小时 ${Math.floor(n % 3600 / 60)} 分`;
  return n >= 60 ? `${Math.floor(n / 60)} 分 ${n % 60} 秒` : `${n} 秒`;
}
// 给人看的时间：本地时间“10-04 01:00”；数据文件里仍存 ISO。
export function localTime(value: string | number | Date | null | undefined) {
  const d = new Date(value ?? NaN);
  if (!Number.isFinite(d.getTime())) return '未知时间';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function number(n: number) { return n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万` : String(n); }
const width = (s: string) => [...s].reduce((n, c) => n + (c.codePointAt(0)! > 255 ? 2 : 1), 0);
export function table(headers: string[], rows: string[][]) {
  return tableRows(headers, rows).join('\n');
}
function tableRows(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map(r => width(r[i] || ''))));
  return [headers, ...rows].map(row => row.map((v, i) => v + ' '.repeat(widths[i] - width(v))).join('  ').trimEnd());
}
// 已用时：结束的用登记的用时，在跑的用到现在；都扣掉电脑休眠的时间。
function elapsed(j: Job) {
  const start = Date.parse(j.started || j.created), now = Date.now();
  return awakeSeconds(j) ?? Math.max(0, (now - start) / 1000 - sleptSeconds(j.sleeps, start, now));
}
export function statusTable(jobs: Job[]) {
  const states = { queued: '等', running: '跑', done: '完', failed: '错', lost: '失', stopped: '停' };
  if (!jobs.length) return '没有符合条件的任务。';
  const rows = tableRows(['状态', '任务号', '选手', '模型·强度', '类型', '已用时', '验收', '最近动作', '说明'], jobs.map(j => [states[j.state], j.id, j.who, `${j.model}·${j.effort}${j.fast ? '·快速版' : ''}`, j.kind,
    duration(elapsed(j)), '—', j.activity?.at(-1)?.text || '—', j.error || (j.cleaned ? '已清理' : '')]));
  return rows.map((row, i) => {
    const timing = i ? describeTiming(timeSplit(jobs[i - 1])) : null;
    return timing ? `${row}\n  ${timing}` : row;
  }).join('\n');
}
