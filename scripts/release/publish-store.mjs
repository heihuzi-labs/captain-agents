import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, verifyFeed } from '../../app/main/update-feed.ts';

// 存放约定（各应用共用一个公开下载桶）：<应用英文名>/<通道>/<版本号>/<应用英文名>_<版本号>_<系统>-<架构>.zip
const APP = 'captain-agents', BUCKET = 'heihuzi-prod-tokyo-downloads', REGION = 'ap-northeast-1';
const SYSTEMS = { darwin: 'macos', win32: 'windows', linux: 'linux' };

export function storeKey(version, platform, channel = 'stable') {
  const at = platform.indexOf('-'), system = SYSTEMS[platform.slice(0, at)], arch = platform.slice(at + 1);
  if (at < 1 || !Object.hasOwn(SYSTEMS, platform.slice(0, at)) || !['x64', 'arm64'].includes(arch)) throw new Error(`不认识的平台：${platform}`);
  if (channel !== 'stable' && channel !== 'beta') throw new Error('通道只能是 stable 或 beta。');
  return `${APP}/${channel}/${version}/${APP}_${version}_${system}-${arch}.zip`;
}
export function publicUrl(key) { return `https://${BUCKET}.oss-${REGION}.aliyuncs.com/${key}`; }

async function digest(chunks) {
  let size = 0;
  const hash = createHash('sha256');
  for await (const chunk of chunks) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
// 取公网文件的一段；没有这个文件返回 null。单条连接可能很慢，所以整份文件分段同时取。
const PART = 2 * 1024 * 1024, PARALLEL = 32;
async function readPart(url, from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'error', headers: { range: `bytes=${from}-${to}` } });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (response.status !== 206) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]), data = Buffer.from(await response.arrayBuffer());
      if (!Number.isSafeInteger(total) || data.length !== Math.min(to, total - 1) - from + 1) throw new Error('返回的长度不对');
      return { total, data };
    } catch (error) { if (attempt >= 3) throw new Error(`读取 ${url} 失败（${error.message}）。`); }
  }
}
// 公网上这个地址现在是什么：没有文件返回 null，有就整份下载回来算大小和 SHA-256。
async function readRemote(url) {
  const first = await readPart(url, 0, PART - 1);
  if (!first) return null;
  const hash = createHash('sha256').update(first.data);
  for (let from = PART; from < first.total; from += PART * PARALLEL) {
    const starts = [];
    for (let start = from; start < Math.min(first.total, from + PART * PARALLEL); start += PART) starts.push(start);
    for (const part of await Promise.all(starts.map(start => readPart(url, start, Math.min(start + PART, first.total) - 1)))) {
      if (!part || part.total !== first.total) throw new Error(`读取 ${url} 时文件变了。`);
      hash.update(part.data);
    }
  }
  return { size: first.total, sha256: hash.digest('hex') };
}
// 清单需要原始字节来验签和逐字节比较，不能复用安装包的摘要读取。
async function readRemoteFeed(url) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`读取清单失败（HTTP ${response.status}）。`); }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)) throw error;
    throw new Error('读取公网清单失败，请稍后重试。');
  }
}
// 只有通道的 latest-v2.json 可以覆盖，安装包始终保留 --ignore-existing。
function uploadToStore(file, key, options) {
  const overwrite = options.overwrite === true && /^captain-agents\/(stable|beta)\/latest-v2\.json$/.test(key);
  const args = ['ossutil', 'cp', file, `oss://${BUCKET}/${key}`, overwrite ? '-f' : '--ignore-existing', '--region', REGION, ...(options.profile ? ['--profile', options.profile] : [])];
  return new Promise((done, fail) => {
    const child = spawn('aliyun', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => fail(new Error('没找到阿里云命令行（aliyun），没有上传。')));
    child.on('close', code => code === 0 ? done() : fail(new Error(`上传 ${key} 失败（aliyun 退出码 ${code}）。`)));
  });
}
const same = (a, b) => a.size === b.size && a.sha256 === b.sha256;

