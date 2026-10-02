import type { Job, Who } from './job.ts';
import { active } from './job.ts';
import { isolationOf, spec, vendorOf } from './roster.ts';
import { awakeSeconds, median } from './duration.ts';
import type { Verification } from './verify.ts';

// verified：有验收记录的件数；passed：其中通过的。没有记录的活不进分母，也不算不合格。
// averageSeconds：只算做完了（done）的活，扣掉电脑休眠的时间；停下、断了、出错的不算。
export type Stat = { who: Who; fast: boolean; kind: string; count: number; small: boolean; doneRate: number; verified: number; passed: number; verifyRate: number | null; adopted: number; adoptRate: number; secondsSamples: number; averageSeconds: number | null; quotaSamples: number; averageQuotaDelta: number | null };
// 同一选手、同一类活、同一版本（快速版分开）做完的件数不到这个数，就不给“通常多久”。
export const TYPICAL_MIN = 3;
export type Typical = { who: Who; fast: boolean; kind: string; count: number; seconds: number };
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const percent = (v: unknown) => numeric(v) && v >= 0 && v <= 100 ? v : null;
// 接受服务端原始字段；缺数据不补零。02a 的缓存如另有结构，只需在此适配。
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export function quotaUsed(snapshot: unknown, who: Who): number | null {
  if (vendorOf(who) !== isolationOf(who)) return null; // DeepSeek 不占 Codex 的额度
  const s = object(object(snapshot)[isolationOf(who)]);
  if (isolationOf(who) === 'codex') return percent(object(s.secondary).used_percent ?? object(object(s.rate_limits).secondary).used_percent);
  if (isolationOf(who) === 'grok') return percent(object(s.config).creditUsagePercent ?? s.creditUsagePercent ?? s.usedPercent);
  const value = s[spec(who).pool ?? 'api'];
  return percent(typeof value === 'number' ? value : object(value).usedPercent);
}
export function stats(jobs: Job[]): Stat[] {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) if (!active(job)) {
    const key = JSON.stringify([job.who, Boolean(job.fast), job.kind]);
    const group = groups.get(key) || []; group.push(job); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const verified = group.filter(j => typeof (j.verify as Verification)?.ok === 'boolean');
    const seconds = group.filter(j => j.state === 'done').flatMap(j => awakeSeconds(j) ?? []);
    const deltas = group.flatMap(j => {
      const snapshot = j as Job & { quota_before?: unknown; quota_after?: unknown };
      const before = quotaUsed(snapshot.quota_before, j.who), after = quotaUsed(snapshot.quota_after, j.who);
      // 重置或缺快照时，不把负值、未知值混入平均消耗。
      return before !== null && after !== null && after >= before ? [after - before] : [];
    });
    const passed = verified.filter(j => (j.verify as Verification).ok).length, adopted = group.filter(j => j.decision?.kind === 'adopt').length;
    const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return { who: group[0].who, fast: Boolean(group[0].fast), kind: group[0].kind, count: group.length, small: group.length < 3,
      doneRate: group.filter(j => j.state === 'done').length / group.length,
      verified: verified.length, passed, verifyRate: verified.length ? passed / verified.length : null,
      adopted, adoptRate: adopted / group.length,
      secondsSamples: seconds.length, averageSeconds: average(seconds), quotaSamples: deltas.length, averageQuotaDelta: average(deltas) };
  }).sort((a, b) => a.who.localeCompare(b.who) || Number(a.fast) - Number(b.fast) || a.kind.localeCompare(b.kind, 'zh-CN'));
}
// “通常多久”：做完了的活扣掉休眠后的中位数；不够 TYPICAL_MIN 件的组合不出现。
export function typicals(jobs: Job[]): Typical[] {
  const groups = new Map<string, { who: Who; fast: boolean; kind: string; seconds: number[] }>();
  for (const job of jobs) {
    const seconds = job.state === 'done' ? awakeSeconds(job) : null;
    if (seconds === null || seconds <= 0) continue;
    const key = JSON.stringify([job.who, Boolean(job.fast), job.kind]);
    const group = groups.get(key) ?? { who: job.who, fast: Boolean(job.fast), kind: job.kind, seconds: [] };
    group.seconds.push(seconds); groups.set(key, group);
  }
  return [...groups.values()].filter(g => g.seconds.length >= TYPICAL_MIN)
    .map(g => ({ who: g.who, fast: g.fast, kind: g.kind, count: g.seconds.length, seconds: median(g.seconds)! }));
}
export const typicalFor = (list: Typical[], job: { who: Who; fast?: boolean; kind: string }): number | null =>
  list.find(t => t.who === job.who && t.fast === Boolean(job.fast) && t.kind === job.kind)?.seconds ?? null;
