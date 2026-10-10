import { nodeCommand } from './node-runtime.ts';
import { engineEnvironment, engineSnapshot, foldRounds, killEngine, readReport, rememberSession, resumeMember, wakeGate } from './wake.ts';
export { sessionFromOutput } from './wake.ts';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stop } from './commands.ts';
import { dispatch, launch } from './dispatch.ts';
import { alive, hasCode, readOptional, writeAtomic } from './fsx.ts';
import { stamp } from './ids.ts';
import { active, readJob, reconcile, updateJob } from './job.ts';
import type { Job } from './job.ts';
import { jobDir } from './paths.ts';
import { checkChoice } from './policy.ts';
import { findProject, worktreePath } from './project.ts';
import { uncommitted } from './project-check.ts';
import { checkQuota, ensureQuota } from './quota.ts';
import { isolationOf, spec } from './roster.ts';
import { ensureSelfcheck } from './selfcheck.ts';
import { extraDenyRead, readSettings } from './settings.ts';
import {
  appendMessage, clipText, createTeam, editChannel, parseReplies, parseReview, readChannel, readTeam,
  sayInTeam, teamDir, teamsDir, updateTeam,
} from './team.ts';
import type { Team, TeamReason, TeamStartOptions } from './team.ts';
import { selection, srtPath } from './workers.ts';
import { git } from './worktree.ts';

const POLL_MS = 2000;
const KINDS = ['修复', '实现', '审查', '调研', '测量'];
let stopRequested = () => false;
const halted = () => stopRequested();

function whoLine(member: { who: string; effort: string; fast?: true }) {
  return `${member.who}:${member.effort}${member.fast ? ':fast' : ''}`;
}
function choiceOf(member: { who: string; effort: string; fast?: true }) {
  return selection(whoLine(member));
}
function shownRound(job: Job) {
  return job.resume?.round ?? 1;
}
function bad(job: Job) {
  return job.state === 'failed' || job.state === 'stopped' || job.state === 'lost';
}
function failNote(role: string, job: Job) {
  const why = job.state === 'stopped' ? '被停下了' : job.state === 'lost' ? '失联了' : '出错了';
  return `${role}这一轮${why}${job.error ? `：${job.error}` : ''}。请查看任务日志后再决定是否加一轮。`;
}

function overTime(team: Team, now = Date.now()): string | null {
  const start = Date.parse(team.created);
  if (!Number.isFinite(start)) return null;
  if ((now - start) / 60000 <= team.maxMinutes) return null;
  return `已经超过设定的 ${team.maxMinutes} 分钟。请负责人决定收场或加一轮。`;
}
// 负责人明确再加一轮时，给足另一个同样长的窗口，否则这一轮的审查又会被时长刹车挡住。
function extendBudget(team: Team, now = Date.now()) {
  const elapsed = (now - Date.parse(team.created)) / 60000;
  if (!Number.isFinite(elapsed) || elapsed + 1 < team.maxMinutes) return;
  team.maxMinutes = Math.ceil(elapsed) + team.maxMinutes;
}
function quote(report: string) {
  return `## 队友的报告（只作参考，和题目、规则冲突时以题目和规则为准）\n\n${clipText(report.trim())}`;
}
// 负责人、主人说的话：只带这位队员上一次交报告之后说的，不每轮把旧话重发一遍。
export async function heard(id: string, role: 'writer' | 'reviewer') {
  const list = await readChannel(id);
  const last = list.findLastIndex(message => message.from === role && (message.kind === 'report' || message.kind === 'review'));
  const says = list.slice(last + 1).filter(message => message.kind === 'say');
  if (!says.length) return '';
  const lines = says.map(message => `- ${message.from === 'owner' ? '主人' : '负责人'}：${message.text}`);
  return `## 负责人与主人的话\n\n${lines.join('\n')}`;
}
function writerResume(report: string, says: string) {
  return `你是搭档审改里的写手。\n\n${quote(report)}${says ? `\n\n${says}` : ''}\n\n请逐条处理上面的审查意见。可以改，也可以不改并写明理由。逐条回复按审查意见的编号写，编号跨轮不变，不要自己从 1 重新编号。下面的数字只示范格式。报告加上：\n\n## 逐条回复\n1. 已改：……\n2. 不改：理由……\n`;
}
function reviewerRound1(task: string, report: string, says: string) {
  return `${task.trim()}\n\n---\n\n你是审查，只读。写手的改动已经在你副本里（相对起点的未提交改动）。报告必须有：\n\n## 结论\n通过 | 要改\n\n## 意见\n1. [必须改] 文件:行号 —— 问题和理由\n2. [建议] …\n3. [疑问] …\n\n${quote(report)}${says ? `\n\n${says}` : ''}\n`;
}
function reviewerResume(report: string, says: string) {
  return `你是审查，只读。\n\n${quote(report)}${says ? `\n\n${says}` : ''}\n\n最新改动已同步到你的副本。请复核上一轮意见，按同样格式给新的结论和意见。编号跨轮不变：上一轮还没解决的意见照原编号再列；已经解决的不再列；新意见从目前最大编号往后接着编。\n\n## 结论\n通过 | 要改\n\n## 意见\n<原编号>. [必须改] 文件:行号 —— 上一轮没解决的，照原编号\n<新编号>. [建议] …\n<新编号>. [疑问] …\n`;
}

