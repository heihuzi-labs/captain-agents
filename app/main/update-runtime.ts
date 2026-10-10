import { join } from 'node:path';
import { homedir } from 'node:os';
import { cleanPartialDownloads, updateClient } from './update-download.ts';
import { installationTarget, launchUpdateInstaller, prepareUpdate, verifyUpdateApp } from './update-install.ts';
import type { UpdateFiles } from './update-install.ts';
import { updatePublicKey } from './update-feed.ts';
import { createUpdater } from './updater.ts';
import { readAutoUpdateCheck, setAutoUpdateCheck } from '../../src/core/settings.ts';
import type { UpdateState } from '../shared/ipc.ts';

export function updateOffReason(config: { development: boolean; packaged: boolean; feed: string; publicKey: string; platform: string }): string | undefined {
  if (config.development || !config.packaged || !config.feed || !config.publicKey) return '这个版本不带在线更新';
  if (config.platform !== 'darwin') return '这个平台暂不支持在线更新';
  return undefined;
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
  // 缺地址、公钥、开发版、非 macOS 均不创建取数器。配置错误也保持应用可用。
  let configurationError: Error | undefined;
  if (!reason) try { updatePublicKey(config.publicKey); client = updateClient(config); }
  catch { configurationError = new Error('这个版本的更新配置不正确，请手动安装。'); }
  const directory = join(config.userData, 'updates');
  if (!reason) await cleanPartialDownloads(directory).catch(() => {});
  return createUpdater({
    ...config, offReason: reason, autoCheck: await readAutoUpdateCheck(), saveAutoCheck: setAutoUpdateCheck,
    fetchFeed: async () => { if (!client) throw configurationError; return client.feed(); },
    download: async (pkg, progress) => {
      if (!client) throw configurationError;
      return client.download(pkg, directory, progress);
    },
    prepare: (zip, version) => prepareUpdate(zip, directory, version, undefined, config.files),
    restart: async (staged, version) => {
      const target = await installationTarget(config.executable, config.packaged, config.platform);
      if (!target.path || target.path !== installed) throw new Error(target.reason ?? '应用安装位置已改变，请重新打开后再试。');
      await verifyUpdateApp(staged, version);
      await launchUpdateInstaller({ directory, installed: target.path, staged, trash: join(homedir(), '.Trash'), pid: process.pid, version });
      config.quit();
    },
  });
}
