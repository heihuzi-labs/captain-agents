import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanPartialDownloads, updateClient, updateHosts } from '../app/main/update-download.ts';
import type { UpdateFetch } from '../app/main/update-download.ts';
import { data, pkg, response, feed, publicKey, signed } from './update-helpers.ts';
import { verifyFeed } from '../app/main/update-feed.ts';
import { createHash } from 'node:crypto';
import { context, until } from './helpers.ts';
const verify = (bytes: Uint8Array) => verifyFeed(bytes, publicKey);
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
  assert.deepEqual(urls, [pkg.urls[0], 'https://cdn.example.invalid/a.zip']);
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
  const selected = { ...pkg, ...(scenario === '初始 HTTP' ? { urls: ['http://updates.example.invalid/a'] } : scenario === '初始越界' ? { urls: ['https://evil.example.invalid/a'] } : {}) };
  await assert.rejects(updateClient({ ...config, fetch }).download(selected, directory, () => {}), /[\u3400-\u9fff]/u);
  assert.deepEqual(await readdir(directory).catch(() => []), []);
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
  await assert.rejects(updateClient({ ...config, fetch: async () => response([Buffer.alloc(128 * 1024 + 1)]) }).feed(verify), /超过/);
  let aborted = false;
  const fetch: UpdateFetch = async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }); });
  await assert.rejects(updateClient({ ...config, fetch, timeoutMs: 5 }).feed(verify), /超时/); assert.ok(aborted);
  for (const host of ['evil/path', 'user@host', 'https://host', '', 'host#fragment']) assert.throws(() => updateHosts(config.feed, [host]));
  assert.deepEqual([...updateHosts(config.feed, ['localhost:9443'])], ['updates.example.invalid', 'localhost:9443']);
});

const fallback = 'https://cdn.example.invalid/fallback.zip';
for (const reason of ['连不上', '非200', '中途断', '主机越界', '跳转越界', '大小不符', '超过大小', '哈希不符']) test(`首地址${reason}后顺序换地址，关闭连接、清半包、进度归零`, async t => {
  const c = await context(t, false), directory = join(c.temp, 'u'), calls: string[] = [], progress: number[] = [];
  let closed = false;
  const fetch: UpdateFetch = async url => {
    calls.push(url.href);
    if (url.href === fallback) {
      if (!['主机越界', '连不上'].includes(reason)) assert.ok(closed);
      assert.equal((await readFile(join(directory, 'package.zip.part'))).length, 0);
      assert.equal(progress.at(-1), 0);
      return response([data.subarray(0, 3), data.subarray(3)]);
    }
    if (reason === '连不上') throw new Error('ECONNREFUSED');
    const extra = { close() { closed = true; } };
    if (reason === '非200') return response([], { ...extra, status: 503 });
    if (reason === '跳转越界') return response([], { ...extra, status: 302, location: 'https://evil.invalid/a' });
    if (reason === '中途断') return response([], { ...extra, body: (async function* () { yield data.subarray(0, 2); throw new Error('ECONNRESET'); })() });
    return response([reason === '大小不符' ? data.subarray(0, 2) : reason === '超过大小' ? Buffer.concat([data, data]) : Buffer.alloc(data.length)], extra);
  };
  const first = reason === '主机越界' ? 'https://evil.invalid/a' : pkg.urls[0];
  const file = await updateClient({ ...config, fetch }).download({ ...pkg, urls: [first, fallback] }, directory, n => progress.push(n));
  assert.deepEqual(await readFile(file), data);
  assert.deepEqual(calls, reason === '主机越界' ? [fallback] : [first, fallback]);
  assert.deepEqual(progress.slice(-3), [0, 3, data.length]);
  assert.deepEqual(await readdir(directory), ['package.zip']);
});
test('全部失败只报最后地址原因，删除半包', async t => {
  const c = await context(t, false), directory = join(c.temp, 'u');
  const fetch: UpdateFetch = async url => url.href === fallback ? response([data.subarray(0, 1)]) : response([], { status: 502 });
  await assert.rejects(updateClient({ ...config, fetch }).download({ ...pkg, urls: [...pkg.urls, fallback] }, directory, () => {}), /更新包大小不符/);
  assert.deepEqual(await readdir(directory), []);
});

