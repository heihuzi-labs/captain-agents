import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

// 不解码或规范化输入：编码的斜线、点段、查询参数、其他主机一律拒绝。
export async function readIcon(url: string, home: string): Promise<Uint8Array<ArrayBuffer>> {
  const match = /^xa-icon:\/\/icons\/([A-Za-z0-9_-]+\.png)$/.exec(url);
  if (!match) throw new Error('图标地址无效');
  const root = await realpath(home);
  const icons = join(root, 'icons');
  if (!(await lstat(icons)).isDirectory() || await realpath(icons) !== icons) throw new Error('图标目录无效');
  const file = join(icons, match[1]);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024 || await realpath(file) !== file) throw new Error('图标文件无效');
    // 打开后再次核对路径与 inode，目录被替换时不能读到外部文件。
    const current = await lstat(file);
    if (current.dev !== info.dev || current.ino !== info.ino || !current.isFile()) throw new Error('图标文件已变化');
    const bytes = await handle.readFile();
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('图标不是 PNG');
    return new Uint8Array(bytes);
  } finally { await handle.close(); }
}
