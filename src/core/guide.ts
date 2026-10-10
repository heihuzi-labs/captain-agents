import { connectStatus, connectStateNames } from './connect.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolRoot } from './paths.ts';
import { hasCode } from './fsx.ts';
import { active, listJobs } from './job.ts';
import type { Job } from './job.ts';
import { whos, spec, keptWhos } from './roster.ts';
import type { Who } from './roster.ts';
import { effortNames } from './policy.ts';
import { readSettings } from './settings.ts';
import type { QuotaStop, Settings } from './settings.ts';
import { readQuotaCache } from './quota.ts';
import type { QuotaSnapshot } from './quota.ts';
import { ownerActions } from './wait.ts';
import { profiles } from './profiles.ts';
import type { Profile } from './profiles.ts';
import { verifyState } from './verify.ts';

// 手册随仓库放在 guide/commander.md；找不到时用人话说清楚放哪、怎么办。
export async function readGuide(root = toolRoot): Promise<string> {
  const file = join(root, 'guide/commander.md');
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (e) {
    if (hasCode(e, 'ENOENT')) throw new Error(`找不到指挥手册：${file}。手册随仓库放在 guide/commander.md，请确认派活工作台装得完整（重新拉取仓库或重新安装），再运行 xagents guide。`);
    throw new Error(`读不了指挥手册 ${file}：${(e as Error).message}。请检查这个文件的权限，或重新拉取仓库。`);
  }
  if (!text.trim()) throw new Error(`指挥手册是空的：${file}。请重新拉取仓库或重新安装派活工作台。`);
  return text;
}

// 给人看的时间：本地时间“10-04 01:00”（和 xagents quota 的写法一致）。
function localTime(value: string | null | undefined) {
  const d = new Date(value ?? NaN);
  if (!Number.isFinite(d.getTime())) return '未知时间';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function workersSection(workers: Settings['workers']) {
  const lines = keptWhos.map(who => {
    const w = workers[who], s = spec(who);
    return `- ${s.name}（${who}）· ${s.shown}：${w.enabled ? '开启' : '已关闭，不能派'}；强度 ${w.efforts.map(e => effortNames[e]).join('、')}；快速版 ${w.fast ? '允许' : '未开放'}`;
  });
  return ['### 主人允许的选手和强度（同 `xagents workers`）', '', ...lines, '',
    '`--who` 写法：`选手:强度[:fast]`，括号里的是选手名。以上限制由平台强制执行，`--force` 也跳不过。'].join('\n');
}

// 写法和 `xagents quota` 一致：这次没查到但有上一次的数据，照样列出并写明。
function quotaLine(entry: QuotaSnapshot['providers'][number]) {
  const bars = entry.bars.map(b => `${b.label} ${b.used === null ? '查不到' : `${b.approx ? '不到 ' : ''}${b.used}%`}，${localTime(b.reset)} 重置`).join('；');
  return `套餐 ${entry.plan ?? '未知'}；${bars}${entry.reached ? `；已触顶：${entry.reached}` : ''}${entry.onDemand ? `；按量付费 ${entry.onDemand}` : ''}（数据时间 ${localTime(entry.at)}）`;
}
async function quotaSection(quotaStop: QuotaStop) {
  const snapshot = await readQuotaCache();
  const head = ['### 各家额度（读的是缓存，不联网）', ''];
  if (!snapshot) return [...head, '还没有额度数据，先运行 `xagents quota`。'].join('\n');
  const lines = snapshot.providers.map(entry => !entry.error ? `- ${entry.name}：${quotaLine(entry)}`
    : entry.bars.some(b => b.used !== null) ? `- ${entry.name}：这次没查到（${entry.error}）；上一次的数据：${quotaLine(entry)}`
    : `- ${entry.name}：查不到（${entry.error}）`);
  return [...head, `查询时间 ${localTime(snapshot.queriedAt)}。`, ...lines, '',
    `${quotaStop === null ? '主人没有设停派线：`xagents run` 不按用量拒绝；某家额度触顶时仍会拒绝' : `某家本期额度用到 ${quotaStop}%，\`xagents run\` 会拒绝派给它`}；缓存超过 10 分钟，\`run\` 会先重新查。要最新数字，运行 \`xagents quota\`。`].join('\n');
}

