import { Fragment, useEffect, useId, useState } from 'react';
import type { View, ViewJob } from '../../../src/core/view-types.ts';
import type { Stat } from '../../../src/core/stats.ts';
import type { Profile } from '../../../src/core/profiles.ts';
import type { Entry } from '../lib/board.ts';
import { averageTimingLine, awaitingReply, decisionText, fmtDur, fmtTime, QUOTA_STALE_SECONDS, realState } from '../lib/board.ts';
import { dayGroups, dimmed, entryProject, outcomeOf, projectLabel, projectRows, recentLabel } from '../lib/history.ts';
import { dataTime, quotaLevel } from '../lib/quota.ts';
import { errorReason } from '../lib/errors.ts';
import { subscribeTick } from '../lib/ticker.ts';
import { Button, CheckChip, Chip, EmptyState, ReplyDot, SideNavLayout, WorkerIcon, WorkerIdentity, WorkerRow } from '../ui/index.ts';
import type { Workers } from '../ui/index.ts';
import type { Open } from './Board.tsx';
import { Dashboard } from './Dashboard.tsx';
// 展开后每家一行：选手身份（模型、强度、用时）、负责人写给主人的结论、打的分和评语、验收状态；点身份那一行打开这家的详情。
function HistoryMember({ job: j, workers, open }: { job: ViewJob; workers: Workers; open: Open }) {
  const r = j.rating, real = j.realCheck && realState(j.realCheck), note = j.decision?.note?.trim();
  // 正常的不写、只标例外：负责人采用了不挂标签，没用写淡色“没用”；主人自己点的决定照写。
  const verdict = j.decision?.by === 'owner' ? <Chip>{decisionText(j)}</Chip> : j.decision?.kind === 'drop' ? <span className="faint">没用</span> : null;
  return <div className="hmember">
    <button type="button" className="hopen plain" title="打开详情" onClick={() => open({ kind: 'job', id: j.id })}><WorkerRow job={j} workers={workers} detail="full" end={<>{verdict}{j.check && <CheckChip job={j} />}{real && <Chip tone={real.tone}>真实验收：{real.label}</Chip>}</>} /></button>{awaitingReply(j) && <ReplyDot />}
    {note && <p className="hnote">{note}</p>}
    <div className="hrate">{r && (r.score !== undefined || r.external) ? <>
      <div className="crow hrate-top">{r.score !== undefined ? <b className="hscore">{r.score} 分</b> : <span className="muted">没有打分</span>}{r.tags.map(t => <Chip key={t.tag} tone={t.kind === 'good' ? 'ok' : t.kind === 'bad' ? 'bad' : 'neutral'}>{t.tag}</Chip>)}</div>
      {r.good && <p><span className="muted">做得好的：</span>{r.good}</p>}{r.improve && <p><span className="muted">要改进的：</span>{r.improve}</p>}{r.external && <p><span className="muted">外部原因：</span>{r.external}</p>}
    </> : <span className="faint">还没打分</span>}</div>
  </div>;
}
function HistoryRow({
  entry: e,
  workers,
  project,
  open
}: {
  entry: Entry;
  workers: Workers;
  project?: string;
  open: Open;
}) {
  const [expanded, setExpanded] = useState(false),
    ms = e.members,
    outcome = outcomeOf(e),
    checked = ms.filter(m => m.check);
  return <div className="hrow"><button type="button" className="hsum" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><span className="date num">{fmtTime(e.started)}</span><span className="crow htitle"><Chip>{e.kind}</Chip><span className="ellip">{e.title}</span></span><span className="right">{project && <Chip title={'项目：' + project}>{project}</Chip>}<span className="crow">{ms.map(m => <span key={m.id} className={dimmed(e, m) ? 'icon-dim' : undefined}><WorkerIdentity job={m} workers={workers} size="sm" iconOnly /></span>)}</span>{checked.length > 0 && <span>合格 {checked.filter(m => m.check?.ok).length}/{checked.length}</span>}{outcome && (outcome.dropped ? <span className="faint">{outcome.text}</span> : <Chip tone={outcome.tone}>{outcome.text}</Chip>)}</span></button>
  {expanded && <div className="hmembers">{ms.map(j => <HistoryMember key={j.id} job={j} workers={workers} open={open} />)}{ms.length > 1 && <div className="hfoot"><button type="button" className="plain" onClick={() => open(e.target)}>打开这一批 →</button></div>}</div>}</div>;
}
export function History({
  view,
  rows,
  filter,
  setFilter,
  project,
  setProject,
  now,
  open,
  onUnarchive
}: {
  view: View;
  rows: Entry[];
  filter: string;
  setFilter: (s: string) => void;
  project: string;
  setProject: (name: string) => void;
  now: number;
  open: Open;
  onUnarchive: (name: string) => void;
}) {
  const archivedNames = new Set(view.projects.filter(p => p.archived).map(p => p.name));
  const projects = projectRows(view, rows),
    active = projects.filter(p => !archivedNames.has(p.name)),
    archived = projects.filter(p => archivedNames.has(p.name));
  // 记着的就是已归档项目时先展开，否则默认折起。折起后不跟着选中状态再打开。
  const [unfolded, setUnfolded] = useState(() => archived.some(p => p.name === project)), foldId = useId();
  const scope = project && projects.some(p => p.name === project) ? project : '',
    inScope = scope ? rows.filter(e => entryProject(e) === scope) : rows.filter(e => !archivedNames.has(entryProject(e))),
    kinds = ['全部', ...new Set(inScope.map(e => e.kind))],
    kind = kinds.includes(filter) ? filter : '全部',
    shown = kind === '全部' ? inScope : inScope.filter(e => e.kind === kind),
    current = projects.find(p => p.name === scope),
    pool = rows.filter(e => !archivedNames.has(entryProject(e))),
    last = pool.length ? pool.reduce((a, e) => Date.parse(e.started) > Date.parse(a) ? e.started : a, pool[0].started) : null;
  const items = [{ id: 'all', label: '全部', badge: pool.length, note: last ? recentLabel(last, now) : '还没有历史' },
    ...active.map(p => ({ id: 'p:' + p.name, label: p.label, badge: p.count, note: p.last ? recentLabel(p.last, now) : '还没有历史' }))];
  // 左栏最下面的“已归档”：像 macOS 侧栏的分区小标题（折叠箭头 + 淡色“已归档” + 件数），下面的行和普通项目行一模一样。
  // “取消归档”不放在行上（常驻容易误碰、还挤掉名字），放在选中这个项目后右栏顶上的提示里。
  const archivedSection = archived.length === 0 ? null : <div className="sidenav-archived">
    <button type="button" className="sidenav-fold" aria-label={`已归档 ${archived.length} 个项目`} aria-expanded={unfolded} aria-controls={foldId} onClick={() => setUnfolded(v => !v)}>
      <span className="disclosure" aria-hidden="true" /><span className="sidenav-fold-label">已归档</span><span className="sidenav-badge num">{archived.length}</span>
    </button>
    {unfolded && <div id={foldId} className="sidenav-archived-list">{archived.map(p =>
      <button key={p.name} type="button" className="sidenav-tab" aria-current={scope === p.name ? 'true' : undefined} onClick={() => setProject(p.name)}>
        <span className="sidenav-label">{p.label}</span><span className="sidenav-badge num">{p.count}</span><span className="sidenav-note">{p.last ? recentLabel(p.last, now) : '还没有历史'}</span>
      </button>)}</div>}
  </div>;
  const archivedNow = !!scope && archivedNames.has(scope);
  return <SideNavLayout className="history-layout" label="项目" items={items} value={scope ? 'p:' + scope : 'all'} onChange={id => setProject(id === 'all' ? '' : id.slice(2))} footer={archivedSection}>
    <div className="history"><h1>历史</h1><p className="sub">{current ? current.label : '全部项目'} · 共 {shown.length} 件。同一道题派给几家的算一件，点一行看各家的打分和评语。</p>
    {archivedNow && <div className="arch-note" role="note"><span>这个项目已归档：不在看板上显示，也不能派活。记录和打分都留着。</span><Button size="sm" onClick={() => onUnarchive(scope)}>取消归档</Button></div>}
    {kinds.length > 2 && <div className="filters">{kinds.map(k => <button key={k} type="button" className={k === kind ? 'on' : ''} aria-pressed={k === kind} onClick={() => setFilter(k)}>{k}</button>)}</div>}
    {shown.length ? dayGroups(shown, now).map(g => <section key={g.key} className="dayg"><h3 className="day">{g.label}</h3><div className="panel hgroup">{g.entries.map(e => <HistoryRow key={e.target.kind + e.target.id} entry={e} workers={view.workers} project={scope ? undefined : projectLabel(view, entryProject(e))} open={open} />)}</div></section>)
      : <EmptyState>{scope ? '这个项目还没有历史。' : '还没有历史。'}</EmptyState>}</div>
  </SideNavLayout>;
}
const COOLDOWN_MS = 60_000;
function QuotaCards({ view }: { view: View }) {
  const [now, setNow] = useState(Date.now),
    [busy, setBusy] = useState(false),
    [doneAt, setDoneAt] = useState(0),
    [error, setError] = useState('');
  useEffect(() => subscribeTick(() => setNow(Date.now())), []);
  const cooling = now - Math.max(doneAt, view.quotaAt ? Date.parse(view.quotaAt) : 0) < COOLDOWN_MS;
  const refresh = () => {
    setBusy(true);
    setError('');
    window.xa.refreshQuota().then(() => setDoneAt(Date.now())).catch(e => setError(errorReason(e))).finally(() => setBusy(false));
  };
  return <><div className="sec-head"><h3 className="sec">额度</h3><span className="sec-tools">{cooling && !busy && <span className="faint">刚刷新过</span>}<Button size="sm" disabled={busy || cooling} onClick={refresh}>{busy ? '正在刷新…' : '刷新'}</Button></span></div>{error && <p role="alert" className="muted">没能刷新：{error}</p>}<div className="quota-cards">{view.quota.map(q => {
      const old = q.at != null && (now - Date.parse(q.at)) / 1000 > QUOTA_STALE_SECONDS;
      return <div className="panel qcard" key={q.name}><div className="crow"><WorkerIcon name={q.icon} /><span className="who">{q.name}</span><span className="faint when">{q.plan}</span></div>{q.bars.map((b, i) => <div key={i}><div className="bar-top"><span>{b.label}</span>{b.used == null ? <span className="faint">查不到</span> : <b>{b.approx ? '不到 ' : ''}{b.used}%</b>}</div><div className="qtrack"><i className={quotaLevel(b.used, view.settings.limits?.quotaStop)} style={{
            width: `${Math.min(100, b.used || 0)}%`
          }} /></div>{b.reset && <div className="faint card-note">{fmtTime(b.reset, true)} 重置</div>}</div>)}<div className="crow card-note">{old ? <Chip tone="warn">{dataTime(q)}</Chip> : <span className="faint">{dataTime(q)}</span>}{q.failed && <Chip tone="bad" title="显示的是上一次查到的数据">这次没查到</Chip>}</div></div>;
    })}</div></>;
}
type Who = keyof Workers;
// 一格里的一块：同一选手、同一类活、同一版本（快速版分开）的统计和档案。
type Part = { fast: boolean; stat?: Stat; profile?: Profile };
const partKey = (who: Who, kind: string, fast: boolean) => JSON.stringify([who, kind, fast]);
const percent = (rate: number) => Math.round(rate * 100) + '%';
const REVIEWS_ID = 'profile-reviews';
function PartBody({ part: { stat: s, profile: p } }: { part: Part }) {
  const scored = p !== undefined && p.rated > 0 && p.avgScore !== null, average = p ? averageTimingLine(p) : null;
  return <>{s && <><div title={s.verified ? undefined : '还没有验收记录'}>{s.verified ? <><b>{s.passed}/{s.verified}</b><span className="muted"> 合格</span></> : <span className="muted">验收 —</span>}</div><div className="muted" title="只算做完了的活，不含电脑休眠的时间">平均 {s.averageSeconds === null ? '—' : fmtDur(s.averageSeconds, true)}</div>{s.adopted > 0 && <div className="muted">被采用 {s.adopted} 次</div>}</>}
  {average && <div className="muted" title="只算做完了、有每步记录的活">平均：{average}</div>}
  {scored ? <div className="pscore"><b title={`${p.rated} 件打了分的平均分`}>{p.avgScore!.toFixed(1)} 分</b>{p.reworkRate !== null && <span className="muted" title={`打了分的 ${p.rated} 件里，带“需要返工”的比例`}> · 返工 {percent(p.reworkRate)}</span>}</div> : <div className="muted">还没有打分</div>}
  {p && p.good.length + p.bad.length > 0 && <div className="ptags">{p.good.map(t => <Chip key={'good' + t.tag} tone="ok" title={`出现 ${t.n} 次`}>{t.tag}</Chip>)}{p.bad.map(t => <Chip key={'bad' + t.tag} tone="bad" title={`出现 ${t.n} 次`}>{t.tag}</Chip>)}</div>}</>;
}
function Reviews({ who, kind, profile, workers, id }: { who: Who; kind: string; profile: Profile; workers: Workers; id: string }) {
  const recent = [...profile.recent].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return <section className="reviews" id={id} aria-label="最近的评语"><div className="crow"><WorkerIdentity who={who} workers={workers} detail="model" size="sm" /><Chip>{kind}</Chip>{profile.fast && <Chip>快速版</Chip>}<span className="muted">最近的评语</span></div><ol>{recent.map(r => <li key={r.id}><div className="crow"><b className="rtitle">{r.title}</b>{r.score !== undefined && <Chip>{r.score} 分</Chip>}<span className="muted when">{fmtTime(r.at, true)}</span></div>{r.good && <p>做得好：{r.good}</p>}{r.improve && <p>要改进：{r.improve}</p>}</li>)}</ol></section>;
}
// 表格只显示核心算好的统计（view.stats）和档案（view.profiles）；规则见 docs/ui-spec.md 第 9、15 节。
export function Stats({
  view
}: {
  view: View;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const profiles = view.profiles ?? [],
    groups = [...view.stats, ...profiles],
    kinds = [...new Set(groups.map(s => s.kind))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    whos = (Object.keys(view.workers) as Who[]).filter(w => groups.some(s => s.who === w));
  const partsOf = (who: Who, kind: string): Part[] => [false, true].map(fast => ({
    fast,
    stat: view.stats.find(s => s.who === who && s.kind === kind && s.fast === fast),
    profile: profiles.find(p => p.who === who && p.kind === kind && p.fast === fast)
  })).filter(p => p.stat || p.profile);
  return <div className="page"><h1>表现</h1><p className="sub">这段时间做了多少、做得怎样、花了多少。token 是三家各自报的数，额度是各家套餐的百分点；不到 3 件的淡显，还不能下结论。</p><Dashboard view={view} /><QuotaCards view={view} /><h3 className="sec">选手 × 活的类型</h3><p className="muted dash-note">全部时间的积累；点一格看最近的评语。</p><div className="panel scroll-x"><table><thead><tr><th>选手</th>{kinds.map(k => <th key={k}>{k}</th>)}</tr></thead><tbody>{whos.map(w => {
            const open = kinds.flatMap(k => partsOf(w, k).map(part => ({ kind: k, part }))).find(({ kind, part }) => partKey(w, kind, part.fast) === opened);
            return <Fragment key={w}><tr><th><WorkerIdentity who={w} workers={view.workers} detail="model" /></th>{kinds.map(k => {
              const parts = partsOf(w, k);
              return <td key={k} className="stat">{parts.length ? parts.map(part => {
                const key = partKey(w, k, part.fast),
                  thin = (part.stat ? part.stat.small : true) || part.profile !== undefined && part.profile.rated > 0 && part.profile.small,
                  className = 'pcell' + (thin ? ' thin' : ''),
                  body = <>{parts.length > 1 || part.fast ? <div className="faint">{part.fast ? '快速版' : '普通版'}</div> : null}<PartBody part={part} /></>;
                return part.profile?.recent.length ? <button key={key} type="button" className={className + (opened === key ? ' on' : '')} aria-expanded={opened === key} aria-controls={opened === key ? REVIEWS_ID : undefined} onClick={() => setOpened(opened === key ? null : key)}>{body}</button> : <div key={key} className={className}>{body}</div>;
              }) : '—'}</td>;
            })}</tr>{open?.part.profile && <tr className="reviews-row"><td colSpan={kinds.length + 1}><Reviews who={w} kind={open.kind} profile={open.part.profile} workers={view.workers} id={REVIEWS_ID} /></td></tr>}</Fragment>;
          })}</tbody></table></div></div>;
}
