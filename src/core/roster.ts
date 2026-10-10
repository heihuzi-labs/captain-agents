// 选手清单：全仓库唯一的一张“选手 × 模型 × 允许强度 × 是否有快速版 × 启动模型名怎么拼”的纯数据表。
// 解析 --who、校验、启动参数、展示名、额度池、隔离模板、自检、模型核对，都从这张表派生，逻辑里不再写死任何选手。
// 通道接法固定，选手由内置名单和主人保留的模型装载；配置不能改变通道底线。
// 不引入任何 node 模块，界面和核心都能用。
//
// 模型名来源与核对日期：2026-09-29
// - Codex：codex debug models（gpt-6-astra）。快速档位没有核实官方文档，暂不开放。
//   2026-09-30 加 gpt-6-luna：codex-cli 0.158 自带说明“Fast and affordable model for easier tasks”，同一代里给小活用；
//   gpt-6-sol 说明是“上一代主力”，不加。
// - Grok 命令行：grok models（grok-4.7、grok-4.7-build-fast）。
//   官方 https://docs.x.ai/developers/grok-4-7 ：Grok 4.7 Fast 与 Grok 4.7 是同一个模型，跑在更快的机器上，
//   按 2 倍（长上下文 1.5 倍）计费，只在 Cursor 和 Grok Build 里有。
// - Cursor：cursor-agent 2026.09.28-64d2043 的 models：
//   claude-sonnet-5-5-{low,medium,high,xhigh,max}（没有快速版）；
//   grok-4.7-{low,medium,high,xhigh}[-fast]；claude-opus-5-5-{low,medium,high,xhigh,max}[-fast]。
// - DeepSeek（2026-10-02）：借 Codex 程序跑，DeepSeek 官方为 Codex 做了适配（api-docs.deepseek.com 的 Codex 接入页）。
//   接口 GET /models：deepseek-v4-pro（DeepSeek-V4-Pro）、deepseek-flash（DeepSeek-V4.1-Flash），强度只有 low、high、max。
//   中档、超高档接口也收，但会被换算（第三方资料：medium → high、xhigh → max），超高档等于拉满，所以只开高档。
//   没有快速版。依据 docs/research/connect-deepseek-2026-10-02.md。

