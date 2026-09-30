import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { paths } from '../../src/core/paths.ts';
import { buildView } from '../../src/core/view.ts';
import type { View } from '../../src/core/view-types.ts';

type WatchDirectory = (directory: string, options: { recursive: true }, changed: () => void) => FSWatcher;
export async function watchRegistry(hasWindow: () => boolean, publish: (view: View) => void,
  onError: (error: unknown) => void, read = buildView, watchDirectory: WatchDirectory = watch, watchSettings = false) {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false, reading = false, pending = false, open = true;
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || !hasWindow()) return;
    if (reading) { pending = true; return; }
    reading = true;
    try {
      const view = await read();
      open = view.jobs.some(j => j.state === 'running' || j.state === 'queued');
      if (!closed && hasWindow()) publish(view);
    }
    catch (error) { onError(error); }
    finally { reading = false; if (pending) { pending = false; changed(); } }
  };
  const changed = () => {
    if (timer) clearTimeout(timer);
    if (!closed && hasWindow()) timer = setTimeout(() => { void flush(); }, 300);
  };
  const close = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); if (poll) clearInterval(poll); watchers.forEach(w => w.close()); };
  try {
    const p = paths();
    for (const dir of (watchSettings ? [p.home] : [p.jobs, p.batches, p.cache])) {
      await mkdir(dir, { recursive: true });
      const watcher = watchDirectory(dir, { recursive: true }, changed);
      watcher.on('error', onError); watchers.push(watcher);
    }
  } catch (error) { close(); throw error; }
  // 看管进程退出不一定改文件：有活在跑或排队时，每 5 秒只读检查一次，没有就不读。
  poll = setInterval(() => { if (open) void flush(); }, 5000);
  return close;
}
