import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanPartialDownloads, updateClient, updateHosts } from '../app/main/update-download.ts';
import type { UpdateFetch } from '../app/main/update-download.ts';
import { data, pkg, response } from './update-helpers.ts';
import { context } from './helpers.ts';
const config = { feed: 'https://updates.example.invalid/latest.json', hosts: ['cdn.example.invalid'], version: '0.1.0' };

test('流式下载、大小和 SHA-256 核对、固定请求头、允许跳转、残留清理', async t => {
  const c = await context(t, false), directory = join(c.temp, 'updates');
  await cleanPartialDownloads(directory); await writeFile(join(directory, 'old.zip.part'), '半份'); await writeFile(join(directory, 'keep.log'), '保留');
  const urls: string[] = [], progress: number[] = []; let closed = 0;
  const fetch: UpdateFetch = async (url, options) => {
    urls.push(url.href);
    assert.deepEqual(options.headers, { 'User-Agent': 'Xagents/0.1.0', Accept: '*/*', 'Accept-Encoding': 'identity' });
    assert.ok(options.signal instanceof AbortSignal);
    return urls.length === 1 ? response([], { status: 302, location: 'https://cdn.example.invalid/a.zip', close() { closed++; } }) : response([data.subarray(0, 4), data.subarray(4)], { close() { closed++; } });
  };
  const file = await updateClient({ ...config, fetch }).download(pkg, directory, count => progress.push(count));
  assert.deepEqual(await readFile(file), data); assert.deepEqual(progress, [4, data.length]);
  assert.deepEqual((await readdir(directory)).sort(), ['keep.log', 'package.zip']); assert.equal(closed, 2);
  assert.deepEqual(urls, [pkg.url, 'https://cdn.example.invalid/a.zip']);
});
for (const scenario of ['主机越界', 'HTTP 跳转', '初始 HTTP', '初始越界', '过大', '短包', '哈希错误', '断开', 'HTTP 错误', '循环跳转'] as const) test(`下载拒绝 ${scenario}，不留下包`, async t => {
  const c = await context(t, false), directory = join(c.temp, 'updates'); let requests = 0;
  const fetch: UpdateFetch = async () => {
    requests++;
    if (scenario === '主机越界') return response([], { status: 302, location: 'https://evil.example.invalid/a' });
    if (scenario === 'HTTP 跳转') return response([], { status: 302, location: 'http://updates.example.invalid/a' });
    if (scenario === '循环跳转') return response([], { status: 302, location: '/loop' });
    if (scenario === 'HTTP 错误') return response([], { status: 500 });
    if (scenario === '断开') return response([], { body: (async function* () { yield data.subarray(0, 2); throw new Error('ECONNRESET'); })() });
    return response([scenario === '过大' ? Buffer.concat([data, data]) : scenario === '短包' ? data.subarray(1) : scenario === '哈希错误' ? Buffer.alloc(data.length) : data]);
  };
  const selected = { ...pkg, ...(scenario === '初始 HTTP' ? { url: 'http://updates.example.invalid/a' } : scenario === '初始越界' ? { url: 'https://evil.example.invalid/a' } : {}) };
  await assert.rejects(updateClient({ ...config, fetch }).download(selected, directory, () => {}), /[\u3400-\u9fff]/u);
  assert.deepEqual(await readdir(directory), []);
  if (scenario.startsWith('初始')) assert.equal(requests, 0);
  else if (scenario === '循环跳转') assert.equal(requests, 6);
  else assert.equal(requests, 1);
});
test('超过声明大小立即中止，不再读取后续块', async t => {
  const c = await context(t, false); let after = false;
  const fetch: UpdateFetch = async () => response([], { body: (async function* () { yield Buffer.alloc(data.length + 1); after = true; yield data; })() });
  await assert.rejects(updateClient({ ...config, fetch }).download(pkg, join(c.temp, 'u'), () => {}), /超过/); assert.equal(after, false);
});
test('清单大小有限、超时中止、名单必须是主机与明确端口', async () => {
  await assert.rejects(updateClient({ ...config, fetch: async () => response([Buffer.alloc(128 * 1024 + 1)]) }).feed(), /超过/);
  let aborted = false;
  const fetch: UpdateFetch = async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }); });
  await assert.rejects(updateClient({ ...config, fetch, timeoutMs: 5 }).feed(), /超时/); assert.ok(aborted);
  for (const host of ['evil/path', 'user@host', 'https://host', '', 'host#fragment']) assert.throws(() => updateHosts(config.feed, [host]));
  assert.deepEqual([...updateHosts(config.feed, ['localhost:9443'])], ['updates.example.invalid', 'localhost:9443']);
});

test('下载中超时会关闭响应并删除已经写下的半包', async t => {
  const c = await context(t, false), directory = join(c.temp, 'updates'); let closed = false;
  const fetch: UpdateFetch = async (_url, { signal }) => response([], { close() { closed = true; }, body: (async function* () {
    yield data.subarray(0, 2);
    await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  })() });
  await assert.rejects(updateClient({ ...config, fetch, timeoutMs: 20 }).download(pkg, directory, () => {}), /超时/);
  assert.equal(closed, true); assert.deepEqual(await readdir(directory), []);
});
