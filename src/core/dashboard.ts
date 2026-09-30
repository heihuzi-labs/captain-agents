import type { Job, Who } from './job.ts';
import { active } from './job.ts';
import { awakeSeconds, median } from './duration.ts';
import { ratingSummary } from './profiles.ts';
import { quotaBar, quotaPoints, quotaPool } from './quota.ts';
import type { QuotaSnapshots } from './quota.ts';
import { whos } from './roster.ts';

// 表现页的仪表盘数据。纯函数：不读文件、不联网，核心和命令行共用；界面只画，不自己算。
export const ranges = ['today', '7d', '30d'] as const;
export type Range = typeof ranges[number];
export const rangeLabel: Record<Range, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' };

// token：fresh = 读入 − 缓存命中（真正新读的），cached = 缓存命中，out = 写出。三家的原始字段已在 Job.usage 里统一成 read/cached/out。
export type Tokens = { fresh: number; cached: number; out: number };
// 一个额度池在这段时间里花掉的百分点。pool 例如“Codex · 周额度”“Cursor · 其他模型池”。
export type PoolSpend = { pool: string; points: number | null; jobs: number };

export type WorkerRow = {
  who: Who;
  jobs: number;                 // 这段时间结束的活（一家算一件，一批里每家各算一件）
  adoptRate: number | null;     // 拍了板的里面被采用的比例；没有拍板的为 null
  avgScore: number | null;      // 打了分（不含只有外部原因的）的平均分
  reworkRate: number | null;    // 打了分的里面带“需要返工”的比例
  medianSeconds: number | null; // 做完了（done）的扣休眠用时的中位数
  medianTokens: Tokens | null;  // 有用量记录的每件 token 的中位数（三项各自取中位数）
  avgPoints: number | null;     // 每件额度百分点的平均值（分摊后的，见约定；各家额度多是整数百分比，一件小活常常是 0，所以取平均不取中位数）
  withoutUsage: number;         // 没有 token 记录的件数
};
export type DayRow = { day: string; jobs: number; tokens: Tokens };   // day 是本地日期 YYYY-MM-DD；范围内每天都有一行，没有活的是 0
export type ProjectRow = { name: string; jobs: number; seconds: number; tokens: Tokens };
export type DashboardSlice = {
  range: Range; project: string;   // project 为 '' 表示全部项目
  from: string; to: string;        // 这段时间的起止（ISO）
  kpi: {
    jobs: number; done: number; failed: number;   // failed 含出错、失联、停下
    adoptRate: number | null; avgScore: number | null;
    seconds: number;                              // 扣休眠的总用时（秒）
    tokens: Tokens; withoutUsage: number;
    pools: PoolSpend[];                           // 按额度池列出这段时间花掉的百分点
  };
  workers: WorkerRow[];   // 按选手名单顺序，只列这段时间有活的
  daily: DayRow[];
  projects: ProjectRow[]; // 按件数从多到少
};

const emptyTokens = (): Tokens => ({ fresh: 0, cached: 0, out: 0 });
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const tokensOf = (job: Job): Tokens | null => job.usage
  ? { fresh: Math.max(0, job.usage.read - job.usage.cached), cached: job.usage.cached, out: job.usage.out } : null;
function addTokens(total: Tokens, tokens: Tokens | null) {
  if (tokens) { total.fresh += tokens.fresh; total.cached += tokens.cached; total.out += tokens.out; }
}
const endedAt = (job: Job) => Date.parse(job.ended || job.started || job.created);
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function adoptRate(jobs: Job[]) {
  const decided = jobs.filter(j => j.decision);
  return decided.length ? decided.filter(j => j.decision!.kind === 'adopt').length / decided.length : null;
}
const doneSeconds = (jobs: Job[]) => jobs.filter(j => j.state === 'done').flatMap(j => awakeSeconds(j) ?? []);

