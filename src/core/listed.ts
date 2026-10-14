// 每次现看，不缓存；只判断程序与平台，不代替登录、自检或主人设置。
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { codexPath } from './workers.ts';
import { platformIsolations } from './selfcheck.ts';
import { channelNames, isolationOf, isolations } from './roster.ts';
import type { Isolation, Who } from './roster.ts';

export type Listed = { icon: Isolation; name: string; reason: string | null }[];
export type ListedOptions = { windows?: boolean; found?: (icon: Isolation) => Promise<boolean> };
async function found(icon: Isolation): Promise<boolean> {
  if (process.env.XAGENTS_FAKE_WORKER) return true;
  if (icon === 'codex') {
    try { return (await stat(codexPath())).isFile(); } catch { return false; }
  }
  // 派活时这两家是按名字在搜索路径上找的；这里照同一条路径逐个文件夹看，不另起进程（看板数据每次刷新都要问一遍）。
  const name = icon === 'grok' ? 'grok' : 'cursor-agent';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { await access(join(dir, name), constants.X_OK); return true; } catch { /* 这个文件夹里没有，看下一个 */ }
  }
  return false;
}
export async function listedProviders(options: ListedOptions = {}): Promise<Listed> {
  // 替身不会启动真实选手，沿用派活测试不做平台隔离检查的约定；平台用例显式传 windows。
  const allowed = platformIsolations(options.windows ?? (process.env.XAGENTS_FAKE_WORKER ? false : undefined));
  return Promise.all(isolations.map(async icon => ({ icon, name: channelNames[icon],
    reason: !allowed.includes(icon) ? `${channelNames[icon]} 在 Windows 版上暂时不能派`
      : await (options.found ?? found)(icon) ? null : `这台电脑上没找到 ${channelNames[icon]}` })));
}
export const listedWho = (listed: Listed, who: Who) => listed.some(p => p.icon === isolationOf(who) && p.reason === null);
export const unlistedProviders = (listed: Listed) => listed.flatMap(p => p.reason === null ? [] : [{ name: p.name, reason: p.reason }]);
export const unlistedLine = (listed: Listed) => unlistedProviders(listed).map(p => p.reason).join('；');
export function checkListed(listed: Listed, chosen: { who: Who }[]) {
  for (const { who } of chosen) {
    const reason = listed.find(p => p.icon === isolationOf(who))?.reason;
    if (reason) throw new Error(reason);
  }
}
