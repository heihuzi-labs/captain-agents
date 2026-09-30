// 用时的算法只写在这里：不依赖 Node，界面和核心共用。电脑休眠的时段不算选手的用时。
export type Sleep = { from: string; to: string };
type Timed = { seconds?: number | null; started?: string; created?: string; ended?: string; sleeps?: Sleep[] };

// 休眠时段落在 [from, to] 里的总秒数；重叠的时段只算一次。
export function sleptSeconds(sleeps: Sleep[] | undefined, from: number, to: number): number {
  if (!sleeps?.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const spans = sleeps.map(s => [Math.max(from, Date.parse(s.from)), Math.min(to, Date.parse(s.to))] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, edge = -Infinity;
  for (const [a, b] of spans) { total += Math.max(0, b - Math.max(a, edge)); edge = Math.max(edge, b); }
  return total / 1000;
}
// 已结束的活实际干了多久：登记的用时（没有就用开始、结束时间）扣掉休眠。算不出来给 null。
export function awakeSeconds(job: Timed): number | null {
  const start = Date.parse(job.started || job.created || '');
  const wall = typeof job.seconds === 'number' && Number.isFinite(job.seconds) ? job.seconds
    : job.ended && Number.isFinite(start) ? (Date.parse(job.ended) - start) / 1000 : NaN;
  if (!Number.isFinite(wall) || wall < 0) return null;
  const end = job.ended ? Date.parse(job.ended) : start + wall * 1000;
  return Math.max(0, wall - sleptSeconds(job.sleeps, start, end));
}
export function median(values: number[]): number | null {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : null;
}

// 每一步的时间拆成“想和写”与“跑命令”：想和写 = 扣掉休眠的总用时 − 跑命令的时间。在跑的活用 now 算到现在。
export type TimeSplit = { steps: number; toolSeconds: number; thinkSeconds: number };
export function timeSplit(job: Timed & { timing?: { steps: number; toolSeconds: number } | null }, now = Date.now()): TimeSplit | null {
  const timing = job.timing;
  if (!timing) return null;
  let total = awakeSeconds(job);
  if (total === null && !job.ended) {
    const start = Date.parse(job.started || job.created || '');
    if (Number.isFinite(start) && now >= start) total = Math.max(0, (now - start) / 1000 - sleptSeconds(job.sleeps, start, now));
  }
  if (total === null) return null;
  const toolSeconds = Math.min(Math.max(0, timing.toolSeconds), total);
  return { steps: Math.max(0, timing.steps), toolSeconds, thinkSeconds: total - toolSeconds };
}
const rough = (seconds: number) => seconds < 60 ? '不到 1 分钟'
  : seconds < 3600 ? `约 ${Math.round(seconds / 60)} 分钟`
  : `约 ${Math.floor(seconds / 3600)} 小时${Math.round(seconds % 3600 / 60) ? ` ${Math.round(seconds % 3600 / 60)} 分钟` : ''}`;
// 给人看的一句话，命令行和应用共用，例如“大部分时间在想，跑命令不到 1 分钟，共 45 步”。
export function describeTiming(split: TimeSplit | null): string | null {
  if (!split) return null;
  const { steps, toolSeconds: tool, thinkSeconds: think } = split;
  const head = think >= tool * 2 ? `大部分时间在想，跑命令${rough(tool)}`
    : tool >= think * 2 ? `大部分时间在跑命令（${rough(tool)}），想和写${rough(think)}`
    : `想和写${rough(think)}，跑命令${rough(tool)}`;
  return `${head}，共 ${steps} 步`;
}
