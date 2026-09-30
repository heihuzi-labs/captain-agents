import { vi } from 'vitest';
import { effectiveWorkers } from '../../src/core/policy.ts';
import { whos, spec, allowedEfforts, supportsFast } from '../../src/core/roster.ts';
import type { XaBridge } from '../../app/shared/ipc.ts';
import type { View, ViewJob } from '../../src/core/view-types.ts';
import type { ConnectStatus } from '../../src/core/intro.ts';
// 缺省选手设置，直接用核心算出来的，不另写一份。
const workerPolicies = effectiveWorkers(undefined);
export const fixtureView = (): View => ({
  settings: { keepAwake: true, notifications: true, storage: { slim: true, days: 14 }, limits: { maxRunning: 6, quotaStop: 80 }, workers: structuredClone(workerPolicies) },
  storage: { slimmedJobs: 0, freedBytes: 0, due: 0 },
  dashboard: [],
  roster: whos.map(who => ({ who, name: spec(who).name, model: spec(who).shown, efforts: allowedEfforts(who), fastSupported: supportsFast(who) })),
  updated: new Date().toISOString(),
  selfcheck: {
    ok: true,
    at: null,
    note: '自检通过'
  },
  quota: [],
  quotaAt: null,
  stats: [],
  profiles: [],
  workers: {
    codex: {
      name: 'Codex',
      model: '模型',
      icon: 'codex'
    },
    'codex-luna': {
      name: 'Codex · Luna',
      model: '模型',
      icon: 'codex'
    },
    grok: {
      name: 'Grok',
      model: '模型',
      icon: 'grok'
    },
    'cursor-grok': {
      name: 'Cursor',
      model: 'Grok',
      icon: 'cursor',
      badge: 'grok'
    },
    'cursor-opus': {
      name: 'Cursor',
      model: 'Opus',
      icon: 'cursor',
      badge: 'claude'
    },
    'cursor-sonnet': {
      name: 'Cursor',
      model: 'Sonnet',
      icon: 'cursor',
      badge: 'claude'
    }
  },
  projects: [],
  jobs: [],
  batches: [],
});
export const fixtureJob = (id: string, extra: Partial<ViewJob> = {}): ViewJob => ({
  id,
  summary: '给主人看的任务说明',
  redo: null,
  timing: null,
  sleeps: [],
  comments: [],
  batch: '',
  project: '默认项目',
  who: 'codex',
  model: '模型',
  effort: 'high',
  kind: '实现',
  title: id,
  state: 'done',
  base: 'base',
  started: new Date(Date.now() - 60000).toISOString(),
  ended: new Date().toISOString(),
  seconds: 60,
  typical: null,
  check: null,
  decision: null,
  realCheck: null,
  rating: null,
  activity: [],
  ...extra
});
// 接入 AI 的四家状态（界面测试用）。
export const connectFixture = (): ConnectStatus[] => [
  { ai: 'claude', name: 'Claude', state: 'on', note: '写在 ~/.claude/rules/xagents.md', files: ['~/.claude/rules/xagents.md'] },
  { ai: 'codex', name: 'Codex', state: 'off', note: '会写进 ~/.codex/AGENTS.md 末尾', files: ['~/.codex/AGENTS.md'] },
  { ai: 'grok', name: 'Grok', state: 'on', note: '和 Claude 共用一份规矩', files: ['~/.claude/rules/xagents.md'], sharedWith: 'claude' },
  { ai: 'cursor', name: 'Cursor', state: 'off', note: '会写进 ~/.cursor/rules/xagents.mdc（只对家目录下的项目生效）', files: ['~/.cursor/rules/xagents.mdc'] },
];
export const fixtureBridge = (extra: Partial<XaBridge> = {}): XaBridge => ({
  refreshQuota: vi.fn(async () => {}), copyIntro: vi.fn(async () => {}),
  connectStatus: vi.fn(async () => connectFixture()), connect: vi.fn(async () => connectFixture()), disconnect: vi.fn(async () => connectFixture()),
  decide: vi.fn(async () => {}), comment: vi.fn(async () => {}), redo: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({ keepAwake: true, notifications: true, appearance: 'system' as const, openAtLogin: false, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 6, quotaStop: 80 as const }, workers: structuredClone(workerPolicies) })),
  setSettings: vi.fn(async patch => ({ keepAwake: true, notifications: true, appearance: 'system' as const, openAtLogin: false, storage: { slim: true, days: 14 as const }, limits: { maxRunning: 6, quotaStop: 80 as const }, ...patch, workers: { ...structuredClone(workerPolicies), ...patch.workers } })),
  onOpen: () => () => {}, getView: vi.fn(async () => fixtureView()), onView: () => () => {}, ...extra,
});
