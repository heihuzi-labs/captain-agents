import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { httpsUrl, MAX_FEED_SIZE, MAX_PACKAGE_SIZE, packageUrls, validVersion } from './update-feed.ts';
import type { UpdateFeed, UpdatePackage } from './update-feed.ts';

export type UpdateResponse = { status: number; location?: string; body: AsyncIterable<Uint8Array>; close(): void };
export type UpdateFetch = (url: URL, options: { headers: Record<string, string>; signal: AbortSignal }) => Promise<UpdateResponse>;
// Node HTTPS 不共享 Electron 窗口的 Cookie、缓存、代理会话或系统凭据；不自动跟跳转。
export const httpsFetch: UpdateFetch = (url, { headers, signal }) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'GET', headers, signal, agent: false }, response => {
    resolve({ status: response.statusCode ?? 0, location: response.headers.location, body: response, close: () => response.destroy() });
  });
  req.on('error', reject);
  req.end();
});
export function feedUrls(feed: string): string[] {
  // 逗号前后的空白不算数，和打包时处理 XA_UPDATE_HOSTS 一样；一个多打的空格不该关掉整个更新。
  const urls = feed.split(',').map(address => address.trim());
  if (urls.length < 1 || urls.length > 4) throw new Error('清单地址须有 1–4 个。');
  const normalized = urls.map(address => httpsUrl(address).href);
  if (new Set(normalized).size !== normalized.length) throw new Error('清单地址不能重复。');
  return normalized;
}
export function updateHosts(feed: string, extra: string[]): Set<string> {
  const allowed = new Set(feedUrls(feed).map(address => new URL(address).host));
  if (extra.length > 16) throw new Error('更新跳转主机名单太长。');
  for (const host of extra) {
    if (!host || httpsUrl(`https://${host}`).host !== host || /[/@?#]/.test(host)) throw new Error('更新跳转主机名单格式不对。');
    allowed.add(host);
  }
  return allowed;
}
class SlowDownloadError extends Error {}
export type DownloadClock = { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
const realClock: DownloadClock = { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
export function updateClient(options: { feed: string; hosts: string[]; version: string; fetch?: UpdateFetch; timeoutMs?: number; clock?: DownloadClock }) {
  const feeds = feedUrls(options.feed), hosts = updateHosts(options.feed, options.hosts), fetch = options.fetch ?? httpsFetch, clock = options.clock ?? realClock;
  if (!validVersion(options.version)) throw new Error('当前应用版本号不对。');
  const headers = { 'User-Agent': `Xagents/${options.version}`, Accept: '*/*', 'Accept-Encoding': 'identity' };
  async function consume(address: string, limit: number, chunk: (data: Uint8Array, received: number) => Promise<void>, download?: { fallback: boolean }) {
    const abort = new AbortController();
    let response: UpdateResponse | undefined, stallTimer: unknown, speedTimer: unknown;
    let received = 0, started: number | undefined;
    const stop = (message: string) => abort.abort(new Error(message));
    const timer = clock.setTimeout(() => stop('请求超时，请稍后重试。'), download ? 60 * 60_000 : options.timeoutMs ?? 30_000);
    const stalled = () => {
      if (!download) return;
      clock.clearTimeout(stallTimer);
      stallTimer = clock.setTimeout(() => stop('下载长时间没有收到新数据，请稍后重试。'), 60_000);
    };
    const tooSlow = () => {
      if (download?.fallback && started !== undefined && received < limit) {
        const elapsed = clock.now() - started;
        if (elapsed >= 20_000 && limit * elapsed / received > 10 * 60_000) abort.abort(new SlowDownloadError('下载速度太慢，请稍后重试。'));
      }
    };
    // AbortSignal 同时关闭真实响应并唤醒等待，响应头或下一块永远不来时也能清理并切换。
    const onAbort = () => response?.close();
    abort.signal.addEventListener('abort', onAbort, { once: true });
    async function waitFor<T>(pending: Promise<T>): Promise<T> {
      let rejectAbort!: (error: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const cancel = () => rejectAbort(abort.signal.reason);
      abort.signal.addEventListener('abort', cancel, { once: true });
      try {
        if (abort.signal.aborted) cancel();
        return await Promise.race([pending, aborted]);
      } finally { abort.signal.removeEventListener('abort', cancel); }
    }
    try {
      let url = httpsUrl(address);
      stalled(); // 等待连接和响应头也不能无限挂住；跳转不重置等待预算。
      for (let redirects = 0; ; redirects++) {
        if (!hosts.has(url.host)) throw new Error('更新地址不在允许的主机名单里。');
        const pending = fetch(url, { headers: { ...headers }, signal: abort.signal }).then(value => {
          if (abort.signal.aborted) { value.close(); throw abort.signal.reason; }
          return value;
        });
        response = await waitFor(pending);
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        response.close();
        if (redirects >= 5 || !response.location) throw new Error('更新地址跳转次数过多或缺少地址。');
        url = httpsUrl(new URL(response.location, url).href);
      }
      if (response.status !== 200) throw new Error(`更新服务器返回错误（${response.status}）。`);
      stalled();
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const next = await waitFor(iterator.next());
        abort.signal.throwIfAborted();
        if (next.done) break;
        const data = next.value;
        if (!data.byteLength) continue;
        received += data.byteLength;
        if (received > limit) throw new Error('下载内容超过声明大小，已中止。');
        stalled();
        if (started === undefined) {
          started = clock.now();
          if (download?.fallback) speedTimer = clock.setTimeout(tooSlow, 20_000);
        }
        tooSlow();
        abort.signal.throwIfAborted();
        await chunk(data, received);
      }
      abort.signal.throwIfAborted();
      return received;
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)) throw error;
      throw new Error('网络连接失败或下载中断，请稍后重试。');
    } finally {
      clock.clearTimeout(timer); clock.clearTimeout(stallTimer); clock.clearTimeout(speedTimer);
      abort.signal.removeEventListener('abort', onAbort); response?.close();
    }
  }
  return {
    async feed(verify: (bytes: Uint8Array) => UpdateFeed): Promise<UpdateFeed> {
      for (const [index, address] of feeds.entries()) {
        try {
          const chunks: Buffer[] = [];
          await consume(address, MAX_FEED_SIZE, async data => { chunks.push(Buffer.from(data)); });
          return verify(Buffer.concat(chunks));
        } catch (error) { if (index === feeds.length - 1) throw error; }
      }
      throw new Error('清单地址须有 1–4 个。');
    },
    async download(pkg: UpdatePackage, directory: string, progress: (received: number) => void): Promise<string> {
      if (!Number.isSafeInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_PACKAGE_SIZE || !/^[a-fA-F0-9]{64}$/.test(pkg.sha256)) throw new Error('安装包大小或 SHA-256 格式不对。');
      packageUrls(pkg.urls);
      await cleanPartialDownloads(directory);
      const partial = join(directory, 'package.zip.part'), complete = join(directory, 'package.zip');
      await rm(complete, { force: true });
      let firstSlow: string | undefined;
      const attempts = pkg.urls.map((address, index) => ({ address, fallback: index < pkg.urls.length - 1 }));
      for (const [index, { address, fallback }] of attempts.entries()) {
        const file = await open(partial, 'wx', 0o600), hash = createHash('sha256');
        try {
          if (index) progress(0);
          const received = await consume(address, pkg.size, async (data, count) => {
            hash.update(data);
            // writeFile 会处理短写，文件句柄的偏移随每块前进。
            await file.writeFile(data);
            progress(count);
          }, { fallback });
          if (received !== pkg.size) throw new Error('更新包大小不符，没有安装。');
          if (hash.digest('hex') !== pkg.sha256.toLowerCase()) throw new Error('更新包的内容和发布的不一致，没有安装。');
          await file.sync(); await file.close();
          await rename(partial, complete);
          return complete;
        } catch (error) {
          await file.close().catch(() => {}); await rm(partial, { force: true });
          if (error instanceof SlowDownloadError && firstSlow === undefined) firstSlow = address;
          // 原始地址全部失败后只追加一次；回头这一轮保留停滞与总时限，不判断速度。
          if (index === pkg.urls.length - 1 && firstSlow !== undefined) attempts.push({ address: firstSlow, fallback: false });
          if (index === attempts.length - 1) throw error;
        }
      }
      throw new Error('安装包地址须有 1–4 个。');
    },
  };
}
export async function cleanPartialDownloads(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) if (name.endsWith('.part')) await rm(join(directory, name), { recursive: true, force: true });
}