// 审查副本只复位、清未跟踪文件、打补丁，不执行选手写的代码。
export async function syncReviewWorktree(worktree: string, base: string, patchFile: string) {
  try {
    await git(worktree, ['reset', '--hard', base]);
    await git(worktree, ['clean', '-fd']);
  } catch (e) {
    throw new Error(`没法把审查副本复位到起点：${e instanceof Error ? e.message : e}。请确认副本还在后再试。`);
  }
  const patch = await readOptional(patchFile);
  if (!patch.trim()) return;
  try { await git(worktree, ['apply', '--whitespace=nowarn', patchFile]); }
  catch {
    await git(worktree, ['reset', '--hard', base]).catch(() => {});
    await git(worktree, ['clean', '-fd']).catch(() => {});
    throw new Error('写手的改动没法同步给审查。请查看写手的 diff.patch，修好后用 team round 再试。');
  }
}

async function load(id: string): Promise<Team> {
  try { return await readTeam(id); }
  catch (e) { if (hasCode(e, 'ENOENT')) throw new Error(`找不到小队 ${id}。请先运行 xagents team status。`); throw e; }
}

async function samePatch(job: Job, round: number) {
  if (round < 2) return false;
  const dir = jobDir(job.id);
  return await readOptional(join(dir, 'diff.patch')) === await readOptional(join(dir, `diff-r${round - 1}.patch`));
}

async function gate(team: Team, choice: ReturnType<typeof selection>, checkTime: boolean): Promise<{ reason: 'brake' | 'blocked'; note: string } | null> {
  if (checkTime) {
    const note = overTime(team);
    if (note) return { reason: 'brake', note };
  }
  return wakeGate(choice, team.project);
}

async function foldJobs(team: Team) {
  for (const id of [team.writer.job, team.reviewer.job]) {
    if (!id) continue;
    try { await updateJob(id, foldRounds); }
    catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
  }
}
async function lead(id: string, reason: TeamReason, note: string): Promise<Team> {
  const current = await readTeam(id);
  if (current.state === 'running') await foldJobs(current);
  let changed = false;
  const team = await updateTeam(id, t => {
    if (t.state !== 'running') return;
    changed = true;
    t.state = 'lead'; t.reason = reason; t.note = note; t.ended = new Date().toISOString();
  });
  if (changed) await appendMessage(id, { round: team.round, from: 'platform', kind: 'event', text: note });
  console.error(`小队 ${id} 交给负责人：${reason} ${note}`);
  return team;
}

async function fillReplies(id: string, report: string) {
  const replies = parseReplies(report);
  if (!replies.length) return;
  await editChannel(id, list => {
    const review = [...list].reverse().find(message => message.kind === 'review' && message.items?.length);
    if (!review?.items) return;
    for (const item of review.items) {
      const hit = replies.find(reply => reply.n === item.n);
      if (!hit) continue;
      item.reply = hit.reply; item.replyText = hit.text;
    }
  });
}

