import { changeJob } from './job.ts';
import type { Job, Rating } from './job.ts';

export type RateOptions = { score?: number; good?: string; improve?: string; tags?: string[]; external?: string };
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function text(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || [...value].length > 200 || controls.test(value)) {
    throw new Error(`${label}最多 200 字，不能含控制字符。`);
  }
  return value.trim() || undefined;
}

// 每次提交是一份完整评价；改分在任务锁里保存上一版，历史不嵌套。
export async function rate(id: string, options: RateOptions): Promise<Job> {
  const { score } = options;
  if (score !== undefined && (!Number.isInteger(score) || score < 1 || score > 5)) {
    throw new Error('分数只能是 1–5 的整数。');
  }
  const good = text(options.good, '做得好的'), improve = text(options.improve, '要改进的'), external = text(options.external, '外部原因');
  if (score === undefined && !external) throw new Error('请至少填写 --score 1-5 或 --external "外部原因"。');
  const supplied = options.tags ?? [];
  if (!Array.isArray(supplied) || supplied.length > 8) throw new Error('标签最多 8 个。');
  const tags = [...new Set(supplied.map(tag => {
    if (typeof tag !== 'string' || !tag.trim() || [...tag].length > 12 || controls.test(tag)) {
      throw new Error('每个标签须为 1–12 字，不能含控制字符。');
    }
    return tag.trim();
  }))];
  return changeJob(id, job => {
    if (!['done', 'failed', 'stopped', 'lost'].includes(job.state)) throw new Error('任务还没结束，请先 wait 或 stop，再打分。');
    const rating: Rating = { tags, at: new Date().toISOString(), by: 'lead',
      ...(score === undefined ? {} : { score: score as Rating['score'] }),
      ...(good ? { good } : {}), ...(improve ? { improve } : {}), ...(external ? { external } : {}) };
    if (job.rating) {
      const { previous = [], ...old } = job.rating;
      rating.previous = [...previous, old].slice(-5).map(({ score, good, improve, tags, external, at, by }) =>
        ({ score, good, improve, tags, external, at, by }));
    }
    job.rating = rating;
  });
}
