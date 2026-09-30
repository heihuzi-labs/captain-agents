import { open, rename, rm, readFile, mkdir, stat } from 'node:fs/promises';
import { writeFileSync, mkdirSync, rmSync, readFileSync, statSync, openSync, closeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export function hasCode(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException)?.code === code;
}
export async function readJson<T = unknown>(file: string): Promise<T> {
  const text = await readFile(file, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new SyntaxError(`登记文件不是完整 JSON：${file}。请从备份恢复或修正文件后重试。`); }
}
export async function readOptional(file: string): Promise<string> {
  try { return await readFile(file, 'utf8'); }
  catch (e) { if (hasCode(e, 'ENOENT')) return ''; throw e; }
}
export async function writeAtomic(file: string, contents: string | Uint8Array) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = await open(tmp, 'wx', 0o600);
    try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
export const writeJson = (file: string, data: unknown) => writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
export function alive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid! <= 0) return false;
  try { process.kill(pid!, 0); return true; }
  catch (e) { return !hasCode(e, 'ESRCH'); }
}

// 回收者在旧目录内抢一个标记，防止两个等待者误删刚换手的新锁。
function reap(lock: string) {
  let claim: number | undefined;
  const marker = join(lock, 'reaping.json');
  try {
    const before = statSync(lock);
    claim = openSync(marker, 'wx', 0o600);
    writeFileSync(claim, JSON.stringify({ pid: process.pid }));
    const now = statSync(lock);
    if (before.ino !== now.ino || before.dev !== now.dev) return;
    let owner;
    try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); }
    catch { if (Date.now() - before.mtimeMs < 1000) return; }
    if (owner && alive(owner.pid)) return;
    rmSync(lock, { recursive: true, force: true });
  } catch (e) {
    if (hasCode(e, 'EEXIST')) {
      try {
        const m = JSON.parse(readFileSync(marker, 'utf8'));
        if (!alive(m.pid)) rmSync(marker, { force: true });
      } catch {
        // 回收进程也可能在写标记时被杀，不能让半份标记永久挡住锁。
        try { if (Date.now() - statSync(marker).mtimeMs > 1000) rmSync(marker, { force: true }); }
        catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      }
    } else if (!hasCode(e, 'ENOENT')) throw e;
  } finally {
    if (claim !== undefined) {
      closeSync(claim);
      try {
        const m = JSON.parse(readFileSync(marker, 'utf8'));
        if (m.pid === process.pid) rmSync(marker, { force: true });
      } catch { /* 已回收。 */ }
    }
  }
}

export async function withLock<T>(dir: string, fn: () => Promise<T> | T, waitMs = 10_000): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const ownerFile = join(lock, 'owner.json');
  const owner = { pid: process.pid, at: new Date().toISOString(), token: randomUUID() };
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      mkdirSync(lock);
      try { writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch (e) { rmSync(lock, { recursive: true, force: true }); throw e; }
      break;
    } catch (e) {
      if (!hasCode(e, 'EEXIST')) throw e;
      try {
        const current = await readJson<{ pid?: number; token?: string }>(ownerFile);
        if (!alive(current.pid)) reap(lock);
      } catch (error) {
        if (!hasCode(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
        try { if (Date.now() - (await stat(lock)).mtimeMs > 1000) reap(lock); }
        catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      }
      if (Date.now() >= deadline) throw new Error(`等待文件锁超过 ${Math.round(waitMs / 1000)} 秒：${dir}。请确认其他命令是否仍在工作，再重试。`);
      await sleep(50);
    }
  }
  try { return await fn(); }
  finally {
    // 只释放自己获得的锁。
    const current = await readJson<{ pid?: number; token?: string }>(ownerFile).catch(() => null);
    if (current?.token === owner.token) await rm(lock, { recursive: true, force: true });
  }
}
