import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

export const toolRoot = fileURLToPath(new URL('../../', import.meta.url));
// Python 等外部程序不能读取 asar 虚拟文件，必须使用解包后的真实路径。
export function unpackedPath(path: string) {
  return path.replace(/(^|\/)app\.asar\//, '$1app.asar.unpacked/');
}
// 只给桌面入口调用；不启动登录 shell，也不改变原 PATH 的优先级。
export function desktopPath(current: string | undefined, home = homedir(), isDirectory = (path: string) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
}) {
  const entries = current ? current.split(':') : [];
  for (const directory of [join(home, '.local/bin'), join(home, '.grok/bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!entries.includes(directory) && isDirectory(directory)) entries.push(directory);
  }
  return entries.join(':');
}
export function paths() {
  const home = resolve(process.env.XAGENTS_HOME || join(homedir(), '.xagents'));
  return { home, jobs: join(home, 'jobs'), batches: join(home, 'batches'),
    projects: join(home, 'projects'), icons: join(home, 'icons'), cache: join(home, 'cache') };
}
export async function ensureHome() {
  // 图标目录由安装或迁移创建，不能提前建空目录挡住旧图标迁移。
  const { icons: _icons, ...directories } = paths();
  await Promise.all(Object.values(directories).map(p => mkdir(p, { recursive: true })));
}
export function safeName(name: string) {
  if (!name || name === '.' || name === '..' || !/^[\p{L}\p{N}_-]+$/u.test(name)) {
    throw new Error('名字只能包含字母、汉字、数字、下划线和连字符，请换一个名字。');
  }
  return name;
}
export const jobDir = (id: string) => join(paths().jobs, safeName(id));