export type Isolation = 'codex' | 'grok' | 'cursor';
// 谁家出钱、谁家的登录：额度、模型核对、登录检查按它分。不写就和隔离同名。
export type Vendor = Isolation | 'deepseek';
export type Effort = 'medium' | 'high' | 'xhigh';
export type Spec = {
  isolation: Isolation;                       // 用哪套隔离与自检
  vendor?: Vendor;                            // 谁家出钱、谁家的登录；不写就是 isolation
  handle: string;                             // 群聊 @ 的短名字，chat.ts 的 HANDLES 从这里派生。
  name: string; shown: string;                // 界面上的选手名、模型展示名
  icon: string; badge?: string;               // 图标与角标
  pool?: 'auto' | 'api';                      // Cursor 的额度池：auto 自家模型池，api 其他模型池
  model: string;                              // 启动用的基础模型名
  effortInName: boolean;                      // true：强度写进模型名（<模型>-<强度>，Cursor 的做法）；false：强度另外传参
  efforts: readonly Effort[];                 // 这位选手允许的强度（还要再过底线）
  fast: { model: string } | { suffix: string } | null;  // 快速版：换成另一个模型名，或在模型名末尾加后缀；null 表示没有
  noFast?: string;                            // 没有快速版时，写给人看的原因
};
export const channelTemplates: Record<Vendor, {
  name: string; isolation: Isolation; effortInName: boolean; icon: string;
  fast(model: string): Spec['fast']; decorate(model: string): Pick<Spec, 'badge' | 'pool'>;
}> = {
  codex: { name: 'Codex', isolation: 'codex', effortInName: false, icon: 'codex', fast: () => null, decorate: () => ({}) },
  grok: { name: 'Grok', isolation: 'grok', effortInName: false, icon: 'grok', fast: model => ({ model: `${model}-build-fast` }), decorate: () => ({}) },
  cursor: { name: 'Cursor', isolation: 'cursor', effortInName: true, icon: 'cursor', fast: () => ({ suffix: '-fast' }),
    decorate: model => ({ pool: model.startsWith('grok-') ? 'auto' : 'api', badge: model.startsWith('claude-') ? 'claude' : model.startsWith('grok-') ? 'grok' : 'codex' }) },
  deepseek: { name: 'DeepSeek', isolation: 'codex', effortInName: false, icon: 'deepseek', fast: () => null, decorate: () => ({}) },
};
function connection(channel: Vendor, model: string) {
  const t = channelTemplates[channel];
  return { isolation: t.isolation, effortInName: t.effortInName, icon: t.icon, ...t.decorate(model),
    ...(channel === 'deepseek' ? { vendor: channel } : {}) };
}
const all = ['medium', 'high', 'xhigh'] as const;
export const builtinRoster = {
  codex: { handle: 'Codex', ...connection('codex', 'gpt-6-astra'), name: 'Codex', shown: 'GPT-6 Astra',
    model: 'gpt-6-astra', efforts: all, fast: null, noFast: 'Codex 的快速档位还没核实官方文档，暂不开放' },
  'codex-luna': { handle: 'Luna', ...connection('codex', 'gpt-6-luna'), name: 'Codex · Luna', shown: 'GPT-6 Luna',
    model: 'gpt-6-luna', efforts: all, fast: null, noFast: 'Codex 的快速档位还没核实官方文档，暂不开放' },
  grok: { handle: 'Grok', ...connection('grok', 'grok-4.7'), name: 'Grok', shown: 'Grok 4.7',
    model: 'grok-4.7', efforts: all, fast: channelTemplates.grok.fast('grok-4.7') },
  'cursor-grok': { handle: 'CursorGrok', ...connection('cursor', 'grok-4.7'), name: 'Cursor · Grok', shown: 'Grok 4.7',
    model: 'grok-4.7', efforts: all, fast: channelTemplates.cursor.fast('') },
  'cursor-opus': { handle: 'CursorClaude', ...connection('cursor', 'claude-opus-5-5'), name: 'Cursor · Claude', shown: 'Claude Opus 5.5',
    model: 'claude-opus-5-5', efforts: all, fast: channelTemplates.cursor.fast('') },
  'cursor-sonnet': { handle: 'CursorSonnet', ...connection('cursor', 'claude-sonnet-5-5'), name: 'Cursor · Sonnet', shown: 'Claude Sonnet 5.5',
    model: 'claude-sonnet-5-5', efforts: all, fast: null, noFast: 'Cursor 里的 Sonnet 5.5 没有快速版' },
  // 借 Codex 程序跑：同一套 Codex 隔离；登录是 DeepSeek 的 API 钥匙，由 Codex 存在派活工作台单独的文件夹里（见 workers.ts）。
  deepseek: { handle: 'DeepSeek', ...connection('deepseek', 'deepseek-v4-pro'), name: 'DeepSeek', shown: 'DeepSeek V4 Pro',
    model: 'deepseek-v4-pro', efforts: ['high'], fast: null, noFast: 'DeepSeek 没有快速版' },
  'deepseek-flash': { handle: 'Flash', ...connection('deepseek', 'deepseek-flash'), name: 'DeepSeek · Flash', shown: 'DeepSeek V4.1 Flash',
    model: 'deepseek-flash', efforts: ['high'], fast: null, noFast: 'DeepSeek 没有快速版' },
} satisfies Record<string, Spec>;

// 底线：不属于设置，任何选择都要再过一遍。强度不许 max（拉满）、也不开 low；Cursor 里只用 Claude、GPT、Grok 三家的模型。
export const floor = { efforts: ['medium', 'high', 'xhigh'] as readonly string[], cursorFamilies: ['claude', 'gpt', 'grok'] as readonly string[] };

