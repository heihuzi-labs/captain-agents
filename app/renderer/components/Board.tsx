import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ViewJob } from '../../../src/core/view-types.ts';
import type { defaultColumns } from '../../shared/ipc.ts';
import type { Entry, Target } from '../lib/board.ts';
import { awaitingReply, awakeSince, fmtAgo, fmtDur, human, secondsSince } from '../lib/board.ts';
import { sleptSeconds } from '../../../src/core/duration.ts';
import { subscribeTick } from '../lib/ticker.ts';
import { dimmed, NO_PROJECT, outcomeOf, projectGroups, readExpanded, rememberExpanded } from '../lib/history.ts';
import { BatchGroup, Card, Chip, cssVars, Elapsed, MemberRow, MoreMenu, WorkerIdentity, WorkerRow } from '../ui/index.ts';
import type { MoreMenuHandle, Workers } from '../ui/index.ts';
export type Open = (target: Target) => void;
// 项目小标签：看板上同时有不止一个项目的活时，才在卡片题目旁写，只有一个项目就不写（规则见 docs/ui-spec.md 第 14 节）。
export function ProjectTag({ name }: { name?: string }) {
  return name ? <Chip title={'项目：' + name}>{name}</Chip> : null;
}
// 看板的列名：和设置里的列颜色同一份。
export type ColumnName = keyof typeof defaultColumns;
// 列头任何宽度都不折行；列窄时先收“· 近 24 小时”，再把“全部历史 →”收成“历史 →”（docs/ui-spec.md 第 14 节，靠 layout.css 里的容器查询）。
// queued：进行中列里排队的件数，有才写“· N 排队”。
export function BoardColumn({
  name,
  title,
  count,
  queued = 0,
  children,
  color,
  history
}: {
  name: ColumnName;
  title: string;
  count: number;
  queued?: number;
  children: ReactNode;
  color?: string;
  history?: () => void;
}) {
  return <section className={'column c-' + name} style={color ? cssVars({
    '--hue': color
  }) : undefined}><div className="chead"><h2>{title}</h2><span className="n" data-testid={name} title={name === 'done' ? '近 24 小时' : undefined}>{count}</span>{queued > 0 && <span className="n" data-testid="queued">· {queued} 排队</span>}{name === 'done' && <span className="n range">· 近 24 小时</span>}{history && <button className="aside plain" onClick={history}><span className="long">全部</span>历史 →</button>}</div><div className="cbody">{children}</div></section>;
}
export const RunningCard = memo(function RunningCard({
  job,
  workers,
  typical,
  hue,
  group = false,
  project,
  open
}: {
  job: ViewJob;
  workers: Workers;
  typical: number | null;
  hue?: string;
  group?: boolean;
  project?: string;
  open: Open;
}) {
  const card = useRef<HTMLButtonElement>(null),
    progress = useRef<HTMLDivElement>(null),
    bar = useRef<HTMLElement>(null),
    label = useRef<HTMLSpanElement>(null);
  const last = job.activity.at(-1)?.at || job.started;
  // 较久没有新动作：进度条变琥珀色，不写字；悬停提示写事实。
  useEffect(() => subscribeTick(() => {
    const quiet = secondsSince(last) >= 600,
      age = awakeSince(job);
    progress.current?.classList.toggle('quiet', quiet);
    if (card.current) card.current.title = quiet ? `最近 ${Math.floor(secondsSince(last) / 60)} 分钟没有新动作` : '';
    if (typical && bar.current && label.current) {
      bar.current.style.width = `${Math.min(100, age / typical * 100)}%`;
      progress.current?.classList.toggle('over', age > typical);
      label.current.textContent = age > typical ? `比平时久 ${fmtDur(age - typical, true)}` : `大约还要 ${fmtDur(typical - age, true)}`;
    }
  }), [last, job, typical]);
  // 用时不含电脑休眠：把开始时间往后挪休眠那么久，计时器就少算了。
  const awake = useMemo(() => {
    const start = Date.parse(job.started);
    return { ...job, started: new Date(start + sleptSeconds(job.sleeps, start, Date.now()) * 1000).toISOString() };
  }, [job]);
  const doing = [...job.activity].reverse().find(a => a.kind !== 'say');
  const body = <>
    <WorkerRow job={job} workers={workers} detail="setting" end={<Elapsed job={awake} className="elapsed" />} />
    {!group && <div className="ctitle"><span className="ellip">{job.title}</span><ProjectTag name={project} /></div>}
    {typical && <div className="prog" ref={progress}><div className="track"><i ref={bar} /></div><div className="plabel"><span className="r" ref={label} /><span>通常 {fmtDur(typical, true)}</span></div></div>}
    <div className="doing"><span>正在</span><b>{doing ? human(doing).replace(/^在/, '') : '看题目'}</b></div>
  </>;
  const onClick = () => open({ kind: 'job', id: job.id });
  return group
    ? <MemberRow ref={card} marked={awaitingReply(job)} onClick={onClick} data-job={job.id}>{body}</MemberRow>
    : <Card ref={card} hue={hue} marked={awaitingReply(job)} onClick={onClick} data-job={job.id}>{body}</Card>;
});
export const QueuedCard = memo(function QueuedCard({
  job,
  workers,
  hue,
  project,
  open
}: {
  job: ViewJob;
  workers: Workers;
  hue?: string;
  project?: string;
  open: Open;
}) {
  return <Card compact hue={hue} marked={awaitingReply(job)} onClick={() => open({ kind: 'job', id: job.id })} data-job={job.id} data-queued="">
    <WorkerRow job={job} workers={workers} detail="setting" end={<Chip>排队</Chip>} />
    <div className="ctitle"><span className="ellip muted">{job.title}</span><ProjectTag name={project} /></div>
  </Card>;
});
type EntryProps = {
  entry: Entry;
  workers: Workers;
  hue?: string;
  project?: string;
  open: Open;
};
export function sameEntry(a: EntryProps, b: EntryProps) {
  return a.workers === b.workers && a.hue === b.hue && a.project === b.project && a.open === b.open && a.entry.title === b.entry.title && a.entry.type === b.entry.type && a.entry.target.kind === b.entry.target.kind && a.entry.target.id === b.entry.target.id && a.entry.members.length === b.entry.members.length && a.entry.members.every((j, i) => j === b.entry.members[i]);
}
// 一批的验收小结：没有一家通过只说做完了几家；有通过的写几家通过；全部通过写“都”。
export function checkSummary(members: ViewJob[]) {
  const n = members.length, passed = members.filter(m => m.check?.ok).length;
  return passed === n ? `${n} 家都做完了，都通过验收` : passed ? `${n} 家做完了，${passed} 家通过验收` : `${n} 家做完了`;
}
export const AttentionCard = memo(function AttentionCard({
  entry: e,
  workers,
  hue,
  project,
  open
}: EntryProps) {
  const j = e.members[0],
    decide = e.type === 'decide';
  const word = decide ? '负责人在挑' : e.type === 'lost' ? '中途断了' : e.type === 'check' ? '验收没过' : '出错了';
  const note = e.members.length > 1 ? checkSummary(e.members) : '';
  return <Card hue={hue} marked={e.members.some(awaitingReply)} onClick={() => open(e.target)}>
    <div className="crow"><Chip tone={decide || e.type === 'lost' ? 'neutral' : 'bad'}>{word}</Chip><span className="faint when">{fmtAgo(secondsSince(j.ended || j.started))}</span></div>
    <div className="ctitle"><span className="who ellip">{e.title}</span><ProjectTag name={project} /></div>
    {note && <div className="muted card-note">{note}</div>}
    <div className="lines">{e.members.map(m => <WorkerRow key={m.id} job={m} workers={workers} detail={decide ? 'full' : 'setting'} />)}</div>
    {!decide && <div className="faint card-note">{e.type === 'lost' ? '做到一半停了' : e.type === 'check' ? '有检查没通过' : '没能做完'}</div>}
    <div className="hint">负责人会处理，你也可以点开插手</div>
  </Card>;
}, sameEntry);
function outcome(m: ViewJob): ReactNode {
  if (m.decision?.by === 'owner' && !m.decision.handled || m.redo && !m.redo.handled) return <span className="faint when">等负责人处理</span>;
  if (m.decision?.kind === 'drop') return <span className="faint when">没用</span>;
  return m.state === 'stopped' ? <span className="faint when">已停</span> : null;
}
// 已完成列里一件活占一行：选手小图标、题目、用时，最右边是结果。一批就是这一批的几家小图标，结果写用了哪家。点这一行打开详情。
function DoneRow({ entry: e, workers, hue, open }: { entry: Entry; workers: Workers; hue?: string; open: Open }) {
  const single = e.members.length === 1 ? e.members[0] : null;
  const seconds = e.members.reduce<number | null>((max, m) => m.seconds == null ? max : Math.max(max ?? 0, m.seconds), null);
  // 正常的不写、只标例外：采用了什么都不挂（一批里没采用的那家图标调淡）；没用的整行调淡、写“没用”。
  const result = single ? outcome(single) : (() => { const o = outcomeOf(e); return o && (o.dropped ? <span className="faint when">{o.text}</span> : <Chip tone={o.tone}>{o.text}</Chip>); })();
  const dropped = e.members.every(m => m.decision?.kind === 'drop');
  return <MemberRow className={'done-row' + (dropped ? ' done-dropped' : '')} marked={e.members.some(awaitingReply)} onClick={() => open(e.target)} title={e.title}>
    <span className="done-icons">{hue && <span className="bdot" style={cssVars({ '--batch': hue })} />}{e.members.map(m => <span key={m.id} className={dimmed(e, m) ? 'icon-dim' : undefined}><WorkerIdentity job={m} workers={workers} size="sm" iconOnly /></span>)}</span>
    <span className="ellip done-title">{e.title}</span>
    {seconds != null && <span className="faint num done-time">{fmtDur(seconds, true)}</span>}
    {result != null && <span className="done-end">{result}</span>}
  </MemberRow>;
}
// 每个项目最多显示几件，其余在历史页看。
export const DONE_ROWS = 5;
function DoneHeader({ name, count, shut, body, toggle, onArchive }: {
  name: string; count: number; shut: boolean; body: string; toggle: () => void; onArchive?: () => void;
}) {
  const menu = useRef<MoreMenuHandle>(null);
  return <div className="bhead done-bar more-row" onContextMenu={e => {
    e.preventDefault(); e.stopPropagation(); menu.current?.openAt({ x: e.clientX, y: e.clientY });
  }}>
    <button type="button" className="done-head" aria-expanded={!shut} aria-controls={body} onClick={toggle} title={shut ? '展开' : '折叠'}>
      <span className="disclosure" aria-hidden="true" /><span className="t">{name}</span><span className="n">{count}</span>
    </button>
    {onArchive && <MoreMenu ref={menu} label={`更多操作：${name}`} items={[{
      label: '归档', onSelect: onArchive
    }]} />}
  </div>;
}
// 已完成列按项目聚合：一个项目一张卡，标题栏是项目名和近 24 小时的件数，里面一件一行（最近 5 件），
// 标题栏：左边折叠箭头、项目名、件数，右边“…”菜单；标题栏右键复用菜单（未归类不给）。
// 卡底“还有 N 件”和“这个项目的全部 →”（去历史页并选中这个项目）。
// 项目按各自最近完成的一件排。默认折起，只剩项目名和件数；点标题栏展开或折起，点开了哪些本机记住。
export function DoneList({ entries, workers, hue, label, open, showProject, onArchive }: {
  entries: Entry[];
  workers: Workers;
  hue: (e: Entry) => string | undefined;
  label: (project: string) => string;
  open: Open;
  showProject: (project: string) => void;
  onArchive: (project: string) => void;
}) {
  const [expanded, setExpanded] = useState(readExpanded), base = useId();
  const toggle = (name: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (!next.delete(name)) next.add(name);
    rememberExpanded(next); return next;
  });
  return <>{projectGroups(entries).map((g, i) => {
    const more = g.entries.length - DONE_ROWS, name = label(g.name), shut = !expanded.has(g.name), body = `${base}-${i}`;
    return <section key={g.name} aria-label={name}><BatchGroup head={<DoneHeader name={name} count={g.entries.length} shut={shut} body={body}
      toggle={() => toggle(g.name)} onArchive={g.name === NO_PROJECT ? undefined : () => onArchive(g.name)} />}>
      {!shut && <div id={body}>
        {g.entries.slice(0, DONE_ROWS).map(e => <DoneRow key={e.target.kind + e.target.id} entry={e} workers={workers} hue={hue(e)} open={open} />)}
        <div className="done-foot">{more > 0 && <span>还有 {more} 件</span>}<button type="button" className="plain" onClick={() => showProject(g.name)}>这个项目的全部 →</button></div>
      </div>}
    </BatchGroup></section>;
  })}</>;
}