async function requireSession(teamId: string, job: Job, role: string): Promise<Job | undefined> {
  const saved = await rememberSession(job);
  if (saved.session) return saved;
  await lead(teamId, 'failed', `没有从${role}的输出里找到会话号，没法续接。请查看 run.log 后决定是否收场。`);
  return undefined;
}
async function dispatchReviewer(team: Team, writerReport: string) {
  const writerId = team.writer.job;
  if (!writerId) throw new Error('写手还没有任务记录，没法叫审查。请重新开队。');
  const file = join(teamDir(team.id), `review-r${team.round}.md`);
  await writeAtomic(file, reviewerRound1(team.task, writerReport, await heard(team.id, 'reviewer')));
  const jobs = await dispatch(file, {
    who: [whoLine(team.reviewer)], project: team.project, base: team.base, kind: '审查', title: team.title, summary: team.summary,
    ro: true, dirtyOk: true, team: { id: team.id, role: 'reviewer' },
  }, async (job, cli) => {
    await syncReviewWorktree(job.worktree, job.base, join(jobDir(writerId), 'diff.patch'));
    await launch(job, cli);
  });
  const job = jobs[0];
  if (!job) throw new Error('审查没有登记上。请重试。');
  await updateTeam(team.id, t => { t.reviewer.job = job.id; if (t.state === 'running') t.phase = 'review'; });
  const fresh = await readTeam(team.id);
  if (fresh.state !== 'running') return;
  if (bad(job)) {
    const note = job.error || '审查没有派出去。';
    await lead(team.id, note.includes('没法同步给审查') ? 'blocked' : 'failed', note.includes('没法同步给审查') ? note : failNote('审查', job));
    return;
  }
  await appendMessage(team.id, { round: team.round, from: 'platform', kind: 'event', text: `交给 ${spec(team.reviewer.who as Job['who']).shown} 审，第 ${team.round} 轮` });
}
async function resumeReviewer(team: Team, job: Job, writerReport: string) {
  const saved = await requireSession(team.id, job, '审查');
  if (!saved || !team.writer.job) return;
  try { await syncReviewWorktree(saved.worktree, saved.base, join(jobDir(team.writer.job), 'diff.patch')); }
  catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    await lead(team.id, note.includes('没法同步给审查') ? 'blocked' : 'failed', note.includes('没法同步给审查') ? note : `没能同步审查副本：${note}。请查看 engine.log 后再试。`);
    return;
  }
  if (halted() || (await readTeam(team.id)).state !== 'running') return;
  const launched = await resumeMember(saved, team.round, reviewerResume(writerReport, await heard(team.id, 'reviewer')));
  await updateTeam(team.id, t => { if (t.state === 'running') t.phase = 'review'; });
  if (launched) await appendMessage(team.id, { round: team.round, from: 'platform', kind: 'event', text: `叫醒 ${spec(team.reviewer.who as Job['who']).shown} 复核，第 ${team.round} 轮` });
}
async function callReviewer(team: Team, writerReport: string) {
  if (halted()) return;
  const existing = team.reviewer.job ? await readJob(team.reviewer.job).catch(e => { if (hasCode(e, 'ENOENT')) return undefined; throw e; }) : undefined;
  if (existing && shownRound(existing) === team.round) {
    await updateTeam(team.id, t => { if (t.state === 'running') t.phase = 'review'; });
    return;
  }
  const blocked = await gate(team, choiceOf(team.reviewer), true);
  if (blocked) { await lead(team.id, blocked.reason, blocked.note); return; }
  if (halted() || (await readTeam(team.id)).state !== 'running') return;
  if (!existing) await dispatchReviewer(team, writerReport);
  else await resumeReviewer(team, existing, writerReport);
}
async function ensureWriterRound(team: Team, checkTime: boolean) {
  if (halted() || !team.writer.job) {
    if (!team.writer.job) await lead(team.id, 'failed', '写手没有任务记录，没法续接。请重新开队。');
    return;
  }
  const job = await readJob(team.writer.job);
  if (active(job) || shownRound(job) >= team.round) return;
  const saved = await requireSession(team.id, job, '写手');
  if (!saved) return;
  const blocked = await gate(team, choiceOf(team.writer), checkTime);
  if (blocked) { await lead(team.id, blocked.reason, blocked.note); return; }
  if (halted() || (await readTeam(team.id)).state !== 'running') return;
  const review = [...await readChannel(team.id)].reverse().find(message => message.kind === 'review');
  const launched = await resumeMember(saved, team.round, writerResume(review?.text ?? '', await heard(team.id, 'writer')));
  if (launched) await appendMessage(team.id, { round: team.round, from: 'platform', kind: 'event', text: `第 ${team.round} 轮开始，叫醒 ${spec(team.writer.who as Job['who']).shown}` });
}
async function onWriterDone(team: Team, job: Job) {
  console.error(`写手第 ${team.round} 轮结束：${job.state}`);
  const saved = await rememberSession(job);
  const report = await readReport(saved);
  if (!(await readChannel(team.id)).some(message => message.kind === 'report' && message.from === 'writer' && message.round === team.round)) {
    if (team.round >= 2) await fillReplies(team.id, report);
    await appendMessage(team.id, { round: team.round, from: 'writer', kind: 'report', text: clipText(report) });
  }
  const fresh = await readTeam(team.id);
  if (fresh.state !== 'running') return;
  if (await samePatch(saved, fresh.round)) {
    await lead(fresh.id, 'brake', '写手这一轮没有新改动，先停下来交给负责人。要继续请用 team round 加一轮。');
    return;
  }
  await callReviewer(fresh, report);
}
async function onReviewerDone(team: Team, job: Job) {
  console.error(`审查第 ${team.round} 轮结束：${job.state}`);
  const saved = await rememberSession(job);
  const report = await readReport(saved);
  const parsed = parseReview(report);
  if (!(await readChannel(team.id)).some(message => message.kind === 'review' && message.round === team.round)) {
    await appendMessage(team.id, { round: team.round, from: 'reviewer', kind: 'review', text: clipText(report), verdict: parsed.verdict, items: parsed.items });
  }
  const fresh = await readTeam(team.id);
  if (fresh.state !== 'running') return;
  if (parsed.verdict === 'pass') { await lead(fresh.id, 'passed', '审查通过，交给负责人验收。'); return; }
  if (parsed.verdict === 'unclear') { await lead(fresh.id, 'unclear', '审查报告里找不到「通过」或「要改」。请负责人看过报告后再定。'); return; }
  if (fresh.round >= fresh.maxRounds) { await lead(fresh.id, 'disagree', `已经到了第 ${fresh.round} 轮上限，还要改，交给负责人定。`); return; }
  const blocked = await gate(fresh, choiceOf(fresh.writer), true);
  if (blocked) { await lead(fresh.id, blocked.reason, blocked.note); return; }
  if (halted()) return;
  await updateTeam(fresh.id, t => {
    if (t.state !== 'running' || t.round !== fresh.round) return;
    t.round += 1; t.phase = 'write';
  });
  const next = await readTeam(fresh.id);
  if (next.state !== 'running' || next.round === fresh.round) return;
  await ensureWriterRound(next, false);
}
async function step(team: Team) {
  if (halted() || team.state !== 'running') return;
  if (team.phase === 'write') {
    if (!team.writer.job) { await lead(team.id, 'failed', '写手没有派出去。请重新开队。'); return; }
    const job = await reconcile(await readJob(team.writer.job));
    if (shownRound(job) < team.round) { if (!active(job)) await ensureWriterRound(team, true); return; }
    if (active(job)) return;
    if (bad(job)) { await lead(team.id, 'failed', failNote('写手', job)); return; }
    await onWriterDone(team, job);
    return;
  }
  if (!team.reviewer.job) return;
  const job = await reconcile(await readJob(team.reviewer.job));
  if (shownRound(job) < team.round || active(job)) return;
  if (bad(job)) { await lead(team.id, 'failed', failNote('审查', job)); return; }
  await onReviewerDone(team, job);
}

