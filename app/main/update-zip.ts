import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// 在系统解压工具接触文件前检查目录，禁止越界路径、链接父目录、ZIP64 和解压炸弹。
// 发布包上限 1 GB，展开上限 4 GB；Electron Frameworks 内的相对符号链接可以保留。
export async function checkUpdateZip(file: string): Promise<void> {
  const handle = await open(file, 'r');
  const fail = () => new Error('更新 ZIP 的目录不安全或格式不支持，没有安装。');
  const read = async (offset: number, length: number) => {
    const buffer = Buffer.alloc(length);
    if (offset < 0 || (await handle.read(buffer, 0, length, offset)).bytesRead !== length) throw fail();
    return buffer;
  };
  try {
    const size = (await handle.stat()).size;
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw fail();
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!count || count === 65535 || tail.readUInt16LE(end + 8) !== count || length > 32 * 1024 ** 2 || offset + length !== size - tail.length + end) throw fail();
    const directory = await read(offset, length), entries = new Map<string, boolean>();
    let cursor = 0, expanded = 0;
    const decode = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(data);
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) throw fail();
      const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10);
      const packed = directory.readUInt32LE(cursor + 20), unpacked = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28), extra = directory.readUInt16LE(cursor + 30), comment = directory.readUInt16LE(cursor + 32);
      const mode = directory.readUInt32LE(cursor + 38) >>> 16, kind = mode & 0xf000, localOffset = directory.readUInt32LE(cursor + 42);
      if (cursor + 46 + nameLength + extra + comment > length || flags & 1 || ![0, 8].includes(method) || directory.readUInt16LE(cursor + 34) || ![0, 0x8000, 0x4000, 0xa000].includes(kind)) throw fail();
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength), name = decode(nameBytes);
      if (!name || name.length > 1024 || name.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(name) || name.split('/').some(p => p === '.' || p === '..') || name.includes('//')) throw fail();
      const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
      if (entries.has(key)) throw fail();
      entries.set(key, kind === 0xa000);
      expanded += unpacked;
      if (expanded > 4 * 1024 ** 3 || packed === 0xffffffff || localOffset + 30 + packed > offset) throw fail();
      const local = await read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameLength) throw fail();
      if (!(await read(localOffset + 30, nameLength)).equals(nameBytes)) throw fail();
      const dataOffset = localOffset + 30 + nameLength + local.readUInt16LE(28);
      if (dataOffset + packed > offset) throw fail();
      if (kind === 0xa000) {
        if (packed > 8192 || unpacked > 4096) throw fail();
        const data = await read(dataOffset, packed), target = decode(method === 0 ? data : inflateRawSync(data, { maxOutputLength: 4096 }));
        const resolved = posix.normalize(posix.join(posix.dirname(name), target));
        if (!target || target.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(target) || resolved.startsWith('../') || resolved === '..' || resolved.split('/')[0] !== name.split('/')[0]) throw fail();
      }
      cursor += 46 + nameLength + extra + comment;
    }
    if (cursor !== length) throw fail();
    for (const key of entries.keys()) {
      let parent = posix.dirname(key);
      while (parent !== '.') { if (entries.get(parent)) throw fail(); parent = posix.dirname(parent); }
    }
  } catch { throw fail(); }
  finally { await handle.close(); }
}
