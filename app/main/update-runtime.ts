import { join } from 'node:path';
import { homedir } from 'node:os';
import { cleanPartialDownloads, updateClient } from './update-download.ts';
import { installationTarget, launchUpdateInstaller, prepareUpdate, verifyUpdateApp } from './update-install.ts';
import type { UpdateFiles } from './update-install.ts';
import { updatePublicKey } from './update-feed.ts';
import type { UpdatePackage } from './update-feed.ts';
import { checkWindowsPackage, cleanWindowsDownloads, launchWindowsInstaller, prepareWindowsUpdate, verifyWindowsInstaller } from './update-windows.ts';
import { samePath } from '../../src/core/platform.ts';
import { createUpdater } from './updater.ts';
import { readAutoUpdateCheck, setAutoUpdateCheck } from '../../src/core/settings.ts';
import { active, listJobs } from '../../src/core/job.ts';
import { listChats } from '../../src/core/chat.ts';
import { listTeams } from '../../src/core/team.ts';
import type { UpdateState } from '../shared/ipc.ts';

export function updateOffReason(config: { development: boolean; packaged: boolean; feed: string; publicKey: string; platform: string }): string | undefined {
  if (config.development || !config.packaged || !config.feed || !config.publicKey) return '这个版本不带在线更新';
  if (!['darwin', 'win32'].includes(config.platform)) return '这个平台暂不支持在线更新';
  return undefined;
}
// Windows 上平台的后台进程（每件活的看管进程、群和小队的推进进程）用的是应用自己的程序文件，文件在用时安装程序换不了；
// 装到一半等不到它们退出，安装程序只能放弃。所以点“重启以完成更新”时先看一眼，有活在跑就照实说，不关应用。
export async function windowsUpdateBlocker(): Promise<string | undefined> {
  // 从没派过活的电脑上连登记处的文件夹都还没有，当作没有在跑的。
  const none = <T>(list: Promise<T[]>) => list.catch((e: NodeJS.ErrnoException) => { if (e?.code === 'ENOENT') return [] as T[]; throw e; });
  const jobs = (await none(listJobs(true))).filter(active).length;
  const chats = (await none(listChats())).filter(c => c.state === 'open' && (c.busy || c.queue.length)).length;
  const teams = (await none(listTeams())).filter(t => t.state === 'running').length;
  const parts = [jobs && `${jobs} 件活`, chats && `${chats} 个群`, teams && `${teams} 支小队`].filter(Boolean);
  return parts.length ? `还有 ${parts.join('、')}在跑。Windows 上它们用着应用的程序文件，等做完再更新。` : undefined;
}
export async function desktopUpdater(config: {
  development: boolean; packaged: boolean; feed: string; publicKey: string; hosts: string[];
  version: string; platform: string; arch: string; executable: string; userData: string;
  publish(state: UpdateState): void; quit(): void;
  files?: UpdateFiles;   // 应用后台传 Electron 的 original-fs（见 update-install.ts 的说明）
}) {
  let reason = updateOffReason(config), installed: string | undefined;
  let client: ReturnType<typeof updateClient> | undefined;
  if (!reason) {
    const target = await installationTarget(config.executable, config.packaged, config.platform);
    reason = target.reason; installed = target.path;
  }
  // 缺地址、公钥、开发版、不支持的平台均不创建取数器。配置错误也保持应用可用。
  let configurationError: Error | undefined;
  if (!reason) try { updatePublicKey(config.publicKey); client = updateClient(config); }
  catch { configurationError = new Error('这个版本的更新配置不正确，请手动安装。'); }
  const directory = join(config.userData, 'updates');
  if (!reason) await cleanPartialDownloads(directory).catch(() => {});
  if (!reason && config.platform === 'win32') await cleanWindowsDownloads(directory).catch(() => {});
  let windowsPackage: UpdatePackage | undefined;
  return createUpdater({
    ...config, offReason: reason, autoCheck: await readAutoUpdateCheck(), saveAutoCheck: setAutoUpdateCheck,
    ...(config.platform === 'win32' ? { blocker: windowsUpdateBlocker } : {}),
    fetchFeed: async verify => { if (!client) throw configurationError; return client.feed(verify); },
    download: async (pkg, progress, version) => {
      if (!client) throw configurationError;
      if (config.platform === 'win32') {
        const name = checkWindowsPackage(pkg, version);
        const file = await client.download(pkg, directory, progress, name);
        windowsPackage = pkg;
        return file;
      }
      return client.download(pkg, directory, progress);
    },
    prepare: (file, version) => config.platform === 'win32' ? prepareWindowsUpdate(file, version, windowsPackage!) : prepareUpdate(file, directory, version, undefined, config.files),
    restart: async (staged, version) => {
      const target = await installationTarget(config.executable, config.packaged, config.platform);
      if (!target.path || !samePath(target.path, installed!)) throw new Error(target.reason ?? '应用安装位置已改变，请重新打开后再试。');
      if (config.platform === 'win32') {
        await verifyWindowsInstaller(staged, version, windowsPackage!);
        await launchWindowsInstaller(staged, target.path);
        config.quit();
        return;
      }
      await verifyUpdateApp(staged, version);
      await launchUpdateInstaller({ directory, installed: target.path, staged, trash: join(homedir(), '.Trash'), pid: process.pid, version });
      config.quit();
    },
  });
}