export async function launchEngine(id: string) {
  const entry = await engineSnapshot(teamDir(id), 'team-entry.ts');
  const fd = await open(join(teamDir(id), 'engine.log'), 'a', 0o600);
  try {
    await updateTeam(id, async current => {
      if (current.state !== 'running' || alive(current.pid)) return;
      const node = nodeCommand([entry, id], engineEnvironment());
      const child = spawn(node.file, node.args, { detached: true, stdio: ['ignore', fd.fd, fd.fd], env: node.env });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      current.pid = child.pid;
      child.unref();
    });
  } finally { await fd.close(); }
}
export async function runTeam(id: string) {
  const ac = new AbortController();
  let stopping = false;
  const onStop = () => { stopping = true; ac.abort(); };
  stopRequested = () => stopping;
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  try {
    const team = await load(id);
    if (team.state !== 'running') return;
    if (team.pid && team.pid !== process.pid && alive(team.pid)) { console.error('推进进程已经在跑，这个进程退出。'); return; }
    await updateTeam(id, t => { if (t.state === 'running') t.pid = process.pid; });
    while (!stopping) {
      const current = await readTeam(id);
      if (current.state !== 'running') return;
      await step(current);
      if ((await readTeam(id)).state !== 'running' || stopping) return;
      try { await sleep(POLL_MS, undefined, { signal: ac.signal }); } catch { return; }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`推进进程出错：${message}`);
    try { if ((await readTeam(id)).state === 'running') await lead(id, 'failed', `推进进程出错：${message}。请查看 engine.log 后再决定是否加一轮。`); }
    catch { /* 登记已经写不进去，只能退出 */ }
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', onStop); process.off('SIGINT', onStop);
  }
}

