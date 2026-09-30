import type { Job } from './job.ts';
import { active, listJobs, readJob } from './job.ts';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode, withLock, writeJson } from './fsx.ts';
import { jobDir } from './paths.ts';
import { readSettings } from './settings.ts';
import { moveToTrash } from './trash.ts';

// 自动清理旧日志。
// 到期的活：已结束、已拍板、已打分、副本已清理、还没清过，而且结束已满 days 天（按 ended，没有 ended 不算）。
export function slimCandidates(jobs: Job[], days: number, now = Date.now()): Job[] {
  return jobs.filter(job => !active(job) && job.decision && job.rating && job.cleaned && !job.slimmed && job.ended
    && now - Date.parse(job.ended) >= days * 86400e3);
}
// 要移走的文件（相对任务目录）：选手原始输出、派活时拷进去的运行文件、几份过程日志。其余（job.json、report.md、diff.patch、prompt.md、verify.log 等）都留着。
export const SLIM_FILES = ['run.log', 'runtime', 'stderr.log', 'supervisor.log', 'setup.log'] as const;

// 不跟随符号链接，不把目录自身的元数据大小算进日志字节数。
async function fileBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await fileBytes(join(path, name));
  return bytes;
}

// 把到期的活的 SLIM_FILES 移到废纸篓，并在锁里记下 job.slimmed。
// force 为 false 时按设置里的开关，关着就什么也不做；dryRun 只算不动。
export async function slimOld(options: { now?: number; dryRun?: boolean; force?: boolean } = {}): Promise<{ jobs: string[]; bytes: number }> {
  const result: { jobs: string[]; bytes: number } = { jobs: [], bytes: 0 };
  const { storage } = await readSettings();
  if (!options.force && !storage.slim) return result;
  const now = options.now ?? Date.now();
  const jobs = await listJobs().catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; });
  for (const candidate of slimCandidates(jobs, storage.days, now)) {
    try {
      await withLock(jobDir(candidate.id), async () => {
        const job = await readJob(candidate.id);
        if (!slimCandidates([job], storage.days, now).length) return;
        const dir = jobDir(job.id), files: string[] = [];
        let bytes = 0;
        for (const name of SLIM_FILES) {
          const path = join(dir, name);
          try { await lstat(path); }
          catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
          bytes += await fileBytes(path);
          files.push(name);
        }
        if (!options.dryRun) {
          // 要清的文件都已经不在了：不在废纸篓里建空文件夹，只记下清过了。
          if (files.length) await moveToTrash(files.map(name => join(dir, name)), job.id);
          job.slimmed = { at: new Date(now).toISOString(), bytes, files };
          await writeJson(join(dir, 'job.json'), job);
        }
        result.jobs.push(job.id);
        result.bytes += bytes;
      });
    } catch (error) {
      console.error(`任务 ${candidate.id} 的旧日志清理失败：${error instanceof Error ? error.message : String(error)}。其余任务继续处理。`);
    }
  }
  return result;
}
