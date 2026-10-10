import { listTeams, readChannel, readTeam, reconcileTeam, sayInTeam, startTeam, continueTeam, stopTeam, teamJobIds } from '../core/team.ts';
import type { ChannelMessage, Team, TeamStartOptions } from '../core/team.ts';
import { reasonText, stateText } from '../core/team-text.ts';
import { hasCode } from '../core/fsx.ts';
import { readJob } from '../core/job.ts';
import type { Job } from '../core/job.ts';
import { localTime, table } from './format.ts';

// 频道里的文字一律当纯文字显示：去掉 ANSI 和控制字符（换行保留）。
function plain(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}
function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(0, n).join('\n');
}
const fromName = (m: ChannelMessage) => ({ platform: '平台', lead: '负责人', owner: '主人', writer: '写手', reviewer: '审查' } as const)[m.from];
// team status 给队号时：平台事件一行，报告只显示前 3 行，其余照原文。
function channelShort(m: ChannelMessage): string {
  const text = m.kind === 'event' ? m.text.split('\n')[0] : m.kind === 'report' || m.kind === 'review' ? firstLines(m.text, 3) : m.text;
  return `${fromName(m)}：${plain(text)}`;
}
function channelFull(m: ChannelMessage): string {
  return `#${m.id} 第 ${m.round} 轮 ${fromName(m)} ${localTime(m.at)}\n${plain(m.text)}`;
}
export async function tryTeam(id: string): Promise<Team | undefined> {
  try { return await readTeam(id); }
  catch (e) { if (hasCode(e, 'ENOENT')) return undefined; throw e; }
}
export async function readTeamOrThrow(id: string): Promise<Team> {
  try { return await readTeam(id); }
  catch (e) { if (hasCode(e, 'ENOENT')) throw new Error(`找不到小队 ${id}。请先运行 xagents team status。`); throw e; }
}
async function jobsOfTeam(team: Team): Promise<Job[]> {
  const out: Job[] = [];
  for (const id of teamJobIds(team)) {
    try { out.push(await readJob(id)); }
    catch (e) { if (hasCode(e, 'ENOENT')) continue; throw e; }
  }
  return out;
}
// 刹车的时长按开队到现在（或收场）的钟点时间算，和看板一致（docs/ui-spec.md 第 17 节）。
function usedMinutes(team: Team, now = Date.now()): number {
  const start = Date.parse(team.created), end = team.ended ? Date.parse(team.ended) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 60000) : 0;
}
function workerAtWork(team: Team): string {
  if (team.state !== 'running') return '—';
  return team.phase === 'write' ? `${team.writer.who}（写）` : `${team.reviewer.who}（审）`;
}
function stateColumn(team: Team): string {
  const reason = team.reason ? `：${reasonText(team.reason)}` : '';
  const note = team.note ? `（${team.note}）` : '';
  return stateText(team.state) + reason + note;
}
export async function teamStatus(id?: string) {
  const teams = id ? [await readTeamOrThrow(id)] : await listTeams();
  const rows: string[][] = [];
  let detail: { team: Team; jobs: Job[] } | undefined;
  for (const raw of teams) {
    const team = await reconcileTeam(raw);
    const jobs = await jobsOfTeam(team);
    if (id) detail = { team, jobs };
    rows.push([team.id, team.project || '—', team.title || team.summary || '—', stateColumn(team),
      `${team.round}/${team.maxRounds}`, workerAtWork(team), `${Math.max(0, Math.floor(usedMinutes(team)))}/${team.maxMinutes} 分`]);
  }
  if (!rows.length) { console.log('没有小队。'); return; }
  console.log(table(['队号', '项目', '题目', '状态', '轮次', '谁在干活', '用时'], rows));
  if (detail) {
    const { team } = detail;
    const members = [team.writer.job ? `${team.writer.job}（写）` : '', team.reviewer.job ? `${team.reviewer.job}（审）` : ''].filter(Boolean);
    console.log(`队员任务：${members.join('、') || '还没有'}`);
    const channel = (await readChannel(team.id)).slice(-5);
    if (channel.length) {
      console.log('最近频道：');
      for (const m of channel) console.log(`  ${channelShort(m)}`);
    }
  }
}
export async function teamLog(id: string, all = false) {
  await readTeamOrThrow(id);
  const channel = await readChannel(id);
  const shown = all ? channel : channel.slice(-20);
  if (!shown.length) { console.log('频道还是空的。'); return; }
  console.log(shown.map(channelFull).join('\n\n'));
}
export async function teamSay(id: string, text: string) {
  const message = await sayInTeam(id, text, 'lead');
  console.log(`已发到小队 ${id} 的频道：${message.text}`);
}
export async function teamStart(file: string, options: TeamStartOptions) {
  const team = await startTeam(file, options);
  console.log(`队号：${team.id}`);
  console.log(`写手：${team.writer.who}:${team.writer.effort}${team.writer.fast ? ':fast' : ''}`);
  console.log(`审查：${team.reviewer.who}:${team.reviewer.effort}${team.reviewer.fast ? ':fast' : ''}`);
  console.log(`用 xagents wait ${team.id} 等结果。`);
}
export async function teamRound(id: string, note?: string) {
  const team = await continueTeam(id, note);
  console.log(`小队 ${team.id} 再走一轮（第 ${team.round} 轮）。`);
}
export async function teamStop(id: string) {
  const team = await stopTeam(id);
  console.log(`小队 ${team.id} 已收场。`);
}