function checkSummary(summary: string) {
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('请用 --summary 写一两句给主人看的‘要做什么’，用大白话，不写文件名和技术细节。');
  if ([...summary].length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(summary)) throw new Error('--summary 请写 1–200 字，不能含控制字符。');
}
function bounded(value: number | undefined, fallback: number, min: number, max: number, label: string) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(label);
  return value;
}
async function reserveTeam(now = new Date()) {
  await mkdir(teamsDir(), { recursive: true });
  const prefix = `${stamp(now)}-pair`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? prefix : `${prefix}-${n}`;
    try { await mkdir(teamDir(id)); return id; } catch (e) { if (!hasCode(e, 'EEXIST')) throw e; }
  }
}

export async function startTeam(file: string, options: TeamStartOptions): Promise<Team> {
  checkSummary(options.summary);
  const maxRounds = bounded(options.rounds, 3, 1, 5, '轮数请填 1–5 的整数。');
  const maxMinutes = bounded(options.minutes, 60, 10, 240, '时长请填 10–240 的整数（分钟）。');
  const kind = options.kind || '实现';
  if (!KINDS.includes(kind)) throw new Error('--kind 只允许修复、实现、审查、调研、测量，请修改后重试。');
  const { workers, archivedProjects, limits, networkAllowed } = await readSettings();
  const writer = selection(options.writer), reviewer = selection(options.reviewer);
  if (isolationOf(writer.who) === 'cursor' || isolationOf(reviewer.who) === 'cursor') throw new Error('Cursor 还没实测续接，暂时不能当搭档。请改用 Grok、Codex 或 DeepSeek。');
  if (writer.model === reviewer.model) throw new Error('写手和审查必须是不同的模型，否则容易犯同一种错。请换一位写手或审查。');
  checkChoice(workers, writer); checkChoice(workers, reviewer);
  const project = { ...await findProject(options.project), denyReadHome: await extraDenyRead() };
  if (archivedProjects.includes(project.name)) throw new Error(`项目 ${project.name} 已归档。要派活先取消归档：xagents project unarchive ${project.name}`);
  await worktreePath(project, 'check');
  const dirty = await uncommitted(project);
  if (dirty.length && !options.dirtyOk) {
    const shown = dirty.slice(0, 5).join('、') + (dirty.length > 5 ? ` 等 ${dirty.length} 个` : '');
    throw new Error(`主目录有 ${dirty.length} 个文件没提交（${shown}），选手的副本看不到这些改动。先把要给选手的东西提交（比如骨架和共同约定，提交到分支并用 --base 指向它）；确认这些改动和这件活无关，再加 --dirty-ok 派活。`);
  }
  const base = (await git(project.repo, ['rev-parse', '--verify', '--end-of-options', `${options.base || 'main'}^{commit}`])).trim();
  let task: string;
  try { task = (await readFile(resolve(file), 'utf8')).trim(); }
  catch (e) { if (hasCode(e, 'ENOENT')) throw new Error(`找不到题目文件 ${file}。请确认路径后重试。`); throw e; }
  if (!task) throw new Error('题目是空的。请写上要做的事再开队。');
  checkQuota(await ensureQuota(), [writer, reviewer], options.force, limits.quotaStop);
  if ([writer, reviewer].some(choice => isolationOf(choice.who) !== 'codex') && !process.env.XAGENTS_FAKE_WORKER) await srtPath();
  if (!process.env.XAGENTS_FAKE_WORKER) await ensureSelfcheck();
  const id = await reserveTeam();
  const title = options.title || basename(file, extname(file));
  const team: Team = {
    id, mode: 'pair', project: project.name, repo: project.repo, base, kind, title, summary: options.summary.trim(), task,
    writer: { who: writer.who, effort: writer.effort, ...(writer.fast ? { fast: true } : {}) },
    reviewer: { who: reviewer.who, effort: reviewer.effort, ...(reviewer.fast ? { fast: true } : {}) },
    round: 1, phase: 'write', maxRounds, maxMinutes, state: 'running', created: new Date().toISOString(),
    ...(options.real ? { real: options.real } : {}), ...(networkAllowed ? { network: true as const } : {}),
  };
  await createTeam(team);
  await appendMessage(id, { round: 1, from: 'platform', kind: 'event', text: `开队：${spec(writer.who).shown} 写，${spec(reviewer.who).shown} 审，最多 ${maxRounds} 轮` });
  const writerFile = join(teamDir(id), 'writer-round1.md');
  await writeAtomic(writerFile, `${task}\n\n---\n\n你是搭档审改里的写手，做完会由另一位审查。报告照共同规则写。\n`);
  try {
    const jobs = await dispatch(writerFile, {
      who: [whoLine(team.writer)], project: team.project, base, kind, title, summary: options.summary,
      force: options.force, dirtyOk: options.dirtyOk, real: options.real, team: { id, role: 'writer' },
    });
    const job = jobs[0];
    if (!job) throw new Error('写手没有登记上。请重试开队。');
    await updateTeam(id, t => { t.writer.job = job.id; });
    if (bad(job)) { await lead(id, 'failed', failNote('写手', job)); return readTeam(id); }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try { await lead(id, 'failed', `开队没能派写手：${message}`); } catch { /* 登记失败就把原因抛回去 */ }
    return readTeam(id);
  }
  await launchEngine(id);
  return readTeam(id);
}
export async function continueTeam(id: string, note?: string): Promise<Team> {
  const team = await load(id);
  if (team.state !== 'lead') throw new Error(team.state === 'ended' ? '这支小队已经收场了，不能再加一轮。要重做请重新开队。' : '小队还在推进，等它停下后再加一轮。');
  const blocked = await gate(team, choiceOf(team.writer), false);
  if (blocked) return updateTeam(id, t => { if (t.state !== 'lead') return; t.reason = 'blocked'; t.note = blocked.note; });
  await updateTeam(id, t => {
    if (t.state !== 'lead') return;
    t.round += 1; t.maxRounds = Math.max(t.maxRounds, t.round); t.phase = 'write'; t.state = 'running';
    delete t.reason; delete t.ended; delete t.note; extendBudget(t);
  });
  if (note !== undefined) await sayInTeam(id, note, 'lead');
  const fresh = await readTeam(id);
  if (fresh.state !== 'running') return fresh;
  try { await ensureWriterRound(fresh, false); }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if ((await readTeam(id)).state === 'running') await lead(id, 'failed', `没能叫醒写手：${message}。请查看 engine.log 后再试。`);
    return readTeam(id);
  }
  if ((await readTeam(id)).state === 'running') await launchEngine(id);
  return readTeam(id);
}
export async function stopTeam(id: string): Promise<Team> {
  const team = await load(id);
  if (team.state === 'ended') return team;
  await killEngine(team.pid);
  for (const jobId of [team.writer.job, team.reviewer.job]) {
    if (!jobId) continue;
    try {
      const job = await readJob(jobId);
      if (active(job) || job.state === 'lost' || alive(job.pid) || alive(job.workerPid) || alive(job.setupPid)) await stop(jobId);
    } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
  }
  await foldJobs(await readTeam(id));
  return updateTeam(id, t => {
    t.state = 'ended'; t.ended = new Date().toISOString();
    if (!t.note) t.note = '负责人收场了。';
  });
}
export async function reconcileTeam(team: Team): Promise<Team> {
  if (team.state !== 'running' || !Number.isInteger(team.pid) || team.pid! <= 0 || alive(team.pid)) return team;
  let changed = false;
  const next = await updateTeam(team.id, current => {
    if (current.state !== 'running' || alive(current.pid)) return;
    changed = true;
    current.state = 'lead'; current.reason = 'lost';
    current.note = '推进小队的后台进程不在了。请查看 engine.log，确认没有残留选手后再加一轮或收场。';
    current.ended = new Date().toISOString();
  });
  if (changed) await foldJobs(next);
  return next;
}
