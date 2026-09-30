import { active } from './job.ts';
import type { Job, Who } from './job.ts';
import { stats } from './stats.ts';

export type Profile = {
  who: Who; fast: boolean; kind: string;
  count: number; rated: number;
  avgScore: number | null; reworkRate: number | null; avgSeconds: number | null;
  // 只算做完了（done）且有每步时间记录的：平均跑命令秒数、平均步数；没有样本为 null。
  avgToolSeconds: number | null; avgSteps: number | null;
  good: { tag: string; n: number }[];
  bad: { tag: string; n: number }[];
  recent: { id: string; title: string; at: string; score?: number; good?: string; improve?: string }[];
  small: boolean;
};

// 标签分类只在这里维护；未列出的标签属于“其他”，不混进优点或毛病。
const goodTags = new Set(['一次做对', '速度快', '主动发现问题', '报告老实', '代码规整', '考虑周到']);
const badTags = new Set(['需要返工', '夸大结论', '留多余文件', '测试没打到真实环境', '越界改动', '偏慢', '前提错误', '编造结果']);
export type TagKind = 'good' | 'bad' | 'other';
// 界面显示单件活的标签时也读这里，好坏不在别处另分一份。
export const tagKind = (tag: string): TagKind => goodTags.has(tag) ? 'good' : badTags.has(tag) ? 'bad' : 'other';
const key = (job: { who: Who; fast?: boolean; kind: string }) => JSON.stringify([job.who, Boolean(job.fast), job.kind]);

// 档案与仪表盘共用评分口径；调用方负责筛选已结束任务。
export function ratingSummary(jobs: Job[]) {
  const rated = jobs.filter(j => j.rating?.score !== undefined);
  const scored = rated.filter(j => !j.rating!.external);
  return {
    rated: rated.length,
    avgScore: scored.length ? scored.reduce((sum, j) => sum + j.rating!.score!, 0) / scored.length : null,
    reworkRate: rated.length ? rated.filter(j => j.rating!.tags.includes('需要返工')).length / rated.length : null,
  };
}

export function profiles(jobs: Job[]): Profile[] {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) if (!active(job)) {
    const group = groups.get(key(job)) ?? [];
    group.push(job); groups.set(key(job), group);
  }
  // 分组顺序、件数和平均用时沿用 stats；只算 done、扣休眠的算法不另写一份。
  return stats(jobs).map(stat => {
    const group = groups.get(key(stat))!;
    const rating = ratingSummary(group);
    const timed = group.filter(j => j.state === 'done' && j.timing).map(j => j.timing!);
    const counts = new Map<string, number>();
    for (const job of group) for (const tag of new Set(job.rating?.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const top = (category: Set<string>) => [...counts].filter(([tag]) => category.has(tag))
      .map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag, 'zh-CN')).slice(0, 3);
    const recent = group.filter(j => j.rating?.good?.trim() || j.rating?.improve?.trim())
      .sort((a, b) => b.rating!.at.localeCompare(a.rating!.at) || a.id.localeCompare(b.id)).slice(0, 5)
      .map(j => {
        const { at, score, good, improve } = j.rating!;
        return { id: j.id, title: j.title, at, ...(score === undefined ? {} : { score }), ...(good ? { good } : {}), ...(improve ? { improve } : {}) };
      });
    return { who: stat.who, fast: stat.fast, kind: stat.kind, count: stat.count, ...rating,
      avgSeconds: stat.averageSeconds,
      avgToolSeconds: timed.length ? timed.reduce((sum, t) => sum + t.toolSeconds, 0) / timed.length : null,
      avgSteps: timed.length ? timed.reduce((sum, t) => sum + t.steps, 0) / timed.length : null,
      good: top(goodTags), bad: top(badTags), recent, small: rating.rated < 3 };
  });
}