// 可手动推送的响应与单调假时钟，不监听端口、不实际等 20 秒或 60 秒。
function clockFixture() {
  let now = 0, id = 0;
  const tasks = new Map<number, { at: number; callback(): void }>();
  return { tasks, now: () => now,
    setTimeout(callback: () => void, ms: number) { tasks.set(++id, { at: now + ms, callback }); return id; },
    clearTimeout(timer: unknown) { tasks.delete(timer as number); },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; tasks.delete(next[0]); next[1].callback();
      }
      now = end;
    },
  };
}
function controlledResponse() {
  let resolve!: (value: IteratorResult<Uint8Array>) => void;
  let reads = 0, closed = false;
  const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next() { reads++; return new Promise<IteratorResult<Uint8Array>>(done => { resolve = done; }); } }; } };
  return { response: response([], { body, close() { closed = true; } }),
    get reads() { return reads; }, get closed() { return closed; },
    send(value: Uint8Array) { resolve({ value, done: false }); }, end() { resolve({ value: undefined, done: true }); } };
}

for (const scenario of ['停滞', '数据后停滞', '空数据停滞', '太慢', '响应头停滞']) test(`假时钟驱动${scenario}后切换；计时器和半包清理`, async t => {
  const c = await context(t, false), directory = join(c.temp, 'u'), clock = clockFixture(), stream = controlledResponse();
  const content = Buffer.alloc(100), selected = { urls: [...pkg.urls, fallback], size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  const progress: number[] = []; let calls = 0;
  const fetch: UpdateFetch = async url => { calls++; return url.href === fallback ? response([content]) : scenario === '响应头停滞' ? new Promise(() => {}) : stream.response; };
  const pending = updateClient({ ...config, fetch, clock }).download(selected, directory, n => progress.push(n));
  await until(async () => calls === 1);
  if (scenario !== '响应头停滞') {
    await until(async () => stream.reads === 1);
    if (scenario === '太慢') {
      clock.advance(10_000); stream.send(content.subarray(0, 1));
      await until(async () => stream.reads === 2);
      clock.advance(19_999); assert.equal(calls, 1); clock.advance(1);
    } else {
      if (scenario === '数据后停滞') { stream.send(content.subarray(0, 80)); await until(async () => stream.reads === 2); }
      if (scenario === '空数据停滞') { clock.advance(59_999); stream.send(Buffer.alloc(0)); await until(async () => stream.reads === 2); clock.advance(1); }
      else { clock.advance(59_999); assert.equal(calls, 1); clock.advance(1); }
    }
  } else clock.advance(60_000);
  assert.deepEqual(await readFile(await pending), content);
  assert.equal(calls, 2); assert.deepEqual(progress.slice(-2), [0, content.length]);
  if (scenario !== '响应头停滞') assert.ok(stream.closed);
  assert.equal(clock.tasks.size, 0);
  assert.deepEqual(await readdir(directory), ['package.zip']);
});
test('最后一个地址持续很慢也能完成，超过原来的十分钟不被打断', async t => {
  const c = await context(t, false), clock = clockFixture(), stream = controlledResponse();
  const pending = updateClient({ ...config, clock, fetch: async () => stream.response }).download(pkg, join(c.temp, 'u'), () => {});
  await until(async () => stream.reads === 1);
  for (let i = 0; i < data.length; i++) {
    clock.advance(40_000); stream.send(data.subarray(i, i + 1));
    await until(async () => stream.reads === i + 2);
  }
  stream.end(); assert.deepEqual(await readFile(await pending), data);
  assert.ok(clock.now() > 600_000); assert.equal(clock.tasks.size, 0);
});
test('安装包全程六十分钟上限与停滞无关，超时清半包', async t => {
  const c = await context(t, false), directory = join(c.temp, 'u'), clock = clockFixture(), stream = controlledResponse();
  const pending = updateClient({ ...config, clock, fetch: async () => stream.response }).download({ ...pkg, size: 1000 }, directory, () => {});
  const rejected = assert.rejects(pending, /请求超时/);
  await until(async () => stream.reads === 1);
  for (let i = 0; i < 89; i++) {
    clock.advance(40_000); stream.send(Buffer.from([1])); await until(async () => stream.reads === i + 2);
  }
  clock.advance(40_000); await rejected;
  assert.ok(stream.closed); assert.equal(clock.tasks.size, 0); assert.deepEqual(await readdir(directory), []);
});
test('清单使用三十秒总限时', async () => {
  const clock = clockFixture(), stream = controlledResponse();
  const pending = updateClient({ ...config, clock, fetch: async () => stream.response }).feed(verify);
  const rejected = assert.rejects(pending, /请求超时/);
  await until(async () => stream.reads === 1);
  clock.advance(29_999); assert.equal(stream.closed, false); clock.advance(1);
  await rejected; assert.ok(stream.closed); assert.equal(clock.tasks.size, 0);
});

const secondFeed = 'https://feeds.example.invalid/latest-v2.json';
for (const reason of ['连不上', '非200', '响应头超时', '读数据超时', '不是清单', '签名不对', '超过128KiB', '跳转越界']) test(`清单首地址${reason}后核对第二份`, async () => {
  const clock = clockFixture(), calls: string[] = [], stream = controlledResponse();
  const tampered = JSON.parse(signed().toString()); tampered.body += ' ';
  const client = updateClient({ ...config, feed: `${config.feed},${secondFeed}`, clock, fetch: async (url, { headers }) => {
    calls.push(url.href);
    assert.deepEqual(headers, { 'User-Agent': 'Xagents/0.1.0', Accept: '*/*', 'Accept-Encoding': 'identity' });
    if (url.href === secondFeed) return response([signed()]);
    if (reason === '连不上') throw new Error('ECONNREFUSED');
    if (reason === '非200') return response([], { status: 503 });
    if (reason === '响应头超时') return new Promise(() => {});
    if (reason === '读数据超时') return stream.response;
    if (reason === '跳转越界') return response([], { status: 302, location: 'https://evil.invalid/feed' });
    return response([reason === '不是清单' ? Buffer.from('{}') : reason === '签名不对' ? Buffer.from(JSON.stringify(tampered)) : Buffer.alloc(128 * 1024 + 1)]);
  } });
  const pending = client.feed(verify);
  if (reason.includes('超时')) {
    await until(async () => reason === '读数据超时' ? stream.reads === 1 : calls.length === 1);
    clock.advance(29_999); assert.equal(calls.length, 1); clock.advance(1);
  }
  assert.deepEqual(await pending, feed()); assert.deepEqual(calls, [config.feed, secondFeed]);
  assert.equal(clock.tasks.size, 0);
  if (reason === '读数据超时') assert.ok(stream.closed);
});
test('清单全部失败报最后地址的验签或网络原因', async () => {
  for (const last of ['验签', '网络']) {
    const tampered = JSON.parse(signed().toString()); tampered.body += ' ';
    const client = updateClient({ ...config, feed: `${config.feed},${secondFeed}`, fetch: async url =>
      url.href !== secondFeed ? response([], { status: 502 }) : last === '网络' ? response([], { status: 504 }) : response([Buffer.from(JSON.stringify(tampered))]) });
    await assert.rejects(client.feed(verify), last === '验签' ? /签名不对/ : /504/);
  }
});
test('清单地址全部加入名单，可互相跳转和下载安装包', async t => {
  const c = await context(t, false), feeds = `${config.feed},${secondFeed}`;
  assert.deepEqual([...updateHosts(feeds, [])], ['updates.example.invalid', 'feeds.example.invalid']);
  assert.deepEqual([...updateHosts(` ${config.feed} , ${secondFeed}\n`, [])], ['updates.example.invalid', 'feeds.example.invalid'], '逗号前后的空白不算数');
  let calls = 0;
  const client = updateClient({ ...config, feed: feeds, hosts: [], fetch: async () => ++calls === 1
    ? response([], { status: 302, location: secondFeed }) : response([calls === 2 ? signed() : data]) });
  assert.deepEqual(await client.feed(verify), feed());
  assert.deepEqual(await readFile(await client.download({ ...pkg, urls: ['https://feeds.example.invalid/app.zip'] }, join(c.temp, 'u'), () => {})), data);
});
for (const invalid of [`${config.feed},${config.feed}`, `${config.feed},`, `,${config.feed}`, `${config.feed},,${secondFeed}`, 'http://feeds.invalid/a', Array.from({ length: 5 }, (_, i) => `https://feeds.invalid/${i}`).join(',')]) test(`拒绝错误清单配置 ${invalid}`, () => {
  assert.throws(() => updateClient({ ...config, feed: invalid }));
});
for (const outcome of ['完成', '停滞', '超时']) test(`慢地址最后回头重试：${outcome}；不受慢速规则影响且清理半包`, async t => {
  const c = await context(t, false), directory = join(c.temp, 'u'), clock = clockFixture();
  const first = controlledResponse(), retry = controlledResponse(), calls: string[] = [], progress: number[] = [];
  const content = Buffer.alloc(1000), selected = { urls: [...pkg.urls, fallback], size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  const pending = updateClient({ ...config, clock, fetch: async url => {
    calls.push(url.href);
    if (calls.length === 1) return first.response;
    if (calls.length === 2) return response([], { status: 503 });
    assert.equal((await readFile(join(directory, 'package.zip.part'))).length, 0);
    assert.equal(progress.at(-1), 0);
    return retry.response;
  } }).download(selected, directory, n => progress.push(n));
  const rejected = outcome === '完成' ? undefined : assert.rejects(pending, outcome === '停滞' ? /长时间没有收到/ : /请求超时/);
  await until(async () => first.reads === 1); first.send(content.subarray(0, 1));
  await until(async () => first.reads === 2); clock.advance(20_000);
  await until(async () => retry.reads === 1);
  assert.ok(first.closed); assert.deepEqual(calls, [pkg.urls[0], fallback, pkg.urls[0]]);
  retry.send(content.subarray(0, 1)); await until(async () => retry.reads === 2);
  clock.advance(20_000); assert.equal(retry.closed, false);
  if (outcome === '停滞') { clock.advance(40_000); await rejected; }
  else if (outcome === '超时') {
    for (let i = 0; i < 89; i++) {
      clock.advance(i === 0 ? 20_000 : 40_000); retry.send(content.subarray(0, 1));
      await until(async () => retry.reads === i + 3);
    }
    clock.advance(40_000); await rejected;
  } else {
    retry.send(content.subarray(1)); await until(async () => retry.reads === 3); retry.end();
    assert.deepEqual(await readFile(await pending), content);
  }
  assert.equal(calls.length, 3); assert.equal(clock.tasks.size, 0); assert.ok(retry.closed);
  assert.deepEqual(await readdir(directory), outcome === '完成' ? ['package.zip'] : []);
});
test('普通失败不会回头重试', async t => {
  const c = await context(t, false), calls: string[] = [];
  await assert.rejects(updateClient({ ...config, fetch: async url => { calls.push(url.href); return response([], { status: calls.length === 1 ? 502 : 503 }); } })
    .download({ ...pkg, urls: [...pkg.urls, fallback] }, join(c.temp, 'u'), () => {}), /503/);
  assert.deepEqual(calls, [...pkg.urls, fallback]);
});

test('多个地址都太慢时，只回头重试顺序最早的地址', async t => {
  const c = await context(t, false), clock = clockFixture(), first = controlledResponse(), second = controlledResponse();
  const calls: string[] = [], last = 'https://cdn.example.invalid/last.zip', content = Buffer.alloc(1000);
  const selected = { urls: [...pkg.urls, fallback, last], size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  const pending = updateClient({ ...config, clock, fetch: async url => {
    calls.push(url.href);
    return calls.length === 1 ? first.response : calls.length === 2 ? second.response : calls.length === 3 ? response([], { status: 503 }) : response([content]);
  } }).download(selected, join(c.temp, 'u'), () => {});
  for (const stream of [first, second]) {
    await until(async () => stream.reads === 1); stream.send(content.subarray(0, 1));
    await until(async () => stream.reads === 2); clock.advance(20_000);
  }
  assert.deepEqual(await readFile(await pending), content);
  assert.deepEqual(calls, [...selected.urls, selected.urls[0]]); assert.equal(clock.tasks.size, 0);
});