const top = (tags: Map<string, number>) => [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 3).map(([tag, n]) => `${tag} ×${n}`);
function profileLine(who: Who, rows: Profile[]) {
  const name = spec(who).name, count = rows.reduce((n, r) => n + r.count, 0), rated = rows.reduce((n, r) => n + r.rated, 0);
  if (!count) return `- ${name}：还没做过活`;
  if (!rated) return `- ${name}：做过 ${count} 件，还没打分`;
  const scored = rows.filter(r => r.avgScore !== null && r.rated > 0);
  const weight = scored.reduce((n, r) => n + r.rated, 0);
  const average = weight ? scored.reduce((n, r) => n + r.avgScore! * r.rated, 0) / weight : null;
  const merge = (pick: (r: Profile) => { tag: string; n: number }[]) => {
    const tags = new Map<string, number>();
    for (const r of rows) for (const { tag, n } of pick(r)) tags.set(tag, (tags.get(tag) ?? 0) + n);
    return top(tags);
  };
  const good = merge(r => r.good), bad = merge(r => r.bad);
  return `- ${name}：做过 ${count} 件，其中 ${rated} 件打了分，平均 ${average === null ? '—' : `${average.toFixed(1)} 分`}；优点 ${good.join('、') || '暂无'}；毛病 ${bad.join('、') || '暂无'}${rated < 3 ? '（样本少，仅供参考）' : ''}`;
}
function profilesSection(jobs: Job[]) {
  const rows = profiles(jobs);
  return ['### 各家档案摘要（每位选手一行；分类型、分快速版的明细用 `xagents profiles`）', '',
    ...whos.map(who => profileLine(who, rows.filter(r => r.who === who)))].join('\n');
}

// 和 xagents inbox 同一套判定（ownerActions），一行对应 inbox 表里的一行：同一件活的多条留言算一行。
function inboxCount(jobs: Job[]) {
  return new Set(ownerActions(jobs).map(a => `${a.id}:${a.kind === 'comment' || a.kind === 'redo' ? a.kind : 'decision'}`)).size;
}
function jobsSection(jobs: Job[], maxRunning: number) {
  const live = jobs.filter(j => !j.cleaned);
  const running = jobs.filter(active).length;
  const open = live.filter(j => j.state === 'done' && !j.decision);
  const unverified = open.filter(j => verifyState(j) === 'missing').length, failed = open.filter(j => verifyState(j) === 'failed').length;
  const undecided = open.length - unverified - failed;
  return ['### 手头的活', '',
    `- 在跑或排队：${running} 件（设置里同时最多 ${maxRunning} 件，\`XAGENTS_MAX_RUNNING\` 只能临时收紧）`,
    `- 做完了、还没验收：${unverified} 件（用 \`xagents verify\`）`,
    ...(failed ? [`- 验收没过、还没处理：${failed} 件（修好重验，或 \`drop\`）`] : []),
    `- 验收过（或不用验）、还没拍板：${undecided} 件（用 \`xagents adopt\` 或 \`drop\`）`,
    `- 主人在应用里留下的、等你照办或回复的事（\`xagents inbox\`）：${inboxCount(jobs)} 条`,
    ...forgotten(live)].join('\n');
}
// 结束超过 1 小时还没拍板的活：常见于负责人在副本之外合并后忘了收尾。只列事实，不替负责人决定。
function forgotten(live: Job[], now = Date.now()) {
  const stale = live.filter(j => !active(j) && !j.decision && j.ended && now - Date.parse(j.ended) > 3600_000)
    .sort((a, b) => a.ended!.localeCompare(b.ended!));
  if (!stale.length) return [];
  const hours = (j: Job) => Math.floor((now - Date.parse(j.ended!)) / 3600_000);
  return ['', `结束超过 1 小时还没拍板的活（${stale.length} 件，可能被忘了；已在副本外合并的用 \`xagents adopt <号> --merged <提交号>\` 补记）：`,
    ...stale.slice(0, 10).map(j => `- ${j.id}（${j.project}）${j.title}：结束于 ${hours(j)} 小时前`),
    ...(stale.length > 10 ? [`- 另有 ${stale.length - 10} 件，用 \`xagents status --all\` 看`] : [])];
}

async function connectionLine() {
  try {
    const statuses = await connectStatus();
    return `接入的 AI：${statuses.map(s => `${s.name} ${s.sharedWith && s.state !== 'missing' ? '和 Claude 共用' : connectStateNames[s.state]}`).join('；')}`;
  } catch (error) { return `接入状态读不出：${error instanceof Error ? error.message : String(error)}`; }
}

// 手册末尾的“这台机器现在的情况”：只读登记处，不联网、不查额度、不改任何记录。
export async function guideAppendix(): Promise<string> {
  const jobs = await listJobs().catch(e => { if (hasCode(e, 'ENOENT')) return []; throw e; });
  const { archivedProjects, workers, limits } = await readSettings();
  return ['## 这台机器现在的情况', '', await connectionLine(), '',
    `派活限制：同时最多 ${limits.maxRunning} 件；${limits.quotaStop === null ? '额度不设停派线（主人在设置里关掉了）' : `额度用到 ${limits.quotaStop}% 停派`}（设置 → 选手与模型）`, '',
    ...(archivedProjects.length ? [`已归档项目：${archivedProjects.join('、')}。`, ''] : []),
    workersSection(workers), '', await quotaSection(limits.quotaStop), '', profilesSection(jobs), '', jobsSection(jobs, limits.maxRunning)].join('\n') + '\n';
}
