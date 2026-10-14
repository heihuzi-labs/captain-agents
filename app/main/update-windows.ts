import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { validVersion } from './update-feed.ts';
import type { UpdatePackage } from './update-feed.ts';
import { windowsExecutableVersion } from './update-exe.ts';

export const windowsPackageName = (version: string) => {
  if (!validVersion(version)) throw new Error('更新版本号不对。');
  return `captain-agents_${version}_windows-x64.exe`;
};
export type WindowsTargetFiles = Pick<typeof import('node:fs/promises'), 'lstat' | 'realpath' | 'mkdtemp' | 'rm'>;
export async function windowsInstallationTarget(executable: string, files: WindowsTargetFiles = { lstat, realpath, mkdtemp, rm }): Promise<{ path?: string; reason?: string }> {
  const normalized = win32.normalize(executable), directory = win32.dirname(normalized);
  let real = directory;
  if (!/^[a-z]:[\\/]/i.test(executable) || /["\r\n\u0000]/u.test(executable) || win32.basename(normalized).toLowerCase() !== 'captain-agents.exe' || directory === win32.parse(directory).root) return { reason: '应用没有装在正常的安装目录里，请手动安装。' };
  try {
    // 应用文件夹本身是链接就不装。上层目录里的链接、短路径名（如 RUNNER~1）不拦：装到展开后的真实位置，
    // 2026-10-14 流水线上从短路径启动时，要求“展开后和原样一字不差”把正常安装误判成了链接。
    if ((await files.lstat(directory)).isSymbolicLink()) return { reason: '应用路径含有链接，请手动安装。' };
    real = win32.normalize(await files.realpath(directory));
    // win-unpacked 没有卸载程序；安装位置允许自选，不猜用户装在哪一个盘。
    // app.asar 在应用后台用 Node 的文件函数看是“目录”（Electron 把它当虚拟目录），用不带这层处理的看是文件，两种都认。
    for (const name of ['captain-agents.exe', 'Uninstall captain-agents.exe', 'resources\\app.asar']) {
      const stat = await files.lstat(win32.join(directory, name));
      if (stat.isSymbolicLink() || !(stat.isFile() || name.endsWith('.asar') && stat.isDirectory())) return { reason: '应用没有装在正常的安装目录里，请手动安装。' };
    }
  } catch { return { reason: '应用没有装在正常的安装目录里，请手动安装。' }; }
  try {
    // Windows 上 access(W_OK) 不能可靠代表 ACL；实际创建再删除一个空目录。
    const probe = await files.mkdtemp(win32.join(directory, '.xagents-update-'));
    await files.rm(probe, { recursive: true, force: true });
    return { path: real };
  } catch { return { reason: '应用所在目录没有写权限，请手动下载安装。' }; }
}
export function checkWindowsPackage(pkg: UpdatePackage, version: string): string {
  const name = windowsPackageName(version);
  if (!pkg.urls.length || pkg.urls.some(address => decodeURIComponent(new URL(address).pathname.split('/').at(-1)!) !== name)) throw new Error('更新包的文件名或版本与清单不符，没有安装。');
  return name;
}
export async function verifyWindowsInstaller(file: string, version: string, pkg: UpdatePackage): Promise<void> {
  const name = checkWindowsPackage(pkg, version), stat = await lstat(file);
  if (basename(file) !== name || !stat.isFile() || stat.isSymbolicLink() || stat.size !== pkg.size) throw new Error('更新包的文件名或大小与清单不符，没有安装。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== pkg.sha256.toLowerCase()) throw new Error('更新包的内容和发布的不一致，没有安装。');
  if (await windowsExecutableVersion(file) !== `${version}.0`) throw new Error('更新包的版本与清单不符，没有安装。');
}
export async function prepareWindowsUpdate(file: string, version: string, pkg: UpdatePackage): Promise<string> {
  try { await verifyWindowsInstaller(file, version, pkg); return file; }
  catch (error) { await rm(file, { force: true }).catch(() => {}); throw error; }
}
export async function cleanWindowsDownloads(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!/^captain-agents_\d+\.\d+\.\d+_windows-x64\.exe$/.test(name)) continue;
    // NSIS 在打开新版窗口之后才结束；给仍被安装器占用的下载文件一点时间。
    for (let attempt = 0; ; attempt++) {
      try { await rm(join(directory, name), { force: true }); break; }
      catch (error) { if (attempt >= 29) throw error; await sleep(500, undefined, { ref: false }); }
    }
  }
}
export function windowsInstallerArguments(installed: string): string[] {
  if (!/^[a-z]:\\/i.test(installed) || /["\r\n\u0000]/u.test(installed) || win32.normalize(installed) !== installed || installed.endsWith('\\')) throw new Error('应用安装目录不正常，请手动安装。');
  // /D 必须最后、不加引号；Node 的默认 Windows 参数引用会包住含空格的整个参数，
  // 因此下面启动时用 windowsVerbatimArguments，并通过 argv0 单独引用可执行文件。
  return ['/S', '--updated', '--force-run', '/currentuser', `/D=${installed}`];
}
export async function launchWindowsInstaller(file: string, installed: string, start: typeof spawn = spawn): Promise<void> {
  const child = start(file, windowsInstallerArguments(installed), { argv0: `"${file}"`, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, cwd: win32.dirname(file) });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
