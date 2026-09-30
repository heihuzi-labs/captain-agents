import type { View, ViewJob } from '../../src/core/view-types.ts';

export type Target = {
  kind: 'job' | 'batch';
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
};
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
export function entries(view: View): Entry[] {
  const jobs = new Map(view.jobs.map(j => [j.id, j])),
    seen = new Set<string>();
  const out: Entry[] = [];
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
    const unresolved = e.members.filter(j => !j.decision && !j.redo);
    const problems = unresolved.filter(j => j.state === 'lost' || j.state === 'failed' || !isOpen(j) && j.check?.ok === false);
    for (const j of problems) attention.push({
      ...single(j),
      type: j.state === 'lost' ? 'lost' : j.state === 'failed' ? 'failed' : 'check'
    });
    if (e.members.some(isOpen)) continue;
    const adopted = e.members.some(j => j.decision?.kind === 'adopt');
    const choices = unresolved.filter(j => j.state === 'done' && j.check?.ok !== false);
    if (choices.length && !adopted) attention.push({
      ...e,
      type: 'decide'
    });else if (!problems.length && (adopted || !unresolved.length || e.members.every(j => j.state === 'stopped'))) done.push(e);
  }
  return { groups, attention, done };
}
