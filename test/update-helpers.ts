import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { UpdateFeed } from '../app/main/update-feed.ts';
import type { UpdateResponse } from '../app/main/update-download.ts';

export const keys = generateKeyPairSync('ed25519');
export const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
export const data = Buffer.from('假的应用安装包');
export const pkg = { url: 'https://updates.example.invalid/app.zip', size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
export function feed(extra: Partial<UpdateFeed> = {}): UpdateFeed {
  return { version: '0.2.0', publishedAt: '2026-10-10T12:00:00.000Z', notes: '修好一件事\n第二行', minimumVersion: '0.1.0', packages: { 'darwin-arm64': { ...pkg } }, ...extra };
}
export function signed(value: unknown = feed(), raw?: string): Buffer {
  const body = raw ?? JSON.stringify(value);
  return Buffer.from(JSON.stringify({ body, signature: sign(null, Buffer.from(body), keys.privateKey).toString('base64') }));
}
export function response(chunks: Uint8Array[] = [data], extra: Partial<UpdateResponse> = {}): UpdateResponse {
  return { status: 200, body: (async function* () { yield* chunks; })(), close() {}, ...extra };
}
// 小 ZIP 夹具：真实目录和本地头，含 CRC 与 Unix 模式，用于测试解压前检查。
export function zip(entries: { name: string; body?: string; mode?: number; deflate?: boolean }[]): Buffer {
  let offset = 0;
  const locals: Buffer[] = [], central: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body ?? ''), compressed = entry.deflate ? deflateRawSync(body) : body;
    let crc = -1;
    for (const byte of body) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE((crc ^ -1) >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x0314, 4); dir.writeUInt16LE(20, 6);
    local.copy(dir, 8, 6, 28); dir.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(dir, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