// 先按池归类，再按区间相交的传递关系分组；整个过程不改输入任务或快照。
function poolSpending(jobs: Job[]) {
  const pools = new Map<string, Job[]>(), allocated = new Map<Job, number>();
  for (const job of jobs) {
    const fallback = quotaPool(job.who), snapshots = job as Job & QuotaSnapshots;
    const bar = quotaBar(snapshots.quota_before, job.who) ?? quotaBar(snapshots.quota_after, job.who);
    const pool = `${fallback.name} · ${bar?.label ?? fallback.label}`;
    const group = pools.get(pool) ?? [];
    group.push(job); pools.set(pool, group);
  }
  const spending: PoolSpend[] = [];
  for (const [pool, members] of pools) {
    const start = (job: Job) => Date.parse(job.started || job.created);
    const ordered = [...members].sort((a, b) => start(a) - start(b) || endedAt(a) - endedAt(b) || a.id.localeCompare(b.id));
    let points: number | null = null;
    const settle = (group: Job[]) => {
      const first = group[0] as Job & QuotaSnapshots;
      const last = group.reduce((a, b) => endedAt(b) > endedAt(a) ? b : a) as Job & QuotaSnapshots;
      const total = quotaPoints(quotaBar(first.quota_before, first.who), quotaBar(last.quota_after, last.who));
      if (total === null) return;
      points = (points ?? 0) + total;
      // 池总额仍可由快照确定；缺用量时不给单件分摊值。
      const tokens = group.map(tokensOf);
      if (tokens.some(t => t === null)) return;
      if (group.length === 1) { allocated.set(first, total); return; }
      const weights = tokens.map(t => t!.fresh + t!.out), weight = weights.reduce((a, b) => a + b, 0);
      // 全组权重为零且有消耗时无法分摊；零消耗可确定每件都是零。
      if (weight === 0 && total !== 0) return;
      group.forEach((job, i) => allocated.set(job, weight === 0 ? 0 : total * weights[i] / weight));
    };
    let group: Job[] = [], edge = -Infinity;
    for (const job of ordered) {
      if (group.length && start(job) > edge) { settle(group); group = []; edge = -Infinity; }
      group.push(job); edge = Math.max(edge, endedAt(job));
    }
    if (group.length) settle(group);
    spending.push({ pool, points, jobs: members.length });
  }
  return { pools: spending.sort((a, b) => a.pool.localeCompare(b.pool, 'zh-CN')), allocated };
}

// jobs 是全部任务；先按结束时间、范围和项目筛选，再汇总（归档项目也保留）。
export function dashboard(jobs: Job[], range: Range, project: string, now = Date.now()): DashboardSlice {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === 'today' ? 0 : range === '7d' ? 6 : 29));
  const selected = jobs.filter(j => !active(j) && (!project || j.project === project) && endedAt(j) >= start.getTime() && endedAt(j) <= now);
  const daily: DayRow[] = [];
  for (const date = new Date(start); date.getTime() <= now; date.setDate(date.getDate() + 1)) {
    daily.push({ day: dayKey(date), jobs: 0, tokens: emptyTokens() });
  }
  const days = new Map(daily.map(row => [row.day, row]));
  const projects = new Map<string, ProjectRow>(), tokens = emptyTokens();
  for (const job of selected) {
    const usage = tokensOf(job), day = days.get(dayKey(new Date(endedAt(job))))!;
    day.jobs++; addTokens(day.tokens, usage); addTokens(tokens, usage);
    if (!project) {
      const row = projects.get(job.project) ?? { name: job.project, jobs: 0, seconds: 0, tokens: emptyTokens() };
      row.jobs++; row.seconds += job.state === 'done' ? awakeSeconds(job) ?? 0 : 0; addTokens(row.tokens, usage);
      projects.set(job.project, row);
    }
  }
  const { pools, allocated } = poolSpending(selected);
  const workers: WorkerRow[] = whos.flatMap(who => {
    const group = selected.filter(j => j.who === who);
    if (!group.length) return [];
    const usage = group.flatMap(j => tokensOf(j) ?? []), rating = ratingSummary(group);
    return [{ who, jobs: group.length, adoptRate: adoptRate(group), avgScore: rating.avgScore, reworkRate: rating.reworkRate,
      medianSeconds: median(doneSeconds(group)),
      medianTokens: usage.length ? { fresh: median(usage.map(t => t.fresh))!, cached: median(usage.map(t => t.cached))!, out: median(usage.map(t => t.out))! } : null,
      avgPoints: mean(group.flatMap(j => allocated.get(j) ?? [])), withoutUsage: group.length - usage.length }];
  });
  const seconds = doneSeconds(selected).reduce((a, b) => a + b, 0);
  return { range, project, from: start.toISOString(), to: new Date(now).toISOString(),
    kpi: { jobs: selected.length, done: selected.filter(j => j.state === 'done').length,
      failed: selected.filter(j => j.state === 'failed' || j.state === 'lost' || j.state === 'stopped').length,
      adoptRate: adoptRate(selected), avgScore: ratingSummary(selected).avgScore, seconds, tokens,
      withoutUsage: selected.filter(j => !j.usage).length, pools },
    workers, daily, projects: [...projects.values()].sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name, 'zh-CN')) };
}
