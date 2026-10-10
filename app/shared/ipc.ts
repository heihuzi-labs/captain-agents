import type { View } from '../../src/core/view-types.ts';
import type { WorkersPolicy } from '../../src/core/policy.ts';
import type { Appearance, Limits, Storage } from '../../src/core/settings.ts';
import type { ConnectAi, ConnectStatus } from '../../src/core/intro.ts';

// 唯一的 IPC 白名单；没有通用文件、命令或任意 IPC 入口。
export const channels = {
  cliStatus: 'xa:cli-status', cliInstall: 'xa:cli-install',
  appInfo: 'xa:app-info', onUpdate: 'xa:update', updateCheck: 'xa:update-check',
  updateDownload: 'xa:update-download', updateRestart: 'xa:update-restart', setAutoUpdateCheck: 'xa:auto-update-check',
  getView: 'xa:get-view', view: 'xa:view', open: 'xa:open',
  decide: 'xa:decide', redo: 'xa:redo', stop: 'xa:stop', comment: 'xa:comment',
  teamSay: 'xa:team-say', teamStop: 'xa:team-stop',
  chatCreate: 'xa:chat-create', chatSay: 'xa:chat-say', chatStop: 'xa:chat-stop', chatRename: 'xa:chat-rename',
  settingsGet: 'xa:settings-get', settingsSet: 'xa:settings-set',
  quotaRefresh: 'xa:quota-refresh', copyIntro: 'xa:copy-intro',
  connectStatus: 'xa:connect-status', connect: 'xa:connect', disconnect: 'xa:disconnect',
  networkAllowed: 'xa:network-allowed',
  modelsRefresh: 'xa:models-refresh', modelsKeep: 'xa:models-keep',
} as const;
export type UpdateState =
  | { phase: 'off'; reason: string }
  | { phase: 'idle'; checked: string | null }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes: string; size: number }
  | { phase: 'downloading'; version: string; received: number; size: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };
export type CliStatus = 'installed' | 'missing' | 'other' | 'unavailable';
export type AppInfo = { version: string; update: UpdateState; autoCheck: boolean };
// team：通知点开时跳到小队。只把目标交给窗口，界面怎么打开由看板那件活接。
export type Destination = { kind: 'job' | 'batch' | 'team' | 'chat'; id: string } | { kind: 'settings' };
export const defaultColumns = { running: '#2f6bd8', attention: '#64748b', done: '#2c8a55' };
export type Settings = { keepAwake: boolean; notifications: boolean; appearance: Appearance; storage: Storage; limits: Limits; columns?: Record<string, string>; openAtLogin: boolean; workers: WorkersPolicy; networkAllowed: boolean };
// archivedProjects：整份归档名单替换。界面从 View.projects[].archived 算出名单再交过来，不从设置里读这份名单。
// 联网的两项不走补丁，只能用下面专门的两个函数。
export type SettingsPatch = Partial<Omit<Settings, 'workers' | 'networkAllowed'>> & { workers?: WorkersPolicy; archivedProjects?: string[] };
export type XaBridge = {
  // 命令行（docs/design-update.md 第 3 节）：终端里的 xagents 是不是这个应用装的那一份。
  // unavailable：开发版，不提供安装；other：~/.local/bin/xagents 已经有别的（比如开发者自己链到源码目录的）。
  cliStatus(): Promise<CliStatus>;
  // 安装启动脚本；已有别的 xagents 时必须带 replace: true 才替换（界面先让人确认）。返回装完后的状态。
  cliInstall(replace: boolean): Promise<CliStatus>;
  appInfo(): Promise<AppInfo>;
  onUpdate(callback: (state: UpdateState) => void): () => void;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<void>;
  updateRestart(): Promise<void>;
  setAutoUpdateCheck(on: boolean): Promise<AppInfo>;
  decide(id: string, kind: 'adopt' | 'drop'): Promise<void>;
  redo(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  // 主人在小队频道说一句（1–500 字，规则同留言）；收场调用核心的 stopTeam。
  teamSay(id: string, text: string): Promise<void>;
  teamStop(id: string): Promise<void>;
  // 项目群聊（docs/design-team.md 第 16 节）：建群（返回群号）、以主人身份说话、停下正在动手的。
  chatCreate(options: { project: string; title?: string; members: string[] }): Promise<string>;
  chatSay(id: string, text: string): Promise<void>;
  chatStop(id: string): Promise<void>;
  // 改群名（1–100 字，不能含控制字符）。
  chatRename(id: string, title: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  // 选手联网（docs/design-network.md）：只有总开关，返回整份新设置；核心校验，不合格报中文原因。
  setNetworkAllowed(on: boolean): Promise<Settings>;
  onOpen(callback: (destination: Destination) => void): () => void;
  // 重新查一遍各家额度；不收参数。刚刷新过或正在刷新时会报错，说明原因。
  refreshQuota(): Promise<void>;
  // 把给其他 AI 的对接提示词（src/core/intro.ts 那一份）放进剪贴板；不收参数，窗口复制不了别的内容。
  copyIntro(): Promise<void>;
  // 接入 AI（docs/design-connect.md）：读各家状态；接入或撤下一家，参数只认 CONNECT_AIS 里的名字，返回各家的新状态。
  connectStatus(): Promise<ConnectStatus[]>;
  connect(ai: ConnectAi): Promise<ConnectStatus[]>;
  disconnect(ai: ConnectAi): Promise<ConnectStatus[]>;
  // 选手模型（docs/design-models.md）：重新问各家有哪些模型；这一家保留哪些模型（整份替换，只认名单里的或已有的）。
  modelsRefresh(): Promise<void>;
  modelsKeep(channel: string, models: string[]): Promise<void>;
  getView(): Promise<View>;
  onView(callback: (view: View) => void): () => void;
};
