import type { Activity, Batch } from '../../../src/core/job.ts';
import type { View, ViewJob } from '../../../src/core/view-types.ts';
import type { Profile } from '../../../src/core/profiles.ts';
import { describeTiming, sleptSeconds, timeSplit } from '../../../src/core/duration.ts';
import { isOpen, ownerAttention, single } from '../../shared/attention.ts';
import type { Entry, Target } from '../../shared/attention.ts';
export { entries, isOpen, single } from '../../shared/attention.ts';
export type { Entry, Target } from '../../shared/attention.ts';
export const STATE = {
  running: '在跑',
  queued: '排队',
  done: '完成',
  failed: '出错',
  lost: '失联',
  stopped: '已停'
} as const;
// 最后一条留言来自主人、负责人还没处理（没有 handled 记号），就是在等负责人回复。
export const awaitingReply = (j: ViewJob) => {
  const last = j.comments.at(-1);
  return last?.by === 'owner' && !last.handled;
};
// 推理强度写给人看：medium→中档，high→高档，xhigh→超高档，其他值照原样。
export const effortText = (effort: string) => effort === 'medium' ? '中档' : effort === 'high' ? '高档' : effort === 'xhigh' ? '超高档' : effort;
const pad = (n: number) => String(n).padStart(2, '0');
export function fmtDur(sec: number, short = false) {
  sec = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(sec / 3600),
    m = Math.floor(sec % 3600 / 60),
    s = sec % 60;
  return h ? `${h} 小时 ${m} 分` : m ? short ? `${m} 分钟` : `${m} 分 ${pad(s)} 秒` : `${s} 秒`;
}
export function fmtAgo(sec: number) {
  return sec < 60 ? '刚刚' : sec < 3600 ? `${Math.floor(sec / 60)} 分钟前` : sec < 86400 ? `${Math.floor(sec / 3600)} 小时前` : `${Math.floor(sec / 86400)} 天前`;
}
export function fmtNum(n: number | null | undefined) {
  return n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(1).replace(/\.0$/, '') + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' 万' : String(n);
}
export function fmtTime(iso: string | null, date = false) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  const d = new Date(iso),
    t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return date ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}
export const secondsSince = (iso: string, now = Date.now()) => Math.max(0, (now - Date.parse(iso)) / 1000);
export function human(a?: Activity) {
  if (!a) return '刚开始';
  const t = a.text || '';
  if (a.kind === 'say') return t.replace(/\s+/g, ' ');
  if (a.kind === 'edit') return '在改代码';
  if (/(^|\s)(node --test|npm test|pnpm .*test|vitest|jest|pytest)/.test(t) || /test/.test(t) && a.kind === 'cmd') return '在跑测试';
  if (/git (diff|log|show|status)/.test(t)) return '在看代码变化';
  if (/install/.test(t)) return '在装依赖';
  if (a.kind === 'read' || /^(读|rg|grep|find|ls|cat|sed|head)|--help|在程序文件里找/.test(t)) return '在查资料、读代码';
  return '在执行命令';
}
// 弹窗“真实验收”一节的状态：有结果按结果（通过 / 没过），写明不需要按不需要；两者都有以后写的为准；都没有时，需要就是待做。
export type RealState = { label: '待做' | '通过' | '没过' | '不需要'; tone: 'neutral' | 'ok' | 'bad' };
export function realState(check: NonNullable<ViewJob['realCheck']>): RealState {
  const { result, skipped } = check;
  if (result && (!skipped || Date.parse(result.at) >= Date.parse(skipped.at))) return result.ok ? { label: '通过', tone: 'ok' } : { label: '没过', tone: 'bad' };
  if (skipped || !check.needed) return { label: '不需要', tone: 'neutral' };
  return { label: '待做', tone: 'neutral' };
}
export const decisionText = (j: ViewJob) => {
  if (j.decision?.by === 'owner') return j.decision.handled ? '负责人已处理' : '等负责人处理';
  return j.decision ? (j.decision.kind === 'adopt' ? '用了这份' : '没用') + (j.decision.note ? `：${j.decision.note}` : '') : j.state === 'running' || j.state === 'queued' ? '—' : '还没定';
};
export const BATCH_HUES = [1, 2, 3, 4, 5, 6].map(n => `var(--batch-${n})`);
// 只有真正有两家以上的批次才有颜色；ids 给出时，只数登记处里还在的任务。
export function batchColors(batches: Batch[], ids?: Set<string>) {
  return new Map(batches.filter(b => (ids ? b.jobs.filter(id => ids.has(id)) : b.jobs).length > 1).slice().sort((a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id)).map((b, i) => [b.id, BATCH_HUES[i % BATCH_HUES.length]]));
}
// 在跑的活已经干了多久：从开始算起，扣掉电脑休眠的时间。
export const awakeSince = (job: Pick<ViewJob, 'started' | 'sleeps'>, now = Date.now()) =>
  Math.max(0, (now - Date.parse(job.started)) / 1000 - sleptSeconds(job.sleeps, Date.parse(job.started), now));