export type Who = string;
export const roster: Record<Who, Spec> = { ...builtinRoster };
export const whos = Object.keys(roster) as Who[];
export const isWho = (value: unknown): value is Who => typeof value === 'string' && Object.hasOwn(roster, value);
export const spec = (who: Who): Spec => roster[who];
export const isolations = [...new Set(whos.map(who => spec(who).isolation))] as Isolation[];
export const isolationOf = (who: Who): Isolation => spec(who).isolation;
export const vendorOf = (who: Who): Vendor => spec(who).vendor ?? spec(who).isolation;
export const vendors = [...new Set(whos.map(vendorOf))] as Vendor[];
export const allowedEfforts = (who: Who): Effort[] => spec(who).efforts.filter(e => floor.efforts.includes(e));
export const supportsFast = (who: Who) => spec(who).fast !== null;
export const fastWhos = whos.filter(supportsFast);
// 启动模型名：基础模型 + （强度写进名字的话）-强度 + 快速版的换名或加后缀。
export function launchModel(who: Who, effort: Effort, fast: boolean) {
  const s = spec(who);
  let name = fast && s.fast && 'model' in s.fast ? s.fast.model : s.model + (s.effortInName ? `-${effort}` : '');
  if (fast && s.fast && 'suffix' in s.fast) name += s.fast.suffix;
  const family = name.split('-')[0];
  if (s.isolation === 'cursor' && !floor.cursorFamilies.includes(family)) throw new Error(`Cursor 里只允许 ${floor.cursorFamilies.join('、')} 的模型，${name} 不在其中。`);
  return name;
}
// 界面用的展示表：名字、模型展示名、图标、角标。
export const workerDisplay = Object.fromEntries(whos.map(who => {
  const { name, shown, icon, badge } = spec(who);
  return [who, { name, model: shown, icon, ...(badge ? { badge } : {}) }];
})) as Record<Who, { name: string; model: string; icon: string; badge?: string }>;
// 每种选手、强度、快速版对应的启动模型，供模型核对用；同一选手同一模型只留一条。
export function launchModels() {
  const out: { who: Who; model: string }[] = [];
  for (const who of whos) for (const fast of supportsFast(who) ? [false, true] : [false]) for (const effort of allowedEfforts(who)) {
    const model = launchModel(who, effort, fast);
    if (!out.some(o => o.who === who && o.model === model)) out.push({ who, model });
  }
  return out;
}

export type DiscoveredModel = { model: string; shown: string; description?: string; efforts: Effort[]; fast: boolean };
export type ExtraModel = Omit<DiscoveredModel, 'fast'> & { channel: Vendor; fast?: Exclude<Spec['fast'], null>; added: string };
export type ModelsConfig = { extra: Record<Who, ExtraModel>; dropped: Who[]; seen: Partial<Record<Vendor, string[]>> };
export type ModelsCache = { at: string; channels: Partial<Record<Isolation, { at: string; error?: string; models: DiscoveredModel[] }>> };
export const channelNames = Object.fromEntries(Object.entries(channelTemplates).map(([channel, template]) => [channel, template.name])) as Record<Vendor, string>;
export const isChannel = (value: unknown): value is Vendor => typeof value === 'string' && Object.hasOwn(channelNames, value);
export const isModelName = (value: unknown): value is string => typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(value);
export const builtinWhos: readonly Who[] = Object.keys(builtinRoster);
export const isBuiltin = (who: Who) => Object.hasOwn(builtinRoster, who);
// 这些对象原地装载，导入者无需重新取引用；历史名单始终包含取消保留的选手。
export const keptWhos: Who[] = [...whos];
export const workerHandles: Record<Who, string> = Object.fromEntries(whos.map(who => [who, spec(who).handle]));
const dropped = new Set<Who>();
let catalog: ModelsCache | null = null;
export const isKept = (who: Who) => isWho(who) && !dropped.has(who);
export const setModelsCatalog = (value: ModelsCache | null) => { catalog = value; };
export function modelGone(who: Who, cache = catalog): boolean {
  const channel = vendorOf(who);
  if (channel === 'deepseek') return false;
  const latest = cache?.channels[channel];
  return !!latest && latest.error === undefined && !latest.models.some(m => m.model === spec(who).model);
}

// 模型数据只能选用通道已有的接法，不允许配置提供隔离、额度池或任意启动后缀。

