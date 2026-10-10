import type { View, ViewJob, ViewTeam } from '../../src/core/view-types.ts';
import type { Who } from '../../src/core/roster.ts';

// team：一支小队（docs/design-team.md），点开是小队详情。
export type Target = {
  kind: 'job' | 'batch' | 'team' | 'chat';
  id: string;
};
export type AttentionType = 'decide' | 'failed' | 'lost' | 'check';
export type Entry = {
  target: Target;
  title: string;
  kind: string;
  started: string;
  members: ViewJob[];
  type?: AttentionType;
  at: number;
  // 只有群聊这一件有：群里被 @ 了、还在排队等动手的成员（排队记在群上，不在成员的活上；头一回被 @ 的成员这时还没有活）。
  chat?: { queued: Who[]; project: string };
};
// 群里还有人在动手或排队：这个群在“进行中”，不进验收中、已完成和历史。
export const chatBusy = (e: Entry) => !!e.chat && (e.chat.queued.length > 0 || e.members.some(isOpen));
export const isOpen = (j: ViewJob) => j.state === 'running' || j.state === 'queued';

export function single(j: ViewJob): Entry {
  return {
    target: {
      kind: 'job',
      id: j.id
    },
    title: j.title,
    kind: j.kind,
    started: j.started,
    members: [j],
    at: Date.parse(j.ended || j.started)
  };
}
// 小队的队员不单独成卡：小队在推进或停下等负责人时，由小队卡表示（看板另画）；收场后整队算一件，
// 队员按写手、审查的顺序，之后和单家活、一批一样走验收中 / 已完成 / 历史。
// 项目群聊（docs/ui-spec.md 第 14 节）：一个群算一件，成员按群里的顺序，点开是协作页那个群。这一件取自群记录：
// 群名、属于哪个项目、谁在排队都看群；members 只是群里已经有活的那几位（可能一位都还没有）。
export const CHAT_KIND = '群聊';
export function entries(view: View): Entry[] {
  const jobs = new Map(view.jobs.map(j => [j.id, j])), seen = new Set<string>();
  const out: Entry[] = [];
  for (const c of view.chats ?? []) {
    const ids = c.members.flatMap(m => m.job ? [m.job] : []);
    ids.forEach(id => seen.add(id));
    const members = ids.map(id => jobs.get(id)).filter((j): j is ViewJob => !!j);
    const queued = c.members.filter(m => m.state === 'queued').map(m => m.who);
    // 还没人干过活、也没人排队的群不出现；头一回被 @ 的成员还没有活，但已经在排队，这个群就算一件了。
    if (!members.length && !queued.length) continue;
    const opened = Date.parse(c.created);
    out.push({ target: { kind: 'chat', id: c.id }, title: c.title, kind: CHAT_KIND, started: members.map(j => j.started).sort()[0] ?? c.created,
      members, at: Math.max(opened, ...members.map(j => Date.parse(j.ended || j.started))), chat: { queued, project: c.project } });
  }
  for (const t of view.teams ?? []) {
    const ids = [t.writer, t.reviewer].filter((id): id is string => !!id);
    ids.forEach(id => seen.add(id));
    if (t.state !== 'ended') continue;
    const members = ids.map(id => jobs.get(id)).filter((j): j is ViewJob => !!j);
    if (!members.length) continue;
    out.push({ target: { kind: 'team', id: t.id }, title: t.title, kind: t.kind, started: t.started, members,
      at: Math.max(Date.parse(t.ended ?? t.started), ...members.map(j => Date.parse(j.ended || j.started))) });
  }
  for (const b of view.batches) {
    if (b.jobs.length < 2) continue;
    const members = b.jobs.map(id => jobs.get(id)).filter((j): j is ViewJob => !!j && !seen.has(j.id));
    // 只剩一家的批次，按单家活处理，不出现“一批”。
    if (members.length < 2) continue;
    members.forEach(j => seen.add(j.id));
    out.push({
      target: {
        kind: 'batch',
        id: b.id
      },
      title: b.title,
      kind: b.kind,
      started: b.started,
      members,
      at: Math.max(...members.map(j => Date.parse(j.ended || j.started)))
    });
  }
  for (const j of view.jobs) if (!seen.has(j.id)) out.push(single(j));
  return out;
}
// 看板、菜单栏和通知共用同一份分组及待主人处理判定。
export function ownerAttention(view: View) {
  const attention: (Entry & { type: AttentionType })[] = [],
    done: Entry[] = [],
    groups = entries(view);
  for (const e of groups) {
    // 群里的成员不是几选一：每一位都要拍板。（成员又干了一轮时，核心已把上一轮的结果归档，这里读到的就是这一轮的。）
    const chat = e.target.kind === 'chat';
    const unresolved = e.members.filter(j => !j.decision && !j.redo);
    const problems = unresolved.filter(j => j.state === 'lost' || j.state === 'failed' || !isOpen(j) && j.check?.ok === false);
    for (const j of problems) attention.push({
      ...single(j),
      type: j.state === 'lost' ? 'lost' : j.state === 'failed' ? 'failed' : 'check'
    });
    if (e.members.some(isOpen) || chatBusy(e)) continue;
    const adopted = !chat && e.members.some(j => j.decision?.kind === 'adopt');
    const choices = unresolved.filter(j => j.state === 'done' && j.check?.ok !== false);
    if (choices.length && !adopted) attention.push({
      ...e,
      type: 'decide'
    });else if (!problems.length && (adopted || !unresolved.length || e.members.every(j => j.state === 'stopped'))) done.push(e);
  }
  return { groups, attention, done };
}
// 小队停下时通知的正文。引擎那件活若另有同名 reasonText，合并时留一份、删掉这份。
export function reasonText(reason: ViewTeam['reason']): string {
  if (reason === 'passed') return '审查说通过了，等负责人验收';
  if (reason === 'disagree') return '还有必须改的没谈拢，等负责人裁决';
  return '小队停下了，等负责人处理';
}