// 每一步的时间那句话，拼法只在核心的 describeTiming；这里只把界面拿到的数据接上去。
// 界面里已结束的活，seconds 已经扣过休眠（view.ts），所以不能再让 timeSplit 扣一遍；在跑的活没有 seconds，休眠由 timeSplit 扣。
export function timingLine(job: ViewJob, now = Date.now()) {
  if (!job.timing) return null;
  return describeTiming(timeSplit({ started: job.started, ended: job.ended ?? undefined, seconds: job.seconds, sleeps: job.seconds == null ? job.sleeps : [], timing: job.timing }, now));
}
// 表现页每格的“平均：……”：档案里有平均步数和平均跑命令时间、也有平均用时才写。想和写的时间 = 平均用时 − 平均跑命令，不小于 0。
export function averageTimingLine(p: Pick<Profile, 'avgSeconds' | 'avgToolSeconds' | 'avgSteps'>) {
  if (p.avgSteps === null || p.avgToolSeconds === null || p.avgSeconds === null) return null;
  return describeTiming({ steps: Math.round(p.avgSteps), toolSeconds: p.avgToolSeconds, thinkSeconds: Math.max(0, p.avgSeconds - p.avgToolSeconds) });
}
// “通常多久”由核心统计算好（同一选手、同一类活、做完了的至少 3 件），随每张卡传来；这里只读，不再自己算。
export const typicalTimes = (_jobs?: ViewJob[]) => (job: ViewJob) => job.typical;
// 额度的数据时间超过这个秒数，用提醒色。
export const QUOTA_STALE_SECONDS = 30 * 60;
export function derive(view: View, now = Date.now()) {
  const queued = view.jobs.filter(j => j.state === 'queued'),
    running = view.jobs.filter(j => j.state === 'running');
  const { attention, done, groups } = ownerAttention(view);
  const runningGroups: Entry[] = [],
    placed = new Set<string>();
  const byJob = new Map(groups.flatMap(e => e.members.map(j => [j.id, e] as const)));
  for (const j of running) {
    const e = byJob.get(j.id)!;
    if (placed.has(e.target.kind + e.target.id)) continue;
    placed.add(e.target.kind + e.target.id);
    const members = e.members.filter(m => m.state === 'running');
    runningGroups.push(members.length > 1 ? {
      ...e,
      members
    } : single(j));
  }
  return {
    queued,
    running,
    runningGroups,
    attention,
    done: done.filter(e => e.at >= now - 86400e3).sort((a, b) => b.at - a.at),
    history: groups.filter(e => !e.members.some(isOpen)).sort((a, b) => Date.parse(b.started) - Date.parse(a.started))
  };
}
// 一列的自定义颜色：核心的看板数据按列名放（进行中、验收中、已完成）。
export const columnColor = (view: View, name: string): string | undefined => {
  const colors: Partial<Record<string, string>> | undefined = view.theme?.columns;
  return colors?.[name];
};
export const sameTarget = (a: Target, b: Target) => a.kind === b.kind && a.id === b.id;
export function navigation(target: Target, view: View, order: Target[]) {
  const valid = new Set(view.jobs.map(j => j.id));
  const batch = target.kind === 'job' ? view.batches.find(b => b.jobs.includes(target.id) && b.jobs.filter(id => valid.has(id)).length > 1) : undefined;
  const list: Target[] = batch ? batch.jobs.filter(id => valid.has(id)).map(id => ({
    kind: 'job',
    id
  })) : order;
  return {
    list,
    index: list.findIndex(t => sameTarget(t, target)),
    batch
  };
}
// 点开一批，如果其实只有一家，就直接打开那一家自己的详情。
export function normalizeTarget(view: View, target: Target): Target {
  if (target.kind !== 'batch') return target;
  const batch = view.batches.find(b => b.id === target.id);
  if (!batch) return target;
  const present = batch.jobs.filter(id => view.jobs.some(j => j.id === id));
  return present.length === 1 ? { kind: 'job', id: present[0] } : target;
}
export function shareView(previous: View | null, next: View): View {
  if (!previous) return next;
  const old = new Map(previous.jobs.map(j => [j.id, j]));
  const jobs = next.jobs.map(j => JSON.stringify(old.get(j.id)) === JSON.stringify(j) ? old.get(j.id)! : j);
  return {
    ...next,
    jobs,
    workers: JSON.stringify(previous.workers) === JSON.stringify(next.workers) ? previous.workers : next.workers
  };
}
export type Page = 'board' | 'history' | 'stats';
export function loadPosition(): {
  page: Page;
  filter: string;
} {
  try {
    const p: unknown = JSON.parse(localStorage.getItem('xa.position') || 'null');
    if (p && typeof p === 'object') {
      const v = p as Record<string, unknown>;
      return {
        page: v.page === 'history' || v.page === 'stats' ? v.page : 'board',
        filter: typeof v.filter === 'string' ? v.filter : '全部'
      };
    }
  } catch {}
  return {
    page: 'board',
    filter: '全部'
  };
}
export function savePosition(page: Page, filter: string) {
  try {
    localStorage.setItem('xa.position', JSON.stringify({
      page,
      filter
    }));
  } catch {}
}
