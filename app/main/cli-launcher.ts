import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hasCode, withLock } from '../../src/core/fsx.ts';
import { nodeRunner } from '../../src/core/node-runtime.ts';
import { packagedPlatformRoot, toolRoot } from '../../src/core/paths.ts';

export type CliLauncherStatus = 'installed' | 'missing' | 'other';
type Installation = { home: string; executable: string; platform?: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// 参数仅供后台与离线测试使用；不接收窗口传来的路径，也不从环境变量寻找应用。
export function createCliLauncher(installation: Installation) {
  const { home, executable, platform } = installation;
  const target = join(home, '.local/bin/xagents');
  const content = platform ? '#!/bin/sh\n# xagents desktop CLI launcher v1\n'
    + `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(join(platform, 'bin/xagents'))} "$@"\n` : '';

  async function cliLauncherStatus(): Promise<CliLauncherStatus> {
    if (!platform) return 'other';
    try {
      const info = await lstat(target);
      // 开发者的链接（包括悬空链接）、目录和被改过的启动脚本都不能当作自己的。
      if (!info.isFile() || !(info.mode & 0o111)) return 'other';
      return await readFile(target, 'utf8') === content ? 'installed' : 'other';
    } catch (error) { if (hasCode(error, 'ENOENT')) return 'missing'; throw error; }
  }

  async function installCliLauncher({ replace = false }: { replace?: boolean } = {}): Promise<void> {
    if (!platform) throw new Error('开发版不安装命令行。请使用打包后的派活工作台。');
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    await withLock(join(dir, '.xagents-cli-install'), async () => {
      const check = async () => {
        const status = await cliLauncherStatus();
        if (status === 'other' && !replace) throw new Error('~/.local/bin/xagents 已存在，且不是当前应用安装的启动脚本。确认替换后再使用 replace: true。');
        return status;
      };
      if (await check() === 'installed') return;
      const temporary = join(dir, `.xagents-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o755 });
        await check();
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
    });
  }
  return { cliLauncherStatus, installCliLauncher };
}

function currentInstallation(): Installation {
  const platform = packagedPlatformRoot();
  const executable = nodeRunner().file;
  // 开发 Electron 也有 resourcesPath；必须同时是应用自带平台、同一个 bundle 的可执行程序。
  const packaged = platform && toolRoot === platform && dirname(executable) === resolve(dirname(platform), '../MacOS');
  return { home: homedir(), executable, ...(packaged ? { platform } : {}) };
}

export function cliLauncherStatus(): Promise<CliLauncherStatus> {
  return createCliLauncher(currentInstallation()).cliLauncherStatus();
}
export function installCliLauncher(options: { replace?: boolean } = {}): Promise<void> {
  return createCliLauncher(currentInstallation()).installCliLauncher(options);
}
