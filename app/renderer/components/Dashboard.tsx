import { useState } from 'react';
import type { View } from '../../../src/core/view-types.ts';
import type { Range } from '../../../src/core/dashboard.ts';
import { fmtDur } from '../lib/board.ts';
import { projectLabel } from '../lib/history.ts';
import { dayLabel, pct, pickSlice, points, projectChoices, RANGE_CHOICES, readDashProject, readRange, rememberDashProject, rememberRange, score, tokenText } from '../lib/dashboard.ts';
import { EmptyState, Segmented, StatTile, WorkerIdentity } from '../ui/index.ts';

// 表现页上半部分：筛选一行 → 大数一排（做完、token 带每天的小趋势线）→ 额度花费 → 各家对比 → 按项目（docs/ui-spec.md 第 15 节）。数都来自 View.dashboard，这里只挑一份来画。
export function Dashboard({ view }: { view: View }) {
  const [range, setRange] = useState<Range>(readRange), [project, setProject] = useState(readDashProject);
  const choices = projectChoices(view, range, project);
  const slice = pickSlice(view, range, choices.includes(project) ? project : '');
  const chooseRange = (r: Range) => { setRange(r); rememberRange(r); };
  const chooseProject = (p: string) => { setProject(p); rememberDashProject(p); };
  const filters = <div className="dash-filters">
    <Segmented label="时间范围" items={RANGE_CHOICES.map(r => ({ id: r.id, label: r.label }))} value={range} onChange={id => chooseRange(id as Range)} />
    {choices.length > 1 || project ? <div className="filters dash-projects" role="group" aria-label="项目">
      {['', ...choices].map(p => <button key={p || '全部'} type="button" className={p === (slice?.project ?? '') ? 'on' : ''} aria-pressed={p === (slice?.project ?? '')} onClick={() => chooseProject(p)}>{p ? projectLabel(view, p) : '全部项目'}</button>)}
    </div> : null}
  </div>;
  if (!slice || slice.kpi.jobs === 0) return <>{filters}<EmptyState>这段时间没有结束的活。</EmptyState></>;
  const { kpi } = slice;
  // 每天的走势收进大数小卡底部的小趋势线（选“今天”只有一个点，不画）。
  const labels = slice.daily.map(d => dayLabel(d.day)), span = RANGE_CHOICES.find(r => r.id === range)!.label;
  const jobsTrend = { values: slice.daily.map(d => d.jobs), labels, format: (n: number) => String(n), unit: ' 件', label: `${span}每天结束的件数` };
  const tokenTrend = { values: slice.daily.map(d => d.tokens.fresh), labels, format: tokenText, unit: '', label: `${span}每天的新读入 token` };
  const tokenSub = [`写出 ${tokenText(kpi.tokens.out)}`, `缓存命中 ${tokenText(kpi.tokens.cached)}`, kpi.withoutUsage ? `${kpi.withoutUsage} 件没有记录` : ''].filter(Boolean).join(' · ');
  return <>
    {filters}
    <div className="stat-row">
      <StatTile label="做完" value={<>{kpi.done}<small> 件</small></>} sub={kpi.failed ? `另有 ${kpi.failed} 件出错或中断` : `共 ${kpi.jobs} 件，没有出错`} trend={jobsTrend} />
      <StatTile label="采用率" value={pct(kpi.adoptRate)} sub="拍了板的活里用上的" />
      <StatTile label="平均分" value={score(kpi.avgScore)} sub="负责人打的分，满分 5" />
      <StatTile label="总用时" value={fmtDur(kpi.seconds, true)} sub="做完的活，扣掉电脑休眠" />
      <StatTile label="新读入 token" value={tokenText(kpi.tokens.fresh)} sub={tokenSub} title="读入里去掉缓存命中的部分；缓存命中又快又省" trend={tokenTrend} />
    </div>
    {kpi.pools.length > 0 && <div className="pool-strip" role="group" aria-label="额度花费">
      <span className="pool-strip-label">额度花费</span>
      {kpi.pools.map(p => <span key={p.pool} className="pool-item">{p.pool}<b className="num">{points(p.points)}</b></span>)}
      <span className="pool-strip-note">各家套餐的百分点；同时有别的活在跑时按用量分摊</span>
    </div>}

    <h3 className="sec">各家对比</h3>
    <div className="panel scroll-x"><table className="dash-table">
      <thead><tr><th>选手</th><th className="n">件数</th><th className="n">采用率</th><th className="n">平均分</th><th className="n">返工</th>
        <th className="n" title="做完的活，扣掉休眠，取中间值">每件用时</th><th className="n" title="取中间值，免得被一两件特别大的带偏">每件新读入</th><th className="n">每件写出</th><th className="n" title="按用量分摊后取平均：各家额度多按整数跳，一件小活常常是 0，平均才看得出">每件额度</th></tr></thead>
      <tbody>{slice.workers.map(w => <tr key={w.who} className={w.jobs < 3 ? 'thin' : undefined} title={w.jobs < 3 ? '不到 3 件，还不能下结论' : undefined}>
        <th><WorkerIdentity who={w.who} workers={view.workers} detail="model" /></th>
        <td className="n num">{w.jobs}</td><td className="n num">{pct(w.adoptRate)}</td><td className="n num">{score(w.avgScore)}</td><td className="n num">{pct(w.reworkRate)}</td>
        <td className="n num">{w.medianSeconds === null ? '—' : fmtDur(w.medianSeconds, true)}</td>
        <td className="n num">{w.medianTokens ? tokenText(w.medianTokens.fresh) : '—'}</td><td className="n num">{w.medianTokens ? tokenText(w.medianTokens.out) : '—'}</td>
        <td className="n num">{points(w.avgPoints)}</td>
      </tr>)}</tbody>
    </table></div>

    {slice.projects.length > 1 && <>
      <h3 className="sec">按项目</h3>
      <div className="panel scroll-x"><table className="dash-table">
        <thead><tr><th>项目</th><th className="n">件数</th><th className="n" title="做完的活，扣掉电脑休眠">用时</th><th className="n">新读入</th><th className="n">写出</th></tr></thead>
        <tbody>{slice.projects.map(p => <tr key={p.name}><th>{projectLabel(view, p.name)}</th><td className="n num">{p.jobs}</td><td className="n num">{fmtDur(p.seconds, true)}</td>
          <td className="n num">{tokenText(p.tokens.fresh)}</td><td className="n num">{tokenText(p.tokens.out)}</td></tr>)}</tbody>
      </table></div>
    </>}
  </>;
}
