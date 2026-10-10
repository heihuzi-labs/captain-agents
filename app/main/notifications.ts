import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isWho } from '../../src/core/roster.ts';
import type { View, ViewJob } from '../../src/core/view-types.ts';
import type { Destination } from '../shared/ipc.ts';
import { hasCode, writeJson } from '../../src/core/fsx.ts';
import { entries, reasonText } from '../shared/attention.ts';

// title 只有小队通知带：系统通知的标题用题目，其余仍用应用名。
export type Notice = { key: string; title?: string; body: string; target: Destination };
export function noticeTitle(notice: Notice) {
  return notice.title || '派活工作台';
}
const CONCLUSION = 40;

function clip(note: string | undefined) {
  return [...(note ?? '').replace(/\s+/g, ' ').trim()].slice(0, CONCLUSION).join('');
}
function whoText(view: View, job: ViewJob) {
  const worker = view.workers[job.who];
  return worker ? `${worker.name}/${worker.model}` : job.who;
}
function clause(view: View, job: ViewJob) {
  const note = clip(job.decision?.note);
  const tail = note ? `——${note}` : '';
  return job.decision?.kind === 'adopt' ? `用了 ${whoText(view, job)} 那份${tail}` : `没用${tail}`;
}
function decisionKey(job: ViewJob) {
  return `job:${job.id}:lead:${job.decision?.at ?? ''}`;
}
function decisionNotice(view: View, job: ViewJob): Notice {
  return { key: decisionKey(job), body: `${job.title}：${clause(view, job)}`, target: { kind: 'job', id: job.id } };
}
function replyNotices(view: View): Notice[] {
  const items: Notice[] = [];
  for (const j of view.jobs) {
    const who = view.workers[j.who].name;
    j.comments.forEach((c, i) => {
      if (c.by === 'lead' && j.comments[i - 1]?.by === 'owner') {
        const text = [...c.text.replace(/\s+/g, ' ')];
        items.push({ key: `job:${j.id}:reply:${c.at}`, body: `${who} · ${j.title}：负责人回复了你的留言：${text.slice(0, 30).join('')}${text.length > 30 ? '…' : ''}`, target: { kind: 'job', id: j.id } });
      }
    });
  }
  return items;
}
function teamNotices(view: View): Notice[] {
  return view.teams.filter(team => team.state === 'lead').map(team => ({
    key: `team:${team.id}:lead:${team.round}:${team.reason ?? ''}`,
    title: team.title,
    body: reasonText(team.reason),
    target: { kind: 'team' as const, id: team.id },
  }));
}
function chatNotices(view: View): Notice[] {
  return (view.chats ?? []).flatMap(chat => chat.messages
    .filter(m => m.kind === 'report' && isWho(m.from) && m.mentions.includes('owner'))
    .map(m => ({ key: `chat:${chat.id}:owner:${m.id}`, title: chat.title,
      body: `${isWho(m.from) ? view.workers[m.from]?.name ?? m.from : m.from}：${clip(m.text)}`,
      target: { kind: 'chat' as const, id: chat.id } })));
}
// 负责人新拍的板、回复主人的留言，以及小队进入“等负责人”。做完、出错、任务失联、验收没过不发。
export function notices(view: View): Notice[] {
  return [...view.jobs.filter(j => j.decision?.by === 'lead').map(j => decisionNotice(view, j)), ...replyNotices(view), ...teamNotices(view), ...chatNotices(view)];
}
type BatchMeta = { id: string; title: string; order: Map<string, number> };
function batchesOf(view: View) {
  const byJob = new Map<string, BatchMeta>();
  for (const entry of entries(view)) if (entry.target.kind === 'batch') {
    const meta = { id: entry.target.id, title: entry.title, order: new Map(entry.members.map((j, i) => [j.id, i])) };
    for (const member of entry.members) byJob.set(member.id, meta);
  }
  return byJob;
}
function isLead(notice: Notice) {
  return notice.target.kind === 'job' && notice.key.startsWith(`job:${notice.target.id}:lead:`);
}
// 同一批里这次一起出现的多条结论合成一条；已经发过的不重复带上。
export function deliver(view: View, fresh: Notice[]): Notice[] {
  const batches = batchesOf(view);
  const batchOf = (notice: Notice) => notice.target.kind === 'job' && isLead(notice) ? batches.get(notice.target.id) : undefined;
  const counts = new Map<string, number>();
  for (const notice of fresh) {
    const batch = batchOf(notice);
    if (batch) counts.set(batch.id, (counts.get(batch.id) ?? 0) + 1);
  }
  const emitted = new Set<string>();
  const out: Notice[] = [];
  for (const notice of fresh) {
    const batch = batchOf(notice);
    if (!batch || (counts.get(batch.id) ?? 0) < 2) { out.push(notice); continue; }
    if (emitted.has(batch.id)) continue;
    emitted.add(batch.id);
    const jobs = fresh.flatMap(item => {
      const target = item.target;
      if (target.kind !== 'job' || batchOf(item)?.id !== batch.id) return [];
      const job = view.jobs.find(j => j.id === target.id);
      return job ? [job] : [];
    }).sort((a, b) => (batch.order.get(a.id) ?? 0) - (batch.order.get(b.id) ?? 0));
    out.push({
      key: `batch:${batch.id}:lead:` + jobs.map(j => `${j.id}@${j.decision?.at ?? ''}`).join('+'),
      body: `${batch.title}：${jobs.map(j => clause(view, j)).join('；')}`,
      target: { kind: 'batch', id: batch.id },
    });
  }
  return out;
}
// 先持久化再发送，关闭通知时也记下事件；不会在下次打开开关或重启时补发。
export async function notificationTracker(directory: string, send: (notice: Notice) => void) {
  const file = join(directory, 'notification-events.json');
  let seen = new Set<string>(), repair = false;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some(k => typeof k !== 'string')) throw new SyntaxError('通知记录格式不对。');
    seen = new Set(parsed as string[]);
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
    repair = error instanceof SyntaxError;
  }
  let initialized = false, queue = Promise.resolve();
  return (view: View) => {
    const next = queue.then(async () => {
      const fresh = notices(view).filter(n => !seen.has(n.key));
      if (fresh.length || repair) {
        const updated = new Set([...seen, ...fresh.map(n => n.key)]);
        await mkdir(directory, { recursive: true });
        await writeJson(file, [...updated]);
        repair = false;
        seen = updated;
      }
      const shouldSend = initialized && view.settings.notifications !== false;
      initialized = true;
      if (shouldSend) deliver(view, fresh).forEach(send);
    });
    queue = next.catch(() => {});
    return next;
  };
}
