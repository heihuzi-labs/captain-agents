import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { httpsUrl, MAX_FEED_SIZE, MAX_PACKAGE_SIZE, validVersion } from './update-feed.ts';
import type { UpdatePackage } from './update-feed.ts';

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
export function updateHosts(feed: string, extra: string[]): Set<string> {
  const allowed = new Set([httpsUrl(feed).host]);
  if (extra.length > 16) throw new Error('更新跳转主机名单太长。');
  for (const host of extra) {
    if (!host || httpsUrl(`https://${host}`).host !== host || /[/@?#]/.test(host)) throw new Error('更新跳转主机名单格式不对。');
    allowed.add(host);
  }
  return allowed;
}
export function updateClient(options: { feed: string; hosts: string[]; version: string; fetch?: UpdateFetch; timeoutMs?: number }) {
  const hosts = updateHosts(options.feed, options.hosts), fetch = options.fetch ?? httpsFetch;
  if (!validVersion(options.version)) throw new Error('当前应用版本号不对。');
  const headers = { 'User-Agent': `Xagents/${options.version}`, Accept: '*/*', 'Accept-Encoding': 'identity' };
  async function consume(address: string, limit: number, chunk: (data: Uint8Array, received: number) => Promise<void>) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('请求超时，请稍后重试。')), options.timeoutMs ?? 10 * 60_000);
    let response: UpdateResponse | undefined;
    try {
      let url = httpsUrl(address);
      for (let redirects = 0; ; redirects++) {
        if (!hosts.has(url.host)) throw new Error('更新地址不在允许的主机名单里。');
        response = await fetch(url, { headers: { ...headers }, signal: abort.signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        response.close();
        if (redirects >= 5 || !response.location) throw new Error('更新地址跳转次数过多或缺少地址。');
        url = httpsUrl(new URL(response.location, url).href);
      }
      if (response.status !== 200) throw new Error(`更新服务器返回错误（${response.status}）。`);
      let received = 0;
      for await (const data of response.body) {
        abort.signal.throwIfAborted();
        received += data.byteLength;
        if (received > limit) throw new Error('下载内容超过声明大小，已中止。');
        await chunk(data, received);
      }
      abort.signal.throwIfAborted();
      return received;
    } catch (error) {
      if (abort.signal.aborted) throw new Error('请求超时，请稍后重试。');
      if (error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)) throw error;
      throw new Error('网络连接失败或下载中断，请稍后重试。');
    } finally { clearTimeout(timer); response?.close(); }
  }
  return {
    async feed(): Promise<Buffer> {
      const chunks: Buffer[] = [];
      await consume(options.feed, MAX_FEED_SIZE, async data => { chunks.push(Buffer.from(data)); });
      return Buffer.concat(chunks);
    },
    async download(pkg: UpdatePackage, directory: string, progress: (received: number) => void): Promise<string> {
      if (!Number.isSafeInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_PACKAGE_SIZE || !/^[a-fA-F0-9]{64}$/.test(pkg.sha256)) throw new Error('安装包大小或 SHA-256 格式不对。');
      await cleanPartialDownloads(directory);
      const partial = join(directory, 'package.zip.part'), complete = join(directory, 'package.zip');
      await rm(complete, { force: true });
      const file = await open(partial, 'wx', 0o600), hash = createHash('sha256');
      try {
        const received = await consume(pkg.url, pkg.size, async (data, count) => {
          hash.update(data);
          // writeFile 会处理短写，文件句柄的偏移随每块前进。
          await file.writeFile(data);
          progress(count);
        });
        if (received !== pkg.size) throw new Error('更新包大小不符，没有安装。');
        if (hash.digest('hex') !== pkg.sha256.toLowerCase()) throw new Error('更新包的内容和发布的不一致，没有安装。');
        await file.sync(); await file.close();
        await rename(partial, complete);
        return complete;
      } catch (error) { await file.close().catch(() => {}); await rm(partial, { force: true }); throw error; }
    },
  };
}
export async function cleanPartialDownloads(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) if (name.endsWith('.part')) await rm(join(directory, name), { recursive: true, force: true });
}