export async function publishStore(options, deps = { remote: readRemote, remoteFeed: readRemoteFeed, upload: uploadToStore }) {
  const bytes = await readFile(options.manifest), feed = verifyFeed(bytes, options.publicKey);
  const wanted = Object.keys(feed.packages), given = new Set(options.packages.map(p => p.platform));
  if (given.size !== options.packages.length || given.size !== wanted.length || !wanted.every(p => given.has(p))) throw new Error(`安装包要和签名清单里的平台一一对应：${wanted.join('、')}。`);
  const items = [];
  for (const { platform, file } of options.packages) {
    const expected = feed.packages[platform], key = storeKey(feed.version, platform, options.channel);
    if (!expected.urls.includes(publicUrl(key))) throw new Error(`${platform} 的清单没有写入约定的桶地址，请检查安装包文件名和下载地址，没有上传。`);
    if (!same(await digest(createReadStream(file)), expected)) throw new Error(`${platform} 的安装包和签名清单对不上，没有上传。`);
    items.push({ platform, file, key, url: publicUrl(key), expected });
  }
  // 动手之前先把每个地址看一遍：发布过的不改不删，已有的文件只能和清单一模一样。
  for (const item of items) {
    item.existed = await deps.remote(item.url);
    if (item.existed && !same(item.existed, item.expected)) throw new Error(`${item.url} 已经有一个内容不同的文件。发布过的不改不删，请发更高的版本号。`);
  }
  for (const item of items) {
    if (options.dryRun) { item.state = item.existed ? '已在桶里，内容一致' : '还没上传'; continue; }
    if (!item.existed) await deps.upload(item.file, item.key, { ...options, overwrite: false });
    const after = await deps.remote(item.url);
    if (!after || !same(after, item.expected)) throw new Error(`从公网取回的 ${item.url} 和签名清单对不上。这个地址不要给用户，查清原因后发更高的版本号。`);
    item.state = item.existed ? '已在桶里，内容一致' : '已上传，公网取回核对一致';
  }
  let publishedFeed;
  if (options.publishFeed) {
    const key = `${APP}/${options.channel ?? 'stable'}/latest-v2.json`, url = publicUrl(key);
    const before = await deps.remoteFeed(url);
    let state = '没有';
    if (before !== null) {
      if (bytes.equals(before)) state = '相同';
      else {
        let newer = false;
        try { newer = compareVersions(verifyFeed(before, options.publicKey).version, feed.version) > 0; }
        catch { /* 无效清单可以由本次已核对的清单替换。 */ }
        state = newer ? '会被拒绝' : '会覆盖';
      }
    }
    if (!options.dryRun && state !== '相同') {
      if (state === '会被拒绝') throw new Error('桶里的清单版本更高，不能换回旧版本，没有上传清单。');
      await deps.upload(options.manifest, key, { ...options, overwrite: true });
      const after = await deps.remoteFeed(url);
      if (after === null || !bytes.equals(after)) throw new Error('从公网取回的清单和本地文件不一致，发布没有完成。');
      state = '已上传，公网取回核对一致';
    }
    publishedFeed = { url, state };
  }
  return { ...(publishedFeed ? { feed: publishedFeed } : {}), version: feed.version, items: items.map(({ platform, url, state, expected }) => ({ platform, url, state, size: expected.size, sha256: expected.sha256 })) };
}
export function parseArguments(args) {
  const result = { packages: [], dryRun: false };
  const keys = { '--manifest': 'manifest', '--public-key': 'publicKey', '--channel': 'channel', '--profile': 'profile' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--publish-feed') { result.publishFeed = true; continue; }
    if (flag === '--dry-run') { result.dryRun = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少值。`);
    if (flag === '--package') {
      const at = value.indexOf('=');
      if (at < 1 || at === value.length - 1) throw new Error('安装包格式：--package darwin-arm64=/路径/安装包.zip');
      result.packages.push({ platform: value.slice(0, at), file: value.slice(at + 1) });
    } else if (Object.hasOwn(keys, flag) && !Object.hasOwn(result, keys[flag])) result[keys[flag]] = value;
    else throw new Error(`不认识或重复的参数：${flag}`);
  }
  for (const key of ['manifest', 'publicKey']) if (!result[key]) throw new Error(`缺少参数：${key}`);
  if (!result.packages.length) throw new Error('缺少参数：package');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await publishStore(parseArguments(process.argv.slice(2)));
    for (const item of result.items) console.log(`${item.platform}：${item.state}\n  ${item.url}\n  大小 ${item.size}，SHA-256 ${item.sha256}`);
    if (result.feed) console.log(`清单：${result.feed.state}\n  ${result.feed.url}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
