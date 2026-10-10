import { readModelsCache, viewModels } from './models.ts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, safeName } from './paths.ts';
import { interruption, listJobs } from './job.ts';
import type { Job, Batch } from './job.ts';
import { alive, readOptional, hasCode } from './fsx.ts';
import { workerDisplay as workers, keptWhos, spec, allowedEfforts, supportsFast, isWho } from './roster.ts';
import { pendingOwnerSays, readChannel, readTeam, teamsDir } from './team.ts';
import type { ChannelMessage, Team } from './team.ts';
import { checkFor, verifyState } from './verify.ts';
import { readSelfcheck } from './selfcheck.ts';
import { stats, typicalFor, typicals } from './stats.ts';
import { profiles, tagKind } from './profiles.ts';
import { awakeSeconds } from './duration.ts';
import { boardQuota, readQuotaCache } from './quota.ts';
import { readSettings } from './settings.ts';
import { slimCandidates } from './slim.ts';
import { dashboard, ranges } from './dashboard.ts';
import { listChats, readMessages, pendingForLead } from './chat.ts';
import { teamTasks } from './team-tasks.ts';
import type { View, ViewJob, ViewTeam, ViewChat } from './view-types.ts';

// 只读取登记处；不修正任务、不查远程额度、不触发自检。
export async function buildView(): Promise<View> {
  const settings = await readSettings();
  const models = viewModels(settings.models, await readModelsCache());
  const p = paths();
  const recorded = await listJobs().catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; });
  const jobs = recorded.map(job => {
    const interrupted = interruption(job);
    return interrupted ? { ...job, ...interrupted, error: interrupted.error } : job;
  });
  const typical = typicals(jobs);
  const chats = await viewChats();
  // 群成员的活：名字跟着群走（群改了名，各处显示的都是现名，不是派活那一刻抄下来的旧名）。
  // “通常多久”是按整件活统计的，群里的一轮不是一回事，不套用。
  const chatOf = new Map(chats.flatMap(chat => chat.members.flatMap(m => m.job ? [[m.job, chat] as const] : [])));
  const rows = jobs.map(job => {
    const chat = chatOf.get(job.id), row = publicJob(job, chat ? null : typicalFor(typical, job));
    return chat ? { ...row, title: chat.title, summary: `处理「${chat.title}」群里的安排` } : row;
  });
  const batches: Batch[] = [];
  const names = await readdir(p.batches).catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; });
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const raw = await readOptional(join(p.batches, name));
    if (raw.trim()) {
      let batch: Batch;
      try { batch = JSON.parse(raw) as Batch; }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (!batch || typeof batch.id !== 'string' || typeof batch.started !== 'string'
        || !Array.isArray(batch.jobs) || batch.jobs.some(id => typeof id !== 'string')) continue;
      batches.push({ ...batch, summary: batch.summary || batch.title });
    }
  }
  batches.sort((a, b) => b.started.localeCompare(a.started));
  const { columns, keepAwake, notifications, storage, limits, archivedProjects, workers: policy } = settings;
  const quota = await readQuotaCache();
  const registered = (await readdir(p.projects).catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; })).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
  const labels = new Map<string, string>();
  for (const name of registered) {
    try { const raw = await readOptional(join(p.projects, `${name}.json`)); const label = raw.trim() ? (JSON.parse(raw) as { label?: unknown }).label : undefined; if (typeof label === 'string' && label.trim()) labels.set(name, label.trim()); }
    catch { /* 坏的登记文件：显示名退回项目名 */ }
  }
  const projectNames = [...new Set([...registered, ...jobs.map(job => job.project).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const archived = new Set(archivedProjects);
  const slimmed = jobs.filter(job => job.slimmed);
  return { settings: { keepAwake, notifications, storage, limits, workers: policy },
    dashboard: ranges.flatMap(range => ['', ...projectNames].map(project => dashboard(jobs, range, project))),
    storage: { slimmedJobs: slimmed.length, freedBytes: slimmed.reduce((sum, job) => sum + job.slimmed!.bytes, 0), due: slimCandidates(jobs, storage.days).length },
    updated: new Date().toISOString(), selfcheck: await readSelfcheck(),
    roster: keptWhos.map(who => ({ who, name: spec(who).name, model: spec(who).shown, efforts: allowedEfforts(who), fastSupported: supportsFast(who) })),
    stats: stats(jobs), profiles: profiles(jobs), quota: boardQuota(quota), quotaAt: quota?.queriedAt ?? null, workers: { ...workers }, projects: projectNames.map(name => ({ name, label: labels.get(name) ?? name, archived: archived.has(name) })), jobs: rows, batches,
    teams: await viewTeams(),
    chats,
    models,
    ...(columns ? { theme: { columns } } : {}) };
}

function publicJob(job: Job, typical: number | null): ViewJob {
  const { id, batch, project, who, model, effort, kind, title, state, base } = job;
  const { rating } = job;
  return { id, batch, project: project ?? '', who, model, effort, ...(job.fast ? { fast: true as const } : {}), kind, title, state, base,
    started: job.started || job.created, ended: job.ended ?? null, seconds: awakeSeconds(job), typical,
    // 写了免验理由的（哪怕之前有一次没过的记录）照实显示“免验”，不再当“验收没过”。
    check: verifyState(job) === 'skipped' ? null : checkFor(job.verify), checkSkipped: verifyState(job) === 'skipped' ? job.verifySkip! : null, decision: job.decision ? { ...job.decision, by: job.decision.by ?? 'lead' } : null,
    summary: job.summary || job.title, redo: job.redo ?? null, sleeps: job.sleeps ?? [], comments: job.comments ?? [],
    network: job.network === true,
    realCheck: job.realCheck ? { needed: job.realCheck.needed, steps: job.realCheck.steps,
      result: job.realCheck.result ? { ok: job.realCheck.result.ok, note: job.realCheck.result.note, at: job.realCheck.result.at, shotCount: job.realCheck.result.shots.length } : null,
      skipped: job.realCheck.skipped ?? null } : null,
    rating: rating ? { ...(rating.score === undefined ? {} : { score: rating.score }), ...(rating.good ? { good: rating.good } : {}), ...(rating.improve ? { improve: rating.improve } : {}),
      ...(rating.external ? { external: rating.external } : {}), at: rating.at, tags: rating.tags.map(tag => ({ tag, kind: tagKind(tag) })) } : null,
    activity: job.activity ?? [], timing: job.timing ?? null };
}

const CHANNEL_KEEP = 200;
const LINE_KEEP = 80;
const MARKER = /[#*`]/g;

// 小队只读拼进看板。坏文件、对不上的登记、队名不合法都跳过，不拖垮整份视图（同批次）。
// 不直接用 listTeams：它读到 teams/broken.json 这类名字时，safeName 会抛错并中断整份列表。
// running 但推进进程不在时，只在视图里显示成 lead/lost，不写文件。
async function viewTeams(): Promise<ViewTeam[]> {
  const teams = await listedTeams();
  const out: ViewTeam[] = [];
  for (const team of teams) {
    try {
      const row = toViewTeam(team, await readChannel(team.id));
      if (row) out.push(row);
    } catch (error) {
      if (skipTeamRead(error)) continue;
      throw error;
    }
  }
  return out;
}
function skipTeamRead(error: unknown) {
  return hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR') || hasCode(error, 'EISDIR') || error instanceof SyntaxError;
}
async function listedTeams(): Promise<Team[]> {
  const names = await readdir(teamsDir()).catch(error => {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return [] as string[];
    throw error;
  });
  const teams: Team[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try { safeName(name); } catch { continue; }
    try {
      const team = await readTeam(name);
      if (team && team.id === name && team.mode === 'pair' && typeof team.created === 'string') teams.push(team);
    } catch (error) {
      if (skipTeamRead(error)) continue;
      throw error;
    }
  }
  return teams.sort((a, b) => b.created.localeCompare(a.created));
}
function knownReason(value: unknown): ViewTeam['reason'] {
  if (value === 'passed' || value === 'disagree' || value === 'unclear' || value === 'brake' || value === 'blocked' || value === 'failed' || value === 'lost') return value;
  return null;
}
function jobRef(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
// 第一行正文：跳过 Markdown 标题行（报告开头常是“## 结论”），不然卡片上只剩“结论”两个字。
function plainLine(text: string): string | null {
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^\s{0,3}#{1,6}\s/.test(raw)) continue;
    const plain = raw.replace(MARKER, '').trim();
    if (!plain) continue;
    return [...plain].slice(0, LINE_KEEP).join('');
  }
  return null;
}
function lastLine(messages: ChannelMessage[]): ViewTeam['lastLine'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.from !== 'writer' && message.from !== 'reviewer' && message.from !== 'lead' && message.from !== 'owner') continue;
    if (typeof message.text !== 'string') continue;
    // 审查的一轮：写结论，要改时带上第一条必须改的意见。
    const must = message.kind === 'review' && message.verdict === 'changes' ? message.items?.find(i => i.level === 'must') : undefined;
    const text = message.kind === 'review' && message.verdict === 'pass' ? '通过'
      : must ? plainLine(`要改：${must.text}`) : plainLine(message.text);
    if (!text) continue;
    return { from: message.from, text, at: typeof message.at === 'string' ? message.at : '' };
  }
  return null;
}
function toViewTeam(team: Team, channel: ChannelMessage[]): ViewTeam | null {
  const writer = team.writer, reviewer = team.reviewer;
  if (!writer || !reviewer || !isWho(writer.who) || !isWho(reviewer.who)) return null;
  if (team.state !== 'running' && team.state !== 'lead' && team.state !== 'ended') return null;
  if (team.phase !== 'write' && team.phase !== 'review') return null;
  if (typeof team.title !== 'string' || typeof team.kind !== 'string' || typeof team.created !== 'string') return null;
  if (typeof team.round !== 'number' || typeof team.maxRounds !== 'number' || typeof team.maxMinutes !== 'number') return null;
  const lost = team.state === 'running' && !alive(team.pid);
  const review = [...channel].reverse().find(message => message.kind === 'review');
  return {
    id: team.id, mode: 'pair', project: typeof team.project === 'string' ? team.project : '', title: team.title,
    summary: typeof team.summary === 'string' ? team.summary : team.title, kind: team.kind,
    state: lost ? 'lead' : team.state, reason: lost ? 'lost' : knownReason(team.reason),
    note: typeof team.note === 'string' ? team.note : null,
    round: team.round, maxRounds: team.maxRounds, phase: team.phase, maxMinutes: team.maxMinutes,
    started: team.created, ended: typeof team.ended === 'string' ? team.ended : null,
    writer: jobRef(writer.job), reviewer: jobRef(reviewer.job), writerWho: writer.who, reviewerWho: reviewer.who,
    items: review && Array.isArray(review.items) ? review.items.slice() : [],
    lastLine: lastLine(channel), channel: channel.slice(-CHANNEL_KEEP), pendingOwner: pendingOwnerSays(channel).length,
    tasks: teamTasks(team, channel),
  };
}

// 不调用 reconcileChat：看板读取不能引起登记处写入或叫醒选手。
async function viewChats(): Promise<ViewChat[]> {
  const out: ViewChat[] = [];
  for (const chat of await listChats()) {
    try {
      const messages = await readMessages(chat.id);
      out.push({ id: chat.id, project: chat.project, title: chat.title, state: chat.state, created: chat.created,
        closed: chat.closed ?? null, hopLimit: chat.hopLimit, pendingLead: pendingForLead(messages).length,
        members: chat.members.map(m => ({ who: m.who, readOnly: m.readOnly === true, job: m.job || null,
          state: chat.busy?.who === m.who ? 'working' : chat.queue.some(q => q.who === m.who) ? 'queued' : 'idle' })), messages });
    } catch (error) { if (!skipTeamRead(error)) throw error; }
  }
  return out;
}
