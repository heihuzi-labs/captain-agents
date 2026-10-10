import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

type PlatformProcess = { versions: { [name: string]: string | undefined }; resourcesPath?: string };
const isDirectory = (path: string) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};
// 只认 Electron 自己提供的资源目录，不接受环境变量指定平台根目录。
export function packagedPlatformRoot(runtime: PlatformProcess = process): string | undefined {
  if (!runtime.versions.electron || !runtime.resourcesPath) return;
  const root = join(runtime.resourcesPath, 'platform');
  if (isDirectory(root)) return root;
}
export function resolveToolRoot(moduleUrl = import.meta.url, runtime: PlatformProcess = process): string {
  const sourceRoot = resolve(fileURLToPath(new URL('../../', moduleUrl)));
  // 只有 asar 中的后台才切到资源平台；开发构建与正在跑的代码快照仍取自己的根目录。
  if (runtime.versions.electron && runtime.resourcesPath && sourceRoot === join(runtime.resourcesPath, 'app.asar')) {
    const root = packagedPlatformRoot(runtime);
    if (!root) throw new Error('应用缺少平台目录，请重新安装完整的派活工作台。');
    return root;
  }
  return sourceRoot;
}
export const toolRoot = resolveToolRoot();
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
