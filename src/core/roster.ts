// 选手清单：全仓库唯一的一张“选手 × 模型 × 允许强度 × 是否有快速版 × 启动模型名怎么拼”的纯数据表。
// 解析 --who、校验、启动参数、展示名、额度池、隔离模板、自检、模型核对，都从这张表派生，逻辑里不再写死任何选手。
// 以后主人在设置里改模型、强度、快速版，只需在这张表上叠一层选择，再交给下面的“底线”过滤；不用改逻辑。
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
type Spec = {
  isolation: Isolation;                       // 用哪套隔离与自检
  vendor?: Vendor;                            // 谁家出钱、谁家的登录；不写就是 isolation
  name: string; shown: string;                // 界面上的选手名、模型展示名
  icon: string; badge?: string;               // 图标与角标
  pool?: 'auto' | 'api';                      // Cursor 的额度池：auto 自家模型池，api 其他模型池
  model: string;                              // 启动用的基础模型名
  effortInName: boolean;                      // true：强度写进模型名（<模型>-<强度>，Cursor 的做法）；false：强度另外传参
  efforts: readonly Effort[];                 // 这位选手允许的强度（还要再过底线）
  fast: { model: string } | { suffix: string } | null;  // 快速版：换成另一个模型名，或在模型名末尾加后缀；null 表示没有
  noFast?: string;                            // 没有快速版时，写给人看的原因
};
const all = ['medium', 'high', 'xhigh'] as const;
export const roster = {
  codex: { isolation: 'codex', name: 'Codex', shown: 'GPT-6 Astra', icon: 'codex',
    model: 'gpt-6-astra', effortInName: false, efforts: all, fast: null, noFast: 'Codex 的快速档位还没核实官方文档，暂不开放' },
  'codex-luna': { isolation: 'codex', name: 'Codex · Luna', shown: 'GPT-6 Luna', icon: 'codex',
    model: 'gpt-6-luna', effortInName: false, efforts: all, fast: null, noFast: 'Codex 的快速档位还没核实官方文档，暂不开放' },
  grok: { isolation: 'grok', name: 'Grok', shown: 'Grok 4.7', icon: 'grok',
    model: 'grok-4.7', effortInName: false, efforts: all, fast: { model: 'grok-4.7-build-fast' } },
  'cursor-grok': { isolation: 'cursor', name: 'Cursor · Grok', shown: 'Grok 4.7', icon: 'cursor', badge: 'grok', pool: 'auto',
    model: 'grok-4.7', effortInName: true, efforts: all, fast: { suffix: '-fast' } },
  'cursor-opus': { isolation: 'cursor', name: 'Cursor · Claude', shown: 'Claude Opus 5.5', icon: 'cursor', badge: 'claude', pool: 'api',
    model: 'claude-opus-5-5', effortInName: true, efforts: all, fast: { suffix: '-fast' } },
  'cursor-sonnet': { isolation: 'cursor', name: 'Cursor · Sonnet', shown: 'Claude Sonnet 5.5', icon: 'cursor', badge: 'claude', pool: 'api',
    model: 'claude-sonnet-5-5', effortInName: true, efforts: all, fast: null, noFast: 'Cursor 里的 Sonnet 5.5 没有快速版' },
  // 借 Codex 程序跑：同一套 Codex 隔离；登录是 DeepSeek 的 API 钥匙，由 Codex 存在派活工作台单独的文件夹里（见 workers.ts）。
  deepseek: { isolation: 'codex', vendor: 'deepseek', name: 'DeepSeek', shown: 'DeepSeek V4 Pro', icon: 'deepseek',
    model: 'deepseek-v4-pro', effortInName: false, efforts: ['high'], fast: null, noFast: 'DeepSeek 没有快速版' },
  'deepseek-flash': { isolation: 'codex', vendor: 'deepseek', name: 'DeepSeek · Flash', shown: 'DeepSeek V4.1 Flash', icon: 'deepseek',
    model: 'deepseek-flash', effortInName: false, efforts: ['high'], fast: null, noFast: 'DeepSeek 没有快速版' },
} satisfies Record<string, Spec>;

// 底线：不属于设置，任何选择都要再过一遍。强度不许 max（拉满）、也不开 low；Cursor 里只用 Claude、GPT、Grok 三家的模型。
export const floor = { efforts: ['medium', 'high', 'xhigh'] as readonly string[], cursorFamilies: ['claude', 'gpt', 'grok'] as readonly string[] };

export type Who = keyof typeof roster;
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
