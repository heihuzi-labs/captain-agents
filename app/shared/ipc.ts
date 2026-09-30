import type { View } from '../../src/core/view-types.ts';
import type { WorkersPolicy } from '../../src/core/policy.ts';
import type { Appearance, Limits, Storage } from '../../src/core/settings.ts';
import type { ConnectAi, ConnectStatus } from '../../src/core/intro.ts';

// 唯一的 IPC 白名单；没有通用文件、命令或任意 IPC 入口。
export const channels = {
  getView: 'xa:get-view', view: 'xa:view', open: 'xa:open',
  decide: 'xa:decide', redo: 'xa:redo', stop: 'xa:stop', comment: 'xa:comment',
  settingsGet: 'xa:settings-get', settingsSet: 'xa:settings-set',
  quotaRefresh: 'xa:quota-refresh', copyIntro: 'xa:copy-intro',
  connectStatus: 'xa:connect-status', connect: 'xa:connect', disconnect: 'xa:disconnect',
} as const;
export type Destination = { kind: 'job' | 'batch'; id: string } | { kind: 'settings' };
export const defaultColumns = { running: '#2f6bd8', attention: '#64748b', done: '#2c8a55' };
export type Settings = { keepAwake: boolean; notifications: boolean; appearance: Appearance; storage: Storage; limits: Limits; columns?: Record<string, string>; openAtLogin: boolean; workers: WorkersPolicy };
// archivedProjects：整份归档名单替换。界面从 View.projects[].archived 算出名单再交过来，不从设置里读这份名单。
export type SettingsPatch = Partial<Omit<Settings, 'workers'>> & { workers?: Partial<WorkersPolicy>; archivedProjects?: string[] };
export type XaBridge = {
  decide(id: string, kind: 'adopt' | 'drop'): Promise<void>;
  redo(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  onOpen(callback: (destination: Destination) => void): () => void;
  // 重新查一遍各家额度；不收参数。刚刷新过或正在刷新时会报错，说明原因。
  refreshQuota(): Promise<void>;
  // 把给其他 AI 的对接提示词（src/core/intro.ts 那一份）放进剪贴板；不收参数，窗口复制不了别的内容。
  copyIntro(): Promise<void>;
  // 接入 AI（docs/design-connect.md）：读四家状态；接入或撤下一家，参数只认 CONNECT_AIS 里的名字，返回四家的新状态。
  connectStatus(): Promise<ConnectStatus[]>;
  connect(ai: ConnectAi): Promise<ConnectStatus[]>;
  disconnect(ai: ConnectAi): Promise<ConnectStatus[]>;
  getView(): Promise<View>;
  onView(callback: (view: View) => void): () => void;
};
