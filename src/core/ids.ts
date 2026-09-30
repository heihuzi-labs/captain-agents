import { mkdir, open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { paths } from './paths.ts';
import { hasCode } from './fsx.ts';

export function stem(file: string) {
  return basename(file, extname(file)).replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}
export function stamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return `${p.month}${p.day}-${p.hour}${p.minute}`;
}
export async function reserveJob(who: string, file: string, now = new Date()) {
  const prefix = `${stamp(now)}-${who}-${stem(file)}`;
  for (let n = 1; ; n++) {
    const id = prefix + (n === 1 ? '' : `-${n}`);
    try { await mkdir(join(paths().jobs, id)); return id; }
    catch (e) { if (!hasCode(e, 'EEXIST')) throw e; }
  }
}
export async function reserveBatch(file: string, now = new Date()) {
  const prefix = `${stamp(now)}-${stem(file)}`;
  for (let n = 1; ; n++) {
    const id = prefix + (n === 1 ? '' : `-${n}`);
    try {
      const fd = await open(join(paths().batches, `${id}.json`), 'wx', 0o600);
      await fd.close(); return id;
    } catch (e) { if (!hasCode(e, 'EEXIST')) throw e; }
  }
}
