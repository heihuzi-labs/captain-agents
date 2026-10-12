import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { hasCode, withLock } from '../../src/core/fsx.ts';
import { nodeRunner } from '../../src/core/node-runtime.ts';
import { packagedPlatformRoot, toolRoot } from '../../src/core/paths.ts';
import { isWindows, samePath } from '../../src/core/platform.ts';

export type CliLauncherStatus = 'installed' | 'missing' | 'other';
// windows、binDir 只供离线测试指定；实际安装时按当前系统取。
type Installation = { home: string; executable: string; platform?: string; windows?: boolean; binDir?: string };
type LauncherFile = { path: string; content: string; shown: string; executable: boolean };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// 启动脚本放哪、写什么。
// macOS：~/.local/bin/xagents，一个 sh 脚本。
// Windows：放进用户自己的 WindowsApps 文件夹（系统默认就在搜索路径里，不用改系统设置），两个文件：
//   xagents.cmd 给 PowerShell 和命令提示符用；不带扩展名的 xagents 给 Git 的终端用（它不认 .cmd）。
export function launcherFiles({ home, executable, platform, windows = isWindows, binDir }: Installation, env: NodeJS.ProcessEnv = process.env): LauncherFile[] {
  if (!platform) return [];
  if (!windows) return [{ path: join(home, '.local/bin/xagents'), shown: '~/.local/bin/xagents', executable: true,
    content: '#!/bin/sh\n# xagents desktop CLI launcher v1\n' + `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(join(platform, 'bin/xagents'))} "$@"\n` }];
  const dir = binDir ?? win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
  const entry = win32.join(platform, 'bin', 'xagents');
  // 批处理里 % 和 " 没法可靠地转义：带这两种字符的安装位置不装，说清楚原因。
  for (const value of [executable, entry]) if (/[%"\r\n]/.test(value)) throw new Error(`应用装在带 % 或引号的位置（${value}），没法安装命令行。请把应用装到别的位置。`);
  const slash = (value: string) => value.replaceAll('\\', '/');
  return [
    { path: join(dir, 'xagents.cmd'), shown: 'xagents.cmd', executable: false,
      content: ['@echo off', 'rem xagents desktop CLI launcher v1', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"', `"${executable}" "${entry}" %*`, ''].join('\r\n') },
    { path: join(dir, 'xagents'), shown: 'xagents', executable: false,
      content: '#!/bin/sh\n# xagents desktop CLI launcher v1\n' + `ELECTRON_RUN_AS_NODE=1 exec ${quote(slash(executable))} ${quote(slash(entry))} "$@"\n` },
  ];
}

// 参数仅供后台与离线测试使用；不接收窗口传来的路径，也不从环境变量寻找应用。
export function createCliLauncher(installation: Installation) {
  const { platform } = installation, windows = installation.windows ?? isWindows;
  const files = () => launcherFiles(installation);

  async function fileStatus(file: LauncherFile): Promise<CliLauncherStatus> {
    try {
      const info = await lstat(file.path);
      // 开发者的链接（包括悬空链接）、目录和被改过的启动脚本都不能当作自己的。Windows 上没有“可执行”这个权限位，不看。
      if (!info.isFile() || (file.executable && !(info.mode & 0o111))) return 'other';
      return await readFile(file.path, 'utf8') === file.content ? 'installed' : 'other';
    } catch (error) { if (hasCode(error, 'ENOENT')) return 'missing'; throw error; }
  }
  async function cliLauncherStatus(): Promise<CliLauncherStatus> {
    if (!platform) return 'other';
    const states = await Promise.all(files().map(fileStatus));
    return states.every(s => s === 'installed') ? 'installed' : states.every(s => s === 'missing') ? 'missing' : 'other';
  }

  async function installCliLauncher({ replace = false }: { replace?: boolean } = {}): Promise<void> {
    if (!platform) throw new Error('开发版不安装命令行。请使用打包后的派活工作台。');
    const list = files(), dir = dirname(list[0].path);
    await mkdir(dir, { recursive: true });
    await withLock(join(dir, '.xagents-cli-install'), async () => {
      const check = async () => {
        const status = await cliLauncherStatus();
        if (status === 'other' && !replace) {
          const taken = (await Promise.all(list.map(async file => [file, await fileStatus(file)] as const))).filter(([, s]) => s === 'other').map(([file]) => file.shown);
          // 两个文件只装上一个的（上次装到一半）不算别人的，接着装完。
          if (taken.length) throw new Error(`${windows ? `${dir} 里的 ${taken.join('、')}` : list[0].shown} 已存在，且不是当前应用安装的启动脚本。确认替换后再使用 replace: true。`);
        }
        return status;
      };
      if (await check() === 'installed') return;
      for (const file of list) {
        if (await fileStatus(file) === 'installed') continue;
        const temporary = join(dir, `.xagents-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, file.content, { flag: 'wx', mode: 0o755 });
          await check();
          await rename(temporary, file.path);
        } finally { await rm(temporary, { force: true }); }
      }
    });
  }
  return { cliLauncherStatus, installCliLauncher };
}

function currentInstallation(): Installation {
  const platform = packagedPlatformRoot();
  const executable = nodeRunner().file;
  // 开发 Electron 也有 resourcesPath；必须同时是应用自带平台、同一个安装里的可执行程序。
  // macOS：<应用>.app/Contents/MacOS/<程序>，平台在 Contents/Resources/platform。Windows：<安装目录>\<程序>.exe，平台在 resources\platform。
  const beside = platform && (isWindows ? resolve(platform, '..', '..') : resolve(dirname(platform), '../MacOS'));
  const packaged = platform && toolRoot === platform && samePath(dirname(executable), beside as string);
  return { home: homedir(), executable, ...(packaged ? { platform } : {}) };
}

export function cliLauncherStatus(): Promise<CliLauncherStatus> {
  return createCliLauncher(currentInstallation()).cliLauncherStatus();
}
export function installCliLauncher(options: { replace?: boolean } = {}): Promise<void> {
  return createCliLauncher(currentInstallation()).installCliLauncher(options);
}
