import { open } from 'node:fs/promises';

// 只读 PE 头和 RT_VERSION，不执行下载的程序，也不调用 PowerShell。
// NSIS 安装器的引导程序是 32 位 PE，即使内装的是 x64 应用。
export async function windowsExecutableVersion(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (offset: number, length: number) => {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error('PE 越界');
      const data = Buffer.alloc(length);
      if ((await handle.read(data, 0, length, offset)).bytesRead !== length) throw new Error('PE 截断');
      return data;
    };
    const dos = await read(0, 64);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('非 MZ');
    const peOffset = dos.readUInt32LE(60), pe = await read(peOffset, 24);
    if (peOffset < 64 || pe.readUInt32LE(0) !== 0x4550 || ![0x14c, 0x8664].includes(pe.readUInt16LE(4)) || !(pe.readUInt16LE(22) & 2) || (pe.readUInt16LE(22) & 0x2000)) throw new Error('非可执行 PE');
    const count = pe.readUInt16LE(6), optionalSize = pe.readUInt16LE(20);
    if (!count || count > 96 || optionalSize < 120 || optionalSize > 4096) throw new Error('PE 头');
    const optional = await read(peOffset + 24, optionalSize), magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
    if (!directories || optionalSize < directories + 24 || optional.readUInt32LE(directories - 4) < 3) throw new Error('PE 资源表');
    const sections = await read(peOffset + 24 + optionalSize, count * 40);
    const offsetOf = (rva: number, length: number) => {
      for (let i = 0; i < count; i++) {
        const entry = i * 40, start = sections.readUInt32LE(entry + 12), rawSize = sections.readUInt32LE(entry + 16);
        if (rva >= start && rva - start + length <= rawSize) return sections.readUInt32LE(entry + 20) + rva - start;
      }
      throw new Error('PE 资源越界');
    };
    const rva = optional.readUInt32LE(directories + 16), resourceSize = optional.readUInt32LE(directories + 20);
    if (resourceSize < 16 || resourceSize > 16 * 1024 * 1024) throw new Error('PE 资源大小');
    const resource = await read(offsetOf(rva, resourceSize), resourceSize);
    const entry = (offset: number, id?: number) => {
      if (offset + 16 > resource.length) throw new Error('PE 目录越界');
      const n = resource.readUInt16LE(offset + 12) + resource.readUInt16LE(offset + 14);
      if (!n || offset + 16 + n * 8 > resource.length) throw new Error('PE 目录');
      for (let i = 0; i < n; i++) {
        const at = offset + 16 + i * 8;
        if (id === undefined || resource.readUInt32LE(at) === id) return resource.readUInt32LE(at + 4);
      }
      throw new Error('缺版本资源');
    };
    const type = entry(0, 16);
    if (!(type & 0x80000000)) throw new Error('PE 类型目录');
    const name = entry(type & 0x7fffffff);
    if (!(name & 0x80000000)) throw new Error('PE 名称目录');
    const language = entry(name & 0x7fffffff);
    if (language & 0x80000000 || language + 16 > resource.length) throw new Error('PE 语言目录');
    const length = resource.readUInt32LE(language + 4);
    if (length < 92 || length > 1024 * 1024) throw new Error('PE 版本长度');
    const version = await read(offsetOf(resource.readUInt32LE(language), length), length);
    if (version.readUInt16LE(0) < 92 || version.readUInt16LE(0) > length || version.readUInt16LE(2) !== 52 || version.readUInt16LE(4) !== 0 || version.toString('utf16le', 6, 38) !== 'VS_VERSION_INFO\0' || version.readUInt32LE(40) !== 0xfeef04bd) throw new Error('PE 版本格式');
    return [version.readUInt16LE(50), version.readUInt16LE(48), version.readUInt16LE(54), version.readUInt16LE(52)].join('.');
  } catch { throw new Error('更新包不是有效的 Windows 可执行文件，或缺少版本信息，没有安装。'); }
  finally { await handle.close(); }
}
