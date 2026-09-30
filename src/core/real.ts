import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { active, readJob } from './job.ts';
import type { Job } from './job.ts';
import { jobDir } from './paths.ts';
import { hasCode, withLock, writeAtomic, writeJson } from './fsx.ts';
import { singleLine } from './text.ts';

export function reportSteps(report: string): string[] | null {
  let section = false, found = false, fence = '';
  const steps: string[] = [];
  for (const line of report.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    if (/^\s{0,3}##\s+真实环境检查步骤\s*(?:#+\s*)?$/.test(line)) { section = found = true; continue; }
    if (/^\s{0,3}#{1,2}\s/.test(line)) section = false;
    if (!section || steps.length >= 20) continue;
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (item) {
      const text = item[1].replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim();
      if (text) steps.push([...text].slice(0, 200).join(''));
    }
  }
  return found ? steps : null;
}
// collect 可以重复运行，同一句步骤只收一次。
export function collectRealSteps(job: Job, report: string) {
  const steps = reportSteps(report);
  if (steps === null) return;
  job.realCheck ??= { needed: true, steps: [] };
  job.realCheck.needed = true;
  job.realCheck.steps = [...new Set([...job.realCheck.steps, ...steps])];
}
export function initialRealCheck(real: string | boolean | undefined): Job['realCheck'] {
  if (real === undefined || real === false) return undefined;
  return { needed: true, steps: real === true ? [] : [singleLine(real, '--real 说明：', 200)] };
}

export type RealInput = { ok: boolean; note: string; shots?: string[] } | { skip: string };
const maxSize = 10 * 1024 * 1024;
async function screenshot(file: string): Promise<{ ext: string; data: Buffer }> {
  if (typeof file !== 'string') throw new Error('请填写截图路径。');
  const ext = extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('截图只支持 .png/.jpg/.jpeg/.webp。');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new Error('截图必须是普通图片文件。');
    if (stat.size > maxSize) throw new Error('每张截图不能超过 10 MB。');
    // 有界读取，文件在读取期间增长也不会越过大小限制。
    const buffer = Buffer.alloc(maxSize + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxSize) throw new Error('每张截图不能超过 10 MB。');
    const data = buffer.subarray(0, size);
    const valid = ext === '.png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : ext === '.webp' ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
      : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (!valid) throw new Error('截图内容和图片格式不符，请提供 PNG、JPEG 或 WebP 图片。');
    return { ext, data };
  } finally { await fd.close(); }
}
export async function recordRealCheck(id: string, input: RealInput): Promise<Job> {
  const skip = 'skip' in input;
  const note = singleLine(skip ? input.skip : input.note, skip ? '跳过理由：' : '验收说明：', 200);
  if (!skip && typeof input.ok !== 'boolean') throw new Error('请选择验收通过或没过。');
  const files = skip ? [] : input.shots ?? [];
  if (!Array.isArray(files) || files.length > 10) throw new Error('截图最多 10 张。');
  const dir = jobDir(id);
  return withLock(dir, async () => {
    let job: Job;
    try { job = await readJob(id); }
    catch (error) { if (hasCode(error, 'ENOENT')) throw new Error(`找不到任务 ${id}。`); throw error; }
    if (active(job)) throw new Error('任务还没结束，请先 wait 或 stop，再记录真实验收。');
    const stage = await mkdtemp(join(dir, '.shots-'));
    const current = join(dir, 'shots'), archive = join(dir, 'shots-old', randomUUID());
    let moved = false, installed = false;
    try {
      const shots: string[] = [];
      for (const file of files) {
        const { ext, data } = await screenshot(file);
        const name = `${String(shots.length + 1).padStart(2, '0')}${ext}`;
        await writeAtomic(join(stage, name), data); shots.push(name);
      }
      await mkdir(join(dir, 'shots-old'), { recursive: true });
      try { await rename(current, archive); moved = true; }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      await rename(stage, current); installed = true;
      const at = new Date().toISOString();
      const check = job.realCheck ?? { needed: true, steps: [] };
      job.realCheck = skip ? { needed: check.needed, steps: check.steps, skipped: { reason: note, at } }
        : { needed: check.needed, steps: check.steps, result: { ok: input.ok, note, shots, at, by: 'lead' } };
      await writeJson(join(dir, 'job.json'), job);
      return job;
    } catch (error) {
      if (installed) await rm(current, { recursive: true, force: true });
      if (moved) await rename(archive, current);
      throw error;
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}
