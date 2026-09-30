import type { Activity, Batch, Job, Rating, Timing, Who } from './job.ts';
import type { Stat } from './stats.ts';
import type { Profile, TagKind } from './profiles.ts';
import type { Provider } from './quota.ts';
import type { Effort } from './roster.ts';
import type { WorkersPolicy } from './policy.ts';
import type { Limits, Storage } from './settings.ts';
import type { DashboardSlice } from './dashboard.ts';

export type Column = 'running' | 'attention' | 'done';
// 负责人打的分（只带当前这一版，不带改分前的历史）；标签的好坏由核心分好（src/core/profiles.ts），界面不自己分。
export type ViewRating = {
  score?: Rating['score']; good?: string; improve?: string; external?: string; at: string;
  tags: { tag: string; kind: TagKind }[];
};
export type ViewJob = Pick<Job, 'id' | 'batch' | 'project' | 'who' | 'model' | 'effort' | 'fast' | 'kind' | 'title' | 'summary' | 'state' | 'base'> & {
  // seconds：已结束的活扣掉电脑休眠后的用时；typical：同一选手、同一类活、做完了的至少 3 件时的通常用时（秒），否则 null。
  started: string; ended: string | null; seconds: number | null; typical: number | null;
  check: { ok: boolean; label: string; note: string } | null;
  decision: NonNullable<Job['decision']> | null;
  redo: NonNullable<Job['redo']> | null; sleeps: NonNullable<Job['sleeps']>;
  comments: NonNullable<Job['comments']>;
  realCheck: { needed: boolean; steps: string[]; result: { ok: boolean; note: string; at: string; shotCount: number } | null; skipped: { reason: string; at: string } | null } | null;
  rating: ViewRating | null;
  activity: Activity[];
  // 每一步的时间；老任务没有记录时为 null。给人看的话用 src/core/duration.ts 的 describeTiming。
  timing: Timing | null;
};
export type View = {
  updated: string;
  settings: { keepAwake: boolean; notifications: boolean; storage: Storage; limits: Limits; workers: WorkersPolicy };
  // 自动清理旧日志的账：清过几件、一共腾出多少字节、现在按设置的天数有几件到期待清（清理关着也照算）。
  storage: { slimmedJobs: number; freedBytes: number; due: number };
  // 表现页的仪表盘：每个时间范围 × （全部项目 + 每个项目）各一份，界面按筛选取用，不自己算。
  dashboard: DashboardSlice[];
  roster: { who: Who; name: string; model: string; efforts: Effort[]; fastSupported: boolean }[];
  selfcheck: { ok: boolean | null; at: string | null; note: string };
  // at：这家额度的数据时间；failed：这次没查到（bars 里是上一次的数据，at 也是上一次的时间）。
  quota: { name: string; icon: Provider; plan: string | null; at: string | null; failed?: true; bars: {
    label: string; used: number | null; approx?: boolean; reset: string | null;
  }[] }[];
  quotaAt: string | null;
  stats: Stat[];
  profiles: Profile[];
  workers: Record<Who, { name: string; model: string; icon: string; badge?: string }>;
  // 项目名单：登记处里的项目，加上任务里出现过但没登记的；label 是给人看的名字（现在就是项目名）。
  // archived：主人归档了这个项目（设置里的 archivedProjects）；已完成列和历史页的“全部”不再显示它，在跑、在验收的照常显示。
  projects: { name: string; label: string; archived: boolean }[];
  jobs: ViewJob[];
  batches: Batch[];
  theme?: { columns: Partial<Record<Column, string>> };
};
