import { createPublicKey, verify } from 'node:crypto';

export const MAX_PACKAGE_SIZE = 1024 ** 3;
export const MAX_FEED_SIZE = 128 * 1024;
export const MAX_NOTES_LENGTH = 8000;
export type UpdatePackage = { url: string; size: number; sha256: string };
export type UpdateFeed = { version: string; publishedAt: string; notes: string; minimumVersion: string; packages: Record<string, UpdatePackage> };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function fields(v: unknown, keys: string[], label: string): asserts v is Record<string, unknown> {
  if (!object(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error(`${label}字段不完整或含有不认识的字段。`);
}
export function validVersion(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) && v.split('.').every(n => Number.isSafeInteger(Number(n)));
}
export function compareVersions(a: string, b: string): number {
  if (!validVersion(a) || !validVersion(b)) throw new Error('版本号必须是规范的 x.y.z。');
  const right = b.split('.').map(Number);
  for (const [i, n] of a.split('.').map(Number).entries()) if (n !== right[i]) return n > right[i] ? 1 : -1;
  return 0;
}
export function httpsUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error('更新地址格式不对。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('更新地址格式不对。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('更新地址必须是 HTTPS，且不能含登录信息或片段。');
  return url;
}
export function validateFeed(v: unknown): UpdateFeed {
  fields(v, ['version', 'publishedAt', 'notes', 'minimumVersion', 'packages'], '更新清单');
  if (!validVersion(v.version) || !validVersion(v.minimumVersion)) throw new Error('版本号必须是规范的 x.y.z。');
  if (compareVersions(v.minimumVersion, v.version) > 0) throw new Error('最低支持版本不能高于发布版本。');
  if (typeof v.publishedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.publishedAt) || !Number.isFinite(Date.parse(v.publishedAt)) || new Date(v.publishedAt).toISOString() !== v.publishedAt) throw new Error('发布时间必须是有效的 UTC 时间。');
  // 说明只作文字传给界面；允许换行和制表，拒绝其他控制字符及双向文字控制符。
  if (typeof v.notes !== 'string' || !v.notes.trim() || v.notes.length > MAX_NOTES_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v.notes)) throw new Error('更新说明须为 1–8000 字的纯文字。');
  if (!object(v.packages) || Object.keys(v.packages).length < 1 || Object.keys(v.packages).length > 16) throw new Error('安装包列表须有 1–16 个平台。');
  for (const [platform, pkg] of Object.entries(v.packages)) {
    if (!/^[a-z][a-z0-9]{0,19}-[a-z0-9]{1,20}$/.test(platform)) throw new Error('安装包的平台名称不对。');
    fields(pkg, ['url', 'size', 'sha256'], '安装包');
    httpsUrl(pkg.url);
    if (!Number.isSafeInteger(pkg.size) || (pkg.size as number) <= 0 || (pkg.size as number) > MAX_PACKAGE_SIZE) throw new Error('安装包大小须为正整数，且不能超过 1 GB。');
    if (typeof pkg.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(pkg.sha256)) throw new Error('安装包 SHA-256 须为 64 位十六进制。');
  }
  return v as UpdateFeed;
}
function base64(value: unknown, bytes: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes / 3) * 4) throw new Error(`${label}格式不对。`);
  const data = Buffer.from(value, 'base64');
  if (data.length !== bytes || data.toString('base64') !== value) throw new Error(`${label}格式不对。`);
  return data;
}
export function updatePublicKey(value: string) {
  const raw = base64(value, 32, '更新公钥');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}
export function verifyFeed(input: Uint8Array | string, publicKey: string): UpdateFeed {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (bytes.byteLength > MAX_FEED_SIZE) throw new Error('更新清单太大。');
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('更新清单不是有效的 UTF-8 JSON。'); }
  fields(envelope, ['body', 'signature'], '签名清单');
  if (typeof envelope.body !== 'string' || Buffer.byteLength(envelope.body, 'utf8') > 64 * 1024 || Buffer.from(envelope.body, 'utf8').toString('utf8') !== envelope.body) throw new Error('清单正文格式不对或太长。');
  const signature = base64(envelope.signature, 64, '清单签名');
  // 先验原文的 UTF-8 字节，再解析正文，绝不重排或重新序列化后验签。
  if (!verify(null, Buffer.from(envelope.body, 'utf8'), updatePublicKey(publicKey), signature)) throw new Error('更新清单签名不对，没有安装。');
  let body: unknown;
  try { body = JSON.parse(envelope.body); } catch { throw new Error('清单正文不是有效的 JSON。'); }
  return validateFeed(body);
}
export function selectUpdate(feed: UpdateFeed, current: string, platform: string, arch: string): UpdatePackage | null {
  if (compareVersions(feed.version, current) <= 0) return null;
  if (compareVersions(current, feed.minimumVersion) < 0) throw new Error(`当前版本过旧，请手动安装 ${feed.version}。`);
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(feed.packages, key)) throw new Error('这个平台暂时没有更新包');
  return feed.packages[key];
}