export function specFor(channel: Vendor, discovered: DiscoveredModel): Spec & { who: Who } {
  if (!isChannel(channel) || !isModelName(discovered.model)) throw new Error('模型名或通道不合法。');
  const builtin = builtinWhos.find(w => {
    const s = builtinRoster[w as keyof typeof builtinRoster];
    return ((s.vendor ?? s.isolation) === channel) && s.model === discovered.model;
  });
  if (builtin) return { ...builtinRoster[builtin as keyof typeof builtinRoster], who: builtin };
  if (channel === 'deepseek') throw new Error('DeepSeek 只能在内置两位里选。');
  if (channel === 'cursor' && !floor.cursorFamilies.some(f => discovered.model.startsWith(`${f}-`))) throw new Error('Cursor 只收 Claude、GPT、Grok 的模型。');
  if (channel === 'grok' && (!discovered.model.startsWith('grok-') || /-(?:build-fast|fast)$/.test(discovered.model))) throw new Error('Grok 只能选择基础模型。');
  const efforts = all.filter(e => discovered.efforts.includes(e));
  if (!efforts.length) throw new Error('模型没有允许的推理强度。');
  const short = (channel === 'codex' ? discovered.model.replace(/^gpt-/i, '') : discovered.model)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const template = channelTemplates[channel];
  const shown = discovered.shown.trim() || discovered.model;
  const fast = discovered.fast ? template.fast(discovered.model) : null;
  return { who: `${channel}-${short}`, isolation: template.isolation, name: `${channelNames[channel]} · ${shown}`, shown,
    icon: template.icon, ...template.decorate(discovered.model), handle: shown.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '') || 'Model',
    model: discovered.model, effortInName: template.effortInName, efforts, fast,
    ...(!fast ? { noFast: channel === 'codex' ? builtinRoster.codex.noFast : '这款模型的名单里没有快速版' } : {}) };
}
export function loadRoster(extra: ModelsConfig['extra'] = {}, removed: readonly Who[] = []): void {
  const next: Record<Who, Spec> = { ...builtinRoster };
  for (const [who, model] of Object.entries(extra)) {
    const { who: expected, ...s } = specFor(model.channel, { ...model, fast: !!model.fast });
    if (who !== expected || Object.hasOwn(next, who)) throw new Error(`模型选手号冲突：${who}。`);
    next[who] = s;
  }
  for (const key of Object.keys(roster)) delete roster[key];
  Object.assign(roster, next);
  whos.splice(0, whos.length, ...Object.keys(next));
  dropped.clear(); for (const who of removed) if (isWho(who)) dropped.add(who);
  keptWhos.splice(0, keptWhos.length, ...whos.filter(isKept));
  fastWhos.splice(0, fastWhos.length, ...whos.filter(supportsFast));
  for (const key of Object.keys(workerDisplay)) delete workerDisplay[key];
  for (const who of whos) {
    const { name, shown, icon, badge } = spec(who);
    workerDisplay[who] = { name, model: shown, icon, ...(badge ? { badge } : {}) };
  }
  loadWorkerHandles(workerDisplay);
  for (const who of whos) roster[who] = { ...roster[who], handle: workerHandles[who] };
}

// 界面收到 View.workers 后也调用它；同一份纯函数可同步页面里的 HANDLES，无需读取配置。
export function loadWorkerHandles(workers: Record<Who, { model: string }>): void {
  const used = new Set(['负责人', '主人', '所有人']);
  const next: Record<Who, string> = {};
  for (const who of builtinWhos) {
    const handle = builtinRoster[who as keyof typeof builtinRoster].handle;
    next[who] = handle; used.add(handle.toLowerCase());
  }
  for (const [who, worker] of Object.entries(workers)) {
    if (isBuiltin(who)) continue;
    const base = worker.model.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '') || 'Model';
    let handle = base;
    for (let n = 2; used.has(handle.toLowerCase()); n++) handle = `${base}${n}`;
    next[who] = handle; used.add(handle.toLowerCase());
  }
  for (const key of Object.keys(workerHandles)) delete workerHandles[key];
  Object.assign(workerHandles, next);
}
