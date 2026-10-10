import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpsUrl, MAX_PACKAGE_SIZE, validateFeed, verifyFeed } from '../../app/main/update-feed.ts';

async function digest(file) {
  const info = await stat(file);
  if (!info.isFile() || !file.toLowerCase().endsWith('.zip') || info.size <= 0 || info.size > MAX_PACKAGE_SIZE) throw new Error('安装包必须是 1 GB 以内的非空 ZIP 文件。');
  let size = 0;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { size += chunk.length; if (size > MAX_PACKAGE_SIZE) throw new Error('安装包超过 1 GB。'); hash.update(chunk); }
  if (size !== info.size) throw new Error('安装包在读取时改变了。');
  return { size, sha256: hash.digest('hex') };
}
export async function makeUpdate(options) {
  const prefix = httpsUrl(options.baseUrl);
  if (prefix.search) throw new Error('下载地址前缀不能带查询参数。');
  if (!prefix.pathname.endsWith('/')) prefix.pathname += '/';
  const privateKey = createPrivateKey(await readFile(options.privateKey));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('发布私钥必须是 Ed25519。');
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const packages = {}, urls = new Set();
  if (!Array.isArray(options.packages) || options.packages.length < 1 || options.packages.length > 16) throw new Error('需要 1–16 个平台的安装包。');
  for (const { platform, file } of options.packages) {
    if (Object.hasOwn(packages, platform) || !/^[a-z][a-z0-9]{0,19}-[a-z0-9]{1,20}$/.test(platform)) throw new Error('安装包平台重复或格式不对。');
    const url = new URL(encodeURIComponent(basename(file)), prefix).href;
    if (urls.has(url)) throw new Error('不同平台的 ZIP 文件名不能相同。');
    urls.add(url); packages[platform] = { url, ...await digest(file) };
  }
  const feed = validateFeed({ version: options.version, publishedAt: options.publishedAt ?? new Date().toISOString(),
    notes: await readFile(options.notes, 'utf8'), minimumVersion: options.minimumVersion, packages });
  const body = JSON.stringify(feed);
  const result = JSON.stringify({ body, signature: sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64') }, null, 2) + '\n';
  verifyFeed(result, publicKey);
  for (const { platform, file } of options.packages) {
    const verified = await digest(file);
    if (verified.size !== packages[platform].size || verified.sha256 !== packages[platform].sha256) throw new Error('签名后复核发现安装包改变了，请重新生成清单。');
  }
  // 完整写入再原子发布；link 不覆盖已有清单，发错路径也不会悄悄破坏上一版。
  const temporary = await mkdtemp(join(dirname(resolve(options.out)), '.update-feed-'));
  try {
    const file = join(temporary, 'latest.json');
    await writeFile(file, result, { flag: 'wx', mode: 0o644 });
    await link(file, options.out);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return feed;
}
export function parseArguments(args) {
  const result = { packages: [] };
  const keys = { '--version': 'version', '--minimum-version': 'minimumVersion', '--notes': 'notes', '--base-url': 'baseUrl', '--private-key': 'privateKey', '--out': 'out', '--published-at': 'publishedAt' };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少值。`);
    if (flag === '--package') {
      const at = value.indexOf('=');
      if (at < 1 || at === value.length - 1) throw new Error('安装包格式：--package darwin-arm64=/路径/安装包.zip');
      result.packages.push({ platform: value.slice(0, at), file: value.slice(at + 1) });
    } else if (Object.hasOwn(keys, flag) && !Object.hasOwn(result, keys[flag])) result[keys[flag]] = value;
    else throw new Error(`不认识或重复的参数：${flag}`);
  }
  for (const key of ['version', 'minimumVersion', 'notes', 'baseUrl', 'privateKey', 'out']) if (!result[key]) throw new Error(`缺少参数：${key}`);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const feed = await makeUpdate(parseArguments(process.argv.slice(2))); console.log(`版本 ${feed.version} 的清单已签名，签名、大小和 SHA-256 复核通过。`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
